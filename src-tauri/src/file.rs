//! Transcribes a recorded audio or video file (voice memos, downloads, …) on this PC.
//!
//! The audio is fed to Whisper in chunks of `MIN_CHUNK`–`MAX_CHUNK` seconds, each cut at the quietest
//! moment in that window so words aren't split and chunks stay under Whisper's 30-second window.
//! Every chunk becomes one transcript segment. Mirrors FileTranscriber.swift.

use crate::audio::{self, SpeechConverter, SPEECH_RATE};
use crate::whisper::{self, Options, Parameters, TimedWord};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use whisper_rs::WhisperContext;

const BLOCK: usize = SPEECH_RATE as usize / 4;
const MIN_CHUNK: f64 = 15.0;
const MAX_CHUNK: f64 = 28.0;

/// One recognized chunk of the file. Times are seconds from the beginning of the file.
#[derive(Serialize, Clone)]
pub struct Passage {
    pub start: f64,
    pub text: String,
    pub words: Vec<TimedWord>,
}

/// Details the Final Cut Pro export needs about a file.
#[derive(Serialize)]
pub struct AudioInfo {
    pub duration: f64,
    pub channels: u32,
    pub sample_rate: u32,
}

fn open(path: &Path) -> Result<Box<dyn FormatReader>, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let unreadable = || format!("“{name}” doesn't contain audio Transcriber can read.");
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(extension);
    }
    symphonia::default::get_probe()
        .probe(&hint, stream, FormatOptions::default(), MetadataOptions::default())
        .map_err(|_| unreadable())
}

pub fn audio_info(path: &Path) -> Result<AudioInfo, String> {
    let format = open(path)?;
    let track = format.default_track(TrackType::Audio).ok_or("No audio track.")?;
    let params = track.codec_params.as_ref().and_then(|p| p.audio()).ok_or("No audio track.")?;
    let sample_rate = params.sample_rate.unwrap_or(48_000);
    let channels = params.channels.as_ref().map(|c| c.count() as u32).unwrap_or(2);
    let duration = track.num_frames.map(|f| f as f64 / sample_rate as f64).unwrap_or(0.0);
    Ok(AudioInfo { duration, channels, sample_rate })
}

/// Decodes `path` and recognizes it chunk by chunk.
/// `on_progress` gets 0...1 (or None if the length is unknown); `on_passage` gets each recognized chunk.
pub fn transcribe(path: &Path, context: &WhisperContext, language: Option<&str>, parameters: &Parameters,
                  swiss_spelling: bool, word_timestamps: bool, cancelled: Arc<AtomicBool>,
                  mut on_progress: impl FnMut(Option<f64>), mut on_passage: impl FnMut(Passage)) -> Result<(), String> {
    let mut format = open(path)?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let unreadable = format!("“{name}” doesn't contain audio Transcriber can read.");
    let track = format.default_track(TrackType::Audio).ok_or(unreadable.clone())?;
    let track_id = track.id;
    let total_frames = track.num_frames;
    let params = track.codec_params.as_ref().and_then(|p| p.audio()).ok_or(unreadable.clone())?.clone();
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .map_err(|_| unreadable.clone())?;

    let stop = cancelled.clone();
    let options = Options {
        language, parameters, swiss_spelling, word_timestamps, preview: false,
        should_stop: Some(Arc::new(move || stop.load(Ordering::SeqCst))),
    };
    let mut converter: Option<SpeechConverter> = None;
    let mut interleaved: Vec<f32> = Vec::new();
    let mut pending: Vec<f32> = Vec::new();
    // Blocks of 0.25 s waiting to be recognized.
    let mut blocks: Vec<Vec<f32>> = Vec::new();
    let mut chunk_start = 0.0;
    let mut decoded_frames: u64 = 0;
    let mut succeeded = 0;
    let mut last_error: Option<String> = None;

    let mut recognize = |chunk: Vec<Vec<f32>>, chunk_start: &mut f64| -> Result<(), String> {
        let samples: Vec<f32> = chunk.concat();
        match whisper::transcribe(context, &samples, &options) {
            Ok(Some(result)) => {
                let words: Vec<TimedWord> = result.words.into_iter()
                    .map(|w| TimedWord { text: w.text, start: *chunk_start + w.start, end: *chunk_start + w.end })
                    .collect();
                let start = words.first().map(|w| w.start).unwrap_or(*chunk_start);
                on_passage(Passage { start, text: result.text, words });
                succeeded += 1;
            }
            Ok(None) => succeeded += 1,
            Err(e) => last_error = Some(e),
        }
        if cancelled.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        *chunk_start += samples.len() as f64 / SPEECH_RATE as f64;
        Ok(())
    };

    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(_) => break,
        };
        if packet.track_id != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => continue,
            Err(e) => return Err(e.to_string()),
        };
        let rate = decoded.spec().rate();
        let channels = decoded.spec().channels().count().max(1);
        let converter = converter.get_or_insert_with(|| SpeechConverter::new(rate, channels as u16));
        interleaved.resize(decoded.samples_interleaved(), 0.0);
        decoded.copy_to_slice_interleaved(&mut interleaved);
        decoded_frames += decoded.frames() as u64;
        pending.extend(converter.convert(&interleaved));
        while pending.len() >= BLOCK {
            blocks.push(pending.drain(..BLOCK).collect());
        }

        if blocks.len() as f64 * 0.25 >= MAX_CHUNK {
            let cut = quietest_cut(&blocks);
            let rest = blocks.split_off(cut + 1);
            let chunk = std::mem::replace(&mut blocks, rest);
            recognize(chunk, &mut chunk_start)?;
            on_progress(total_frames.map(|total| (decoded_frames as f64 / total.max(1) as f64).min(1.0)));
        }
    }
    if !pending.is_empty() {
        blocks.push(std::mem::take(&mut pending));
    }
    if !blocks.is_empty() {
        recognize(blocks, &mut chunk_start)?;
    }
    on_progress(Some(1.0));
    // A single unreadable chunk is skipped, but if nothing worked at all, say why.
    if succeeded == 0 {
        if let Some(error) = last_error {
            return Err(error);
        }
    }
    Ok(())
}

/// Index of the quietest block that still leaves the chunk at least `MIN_CHUNK` long.
fn quietest_cut(blocks: &[Vec<f32>]) -> usize {
    let mut best = blocks.len() - 1;
    let mut best_level = f32::MAX;
    for (index, block) in blocks.iter().enumerate() {
        if (index + 1) as f64 * 0.25 < MIN_CHUNK {
            continue;
        }
        let level = audio::rms(block);
        if level < best_level {
            best_level = level;
            best = index;
        }
    }
    best
}
