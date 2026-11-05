//! Audio capture: everything the PC plays (WASAPI loopback) or an input device, converted to the
//! 16 kHz mono float samples Whisper expects. Mirrors AudioInput.swift and SystemAudioCapture.swift.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::sync::mpsc;
use std::thread::JoinHandle;

pub const SPEECH_RATE: u32 = 16_000;
pub const SYSTEM_AUDIO_SOURCE_ID: &str = "system";

/// A device with at least one input channel (built-in microphone, headset, USB interface, …).
#[derive(Serialize, Clone)]
pub struct AudioInputDevice {
    pub uid: String,
    pub name: String,
}

pub fn input_devices() -> Vec<AudioInputDevice> {
    let host = cpal::default_host();
    let Ok(devices) = host.input_devices() else { return Vec::new() };
    devices
        .filter_map(|device| {
            let uid = device.id().ok()?.to_string();
            let name = device.description().ok()?.name().to_string();
            Some(AudioInputDevice { uid, name })
        })
        .collect()
}

/// Called on the capture thread with 16 kHz mono samples and the raw interleaved input
/// (for saving the audio), plus the input's sample rate and channel count.
pub type OnAudio = Box<dyn FnMut(&[f32], &[f32], u32, u16) + Send + 'static>;

/// A running capture. Dropping it (or calling `stop`) ends the stream.
pub struct Capture {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl Capture {
    /// Starts capturing `source` (`SYSTEM_AUDIO_SOURCE_ID` or an input device's uid).
    pub fn start(source: &str, mut on_audio: OnAudio) -> Result<Capture, String> {
        let source = source.to_string();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        // The stream lives on its own thread, since WASAPI streams can't move between threads.
        let thread = std::thread::spawn(move || {
            let stream = (|| -> Result<cpal::Stream, String> {
                let host = cpal::default_host();
                let (device, config) = if source == SYSTEM_AUDIO_SOURCE_ID {
                    // An output device used as an input records what it plays (loopback).
                    let device = host.default_output_device().ok_or("No audio output device was found.")?;
                    let config = device.default_output_config().map_err(|e| e.to_string())?;
                    (device, config)
                } else {
                    let device = host
                        .input_devices()
                        .map_err(|e| e.to_string())?
                        .find(|d| d.id().map(|id| id.to_string() == source).unwrap_or(false))
                        .ok_or("The microphone is disconnected. Choose another source.")?;
                    let config = device.default_input_config().map_err(|e| e.to_string())?;
                    (device, config)
                };
                let rate = config.sample_rate();
                let channels = config.channels();
                let mut converter = SpeechConverter::new(rate, channels);
                let mut floats: Vec<f32> = Vec::new();
                let mut emit = move |interleaved: &[f32]| {
                    let speech = converter.convert(interleaved);
                    on_audio(&speech, interleaved, rate, channels);
                };
                let error = |e: cpal::Error| eprintln!("audio stream error: {e}");
                let stream_config = config.config();
                let stream = match config.sample_format() {
                    cpal::SampleFormat::F32 => device.build_input_stream::<f32, _, _>(
                        stream_config, move |data, _| emit(data), error, None),
                    cpal::SampleFormat::I16 => device.build_input_stream::<i16, _, _>(
                        stream_config,
                        move |data, _| {
                            floats.clear();
                            floats.extend(data.iter().map(|s| *s as f32 / 32768.0));
                            emit(&floats);
                        },
                        error, None),
                    cpal::SampleFormat::I32 => device.build_input_stream::<i32, _, _>(
                        stream_config,
                        move |data, _| {
                            floats.clear();
                            floats.extend(data.iter().map(|s| *s as f32 / 2_147_483_648.0));
                            emit(&floats);
                        },
                        error, None),
                    other => return Err(format!("Unsupported audio format: {other:?}")),
                }
                .map_err(|e| e.to_string())?;
                stream.play().map_err(|e| e.to_string())?;
                Ok(stream)
            })();
            match stream {
                Ok(stream) => {
                    let _ = ready_tx.send(Ok(()));
                    let _ = stop_rx.recv();
                    drop(stream);
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                }
            }
        });

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Capture { stop: Some(stop_tx), thread: Some(thread) }),
            Ok(Err(error)) => Err(error),
            Err(_) => Err("The audio device couldn't be opened.".into()),
        }
    }

    pub fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Converts interleaved audio of any rate and channel count to 16 kHz mono (downmix, low-pass, resample).
/// Keeps state between calls, so feed one instance consecutive buffers of a single stream.
pub struct SpeechConverter {
    channels: usize,
    /// Input samples per output sample.
    step: f64,
    /// Box filter against aliasing when downsampling.
    window: Vec<f32>,
    window_sum: f32,
    window_index: usize,
    /// Position of the next output sample, in input samples after `previous`.
    position: f64,
    previous: f32,
}

impl SpeechConverter {
    pub fn new(rate: u32, channels: u16) -> Self {
        let step = rate as f64 / SPEECH_RATE as f64;
        let taps = step.round().max(1.0) as usize;
        SpeechConverter {
            channels: channels.max(1) as usize,
            step,
            window: vec![0.0; taps],
            window_sum: 0.0,
            window_index: 0,
            position: 0.0,
            previous: 0.0,
        }
    }

    pub fn convert(&mut self, interleaved: &[f32]) -> Vec<f32> {
        let mut output = Vec::with_capacity((interleaved.len() as f64 / self.channels as f64 / self.step) as usize + 2);
        for frame in interleaved.chunks(self.channels) {
            let mono = frame.iter().sum::<f32>() / frame.len() as f32;
            // Moving average over `taps` samples.
            self.window_sum += mono - self.window[self.window_index];
            self.window[self.window_index] = mono;
            self.window_index = (self.window_index + 1) % self.window.len();
            let current = self.window_sum / self.window.len() as f32;
            // Linear interpolation between the previous and the current (filtered) sample.
            while self.position <= 1.0 {
                let t = self.position as f32;
                output.push(self.previous + (current - self.previous) * t);
                self.position += self.step;
            }
            self.position -= 1.0;
            self.previous = current;
        }
        output
    }
}

/// Root mean square of the samples.
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// Saves captured audio as a WAV file (16-bit, at most 2 channels). Writing happens on a background thread.
pub struct AudioRecorder {
    sender: Option<mpsc::Sender<(Vec<f32>, u32, u16)>>,
    thread: Option<JoinHandle<Option<String>>>,
}

impl AudioRecorder {
    pub fn new(path: std::path::PathBuf) -> Self {
        let (sender, receiver) = mpsc::channel::<(Vec<f32>, u32, u16)>();
        let thread = std::thread::spawn(move || {
            let mut writer: Option<(hound::WavWriter<std::io::BufWriter<std::fs::File>>, usize)> = None;
            for (samples, rate, channels) in receiver {
                if writer.is_none() {
                    let kept = channels.min(2);
                    let spec = hound::WavSpec {
                        channels: kept,
                        sample_rate: rate,
                        bits_per_sample: 16,
                        sample_format: hound::SampleFormat::Int,
                    };
                    match hound::WavWriter::create(&path, spec) {
                        Ok(w) => writer = Some((w, channels as usize)),
                        Err(e) => return Some(e.to_string()),
                    }
                }
                let (w, input_channels) = writer.as_mut().unwrap();
                let kept = (*input_channels).min(2);
                for frame in samples.chunks(*input_channels) {
                    for channel in 0..kept {
                        let value = if *input_channels > 2 && kept == 2 {
                            // Downmix extra channels into the stereo pair.
                            frame.iter().skip(channel).step_by(2).sum::<f32>() / (frame.len() as f32 / 2.0).max(1.0)
                        } else {
                            frame[channel.min(frame.len() - 1)]
                        };
                        if let Err(e) = w.write_sample((value.clamp(-1.0, 1.0) * 32767.0) as i16) {
                            return Some(e.to_string());
                        }
                    }
                }
            }
            if let Some((w, _)) = writer {
                if let Err(e) = w.finalize() {
                    return Some(e.to_string());
                }
            }
            None
        });
        AudioRecorder { sender: Some(sender), thread: Some(thread) }
    }

    pub fn append(&self, interleaved: &[f32], rate: u32, channels: u16) {
        if let Some(sender) = &self.sender {
            let _ = sender.send((interleaved.to_vec(), rate, channels));
        }
    }

    /// Writes the remaining audio and closes the file. Returns an error message if writing failed.
    pub fn finish(&mut self) -> Option<String> {
        self.sender.take();
        self.thread.take().and_then(|t| t.join().ok().flatten())
    }
}
