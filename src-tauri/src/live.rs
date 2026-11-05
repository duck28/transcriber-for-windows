//! Live transcription with Whisper, which recognizes whole stretches of audio rather than a stream.
//!
//! While someone talks, the audio of the current phrase is recognized over and over and shown as a preview.
//! When they pause for `pause_interval` (or the phrase reaches `max_phrase_duration`), the phrase is
//! emitted as final text, reusing the last preview if it already covered all of the speech.
//! Mirrors WhisperLiveTranscriber.swift.

use crate::audio::{self, AudioRecorder, Capture, SPEECH_RATE};
use crate::whisper::{self, Options, Parameters};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use whisper_rs::WhisperContext;

/// When a phrase gets too long, it's cut at the quietest moment of its last few seconds.
const CUT_WINDOW: f64 = 4.0;
const PREVIEW_STEP: f64 = 1.0;
const RATE: f64 = SPEECH_RATE as f64;
/// How often the level meter is updated.
const METER_INTERVAL: Duration = Duration::from_millis(50);

/// Audio of the current phrase, written by the capture thread.
#[derive(Default)]
struct Phrase {
    samples: Vec<f32>,
    /// Where each appended block ends in `samples`, and how loud it was.
    blocks: Vec<(usize, f32)>,
    silent_samples: usize,
    heard_speech: bool,
    /// The loudest level since the meter was last updated.
    peak: f32,
}

impl Phrase {
    /// Removes recognized audio from the front of the phrase.
    fn drop_first(&mut self, count: usize) {
        if count == 0 {
            return;
        }
        self.samples.drain(..count);
        self.blocks = self.blocks.iter().filter(|b| b.0 > count).map(|b| (b.0 - count, b.1)).collect();
    }

    fn pause_detected(&self, parameters: &Parameters) -> bool {
        self.heard_speech && self.silent_samples as f64 / RATE >= parameters.pause_interval
    }

    fn too_long(&self, parameters: &Parameters) -> bool {
        self.samples.len() as f64 / RATE >= parameters.max_phrase_duration
    }
}

pub struct LiveSession {
    capture: Option<Capture>,
    recorder: Arc<Mutex<Option<AudioRecorder>>>,
    stopping: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    meter: Option<JoinHandle<()>>,
}

impl LiveSession {
    pub fn start(app: AppHandle, context: Arc<WhisperContext>, source: &str, language: Option<String>,
                 parameters: Parameters, swiss_spelling: bool,
                 record_path: Option<std::path::PathBuf>) -> Result<LiveSession, String> {
        let parameters = Arc::new(parameters);
        let speech_level = parameters.speech_level;
        let phrase = Arc::new(Mutex::new(Phrase::default()));
        let recorder = Arc::new(Mutex::new(record_path.map(AudioRecorder::new)));
        let stopping = Arc::new(AtomicBool::new(false));

        let capture_phrase = phrase.clone();
        let capture_recorder = recorder.clone();
        let capture = Capture::start(source, Box::new(move |speech, raw, rate, channels| {
            if let Some(recorder) = capture_recorder.lock().unwrap().as_ref() {
                recorder.append(raw, rate, channels);
            }
            let level = audio::rms(speech);
            let mut p = capture_phrase.lock().unwrap();
            p.peak = p.peak.max(level);
            if level >= speech_level {
                p.heard_speech = true;
                p.silent_samples = 0;
            } else {
                p.silent_samples += speech.len();
            }
            p.samples.extend_from_slice(speech);
            let end = p.samples.len();
            p.blocks.push((end, level));
            if !p.heard_speech && p.samples.len() > SPEECH_RATE as usize {
                // Nothing said yet: keep only the last half second, so the first word isn't clipped.
                let excess = p.samples.len() - SPEECH_RATE as usize / 2;
                p.drop_first(excess);
            }
        }))?;

        // The meter runs on its own thread, so it keeps moving while the worker is busy recognizing.
        let meter_app = app.clone();
        let meter_phrase = phrase.clone();
        let meter_stopping = stopping.clone();
        let meter = std::thread::spawn(move || {
            while !meter_stopping.load(Ordering::SeqCst) {
                let peak = std::mem::take(&mut meter_phrase.lock().unwrap().peak);
                let _ = meter_app.emit("live-level", peak);
                std::thread::sleep(METER_INTERVAL);
            }
        });

        let worker_stopping = stopping.clone();
        let worker = std::thread::spawn(move || {
            Worker { app, context, phrase, language, parameters, swiss_spelling, stopping: worker_stopping,
                     finished: VecDeque::new(), preview: None, phrase_number: 0 }.run();
        });
        Ok(LiveSession { capture: Some(capture), recorder, stopping, worker: Some(worker), meter: Some(meter) })
    }

    /// Stops listening, recognizes what's left, and returns once the last text has been emitted.
    /// Returns an error message if the audio couldn't be saved.
    pub fn stop(mut self) -> Option<String> {
        if let Some(mut capture) = self.capture.take() {
            capture.stop();
        }
        let recorder_error = self.recorder.lock().unwrap().take().and_then(|mut r| r.finish());
        self.stopping.store(true, Ordering::SeqCst);
        if let Some(meter) = self.meter.take() {
            let _ = meter.join();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        recorder_error
    }
}

struct Worker {
    app: AppHandle,
    context: Arc<WhisperContext>,
    phrase: Arc<Mutex<Phrase>>,
    language: Option<String>,
    parameters: Arc<Parameters>,
    swiss_spelling: bool,
    stopping: Arc<AtomicBool>,
    /// Phrases waiting to be recognized.
    finished: VecDeque<Vec<f32>>,
    /// The newest preview of the current phrase: which phrase, how many samples it covered and what it said.
    preview: Option<(usize, usize, Option<String>)>,
    /// Counts phrases, so a preview of a phrase that has since been cut is recognized as stale.
    phrase_number: usize,
}

impl Worker {
    fn run(mut self) {
        loop {
            if self.stopping.load(Ordering::SeqCst) {
                self.cut_phrase(None);
                while let Some(audio) = self.finished.pop_front() {
                    self.recognize_final(audio);
                }
                let _ = self.app.emit("live-partial", "");
                return;
            }

            let (pause, too_long) = {
                let p = self.phrase.lock().unwrap();
                (p.pause_detected(&self.parameters), p.too_long(&self.parameters))
            };
            if pause {
                self.cut_phrase(None);
            } else if too_long {
                let cut = self.quietest_cut();
                self.cut_phrase(Some(cut));
            }

            if let Some(audio) = self.finished.pop_front() {
                self.recognize_final(audio);
                continue;
            }
            if !self.refresh_preview() {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }

    /// Where to split an overlong phrase: after the quietest block of its last `CUT_WINDOW` seconds.
    fn quietest_cut(&self) -> usize {
        let p = self.phrase.lock().unwrap();
        let earliest = p.samples.len().saturating_sub((CUT_WINDOW * RATE) as usize);
        p.blocks.iter().filter(|b| b.0 >= earliest)
            .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|b| b.0)
            .unwrap_or(p.samples.len())
    }

    /// Ends the current phrase after `cut` samples (all of them if None); the rest starts the next phrase.
    fn cut_phrase(&mut self, cut: Option<usize>) {
        let (audio, speech_end) = {
            let mut p = self.phrase.lock().unwrap();
            let end = cut.unwrap_or(p.samples.len()).min(p.samples.len());
            let audio = if p.heard_speech { Some(p.samples[..end].to_vec()) } else { None };
            let speech_end = if cut.is_none() { p.samples.len() - p.silent_samples.min(p.samples.len()) } else { end };
            p.drop_first(end);
            if p.samples.is_empty() {
                p.heard_speech = false;
                p.silent_samples = 0;
            } else {
                p.silent_samples = p.silent_samples.min(p.samples.len());
            }
            (audio, speech_end)
        };
        let preview = self.preview.take();
        let current = self.phrase_number;
        self.phrase_number += 1;
        let _ = self.app.emit("live-partial", "");
        let Some(audio) = audio else { return };
        match preview {
            // The preview already heard everything that was said; no need to recognize it again.
            // (Not for a split phrase: the preview may contain words from the part that goes on.)
            Some((number, length, text)) if cut.is_none() && number == current && length >= speech_end => {
                if let Some(text) = text {
                    let _ = self.app.emit("live-final", text);
                }
            }
            _ => self.finished.push_back(audio),
        }
    }

    fn options(&self, preview: bool, should_stop: Option<Arc<dyn Fn() -> bool + Send + Sync>>) -> Options<'_> {
        Options { language: self.language.as_deref(), parameters: &self.parameters, swiss_spelling: self.swiss_spelling,
                  word_timestamps: false, preview, should_stop }
    }

    fn recognize_final(&mut self, audio: Vec<f32>) {
        if let Ok(Some(result)) = whisper::transcribe(&self.context, &audio, &self.options(false, None)) {
            let _ = self.app.emit("live-final", result.text);
        }
    }

    /// Recognizes the current phrase again if enough new audio arrived. Returns whether it did any work.
    fn refresh_preview(&mut self) -> bool {
        let audio = {
            let p = self.phrase.lock().unwrap();
            if !p.heard_speech { return false; }
            p.samples.clone()
        };
        let previewed = self.preview.as_ref().map(|p| p.1).unwrap_or(0);
        if audio.is_empty() || (audio.len().saturating_sub(previewed)) as f64 / RATE < PREVIEW_STEP {
            return false;
        }
        // Stop decoding as soon as the phrase is over: its final text is what matters then.
        let phrase = self.phrase.clone();
        let stopping = self.stopping.clone();
        let parameters = self.parameters.clone();
        let aborted = Arc::new(AtomicBool::new(false));
        let flag = aborted.clone();
        let should_stop: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
            let p = phrase.lock().unwrap();
            let stop = stopping.load(Ordering::SeqCst) || p.pause_detected(&parameters) || p.too_long(&parameters);
            if stop { flag.store(true, Ordering::SeqCst); }
            stop
        });
        let result = whisper::transcribe(&self.context, &audio, &self.options(true, Some(should_stop)));
        if aborted.load(Ordering::SeqCst) {
            return true;
        }
        let text = result.ok().flatten().map(|r| r.text);
        if let Some(text) = &text {
            let _ = self.app.emit("live-partial", text);
        }
        self.preview = Some((self.phrase_number, audio.len(), text));
        true
    }
}
