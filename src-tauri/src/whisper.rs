//! Runs Whisper (whisper.cpp) on this PC. The model is downloaded from Hugging Face once, then everything
//! happens offline. One model is kept loaded at a time and shared by live and file transcription.
//! Mirrors WhisperEngine.swift.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Where a model comes from: a Hugging Face repository and the model file in it.
#[derive(Deserialize, Serialize, Clone, PartialEq, Debug)]
pub struct ModelSource {
    pub repo: String,
    pub file: String,
}

/// A recognized word and when it was spoken, in seconds from the start of the samples.
#[derive(Serialize, Clone, Debug)]
pub struct TimedWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct Recognition {
    pub text: String,
    pub words: Vec<TimedWord>,
}

/// Decoding and live-phrase parameters, changeable under Settings › Expert Options.
/// The defaults are what the Mac app uses (WhisperKit's decoding defaults).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Parameters {
    /// 1 decodes greedily, like the Mac app; more searches that many candidates.
    pub beam_size: i32,
    pub temperature: f32,
    /// Added to the temperature for each retry when decoding fails (up to 1.0); 0 disables retries.
    pub temperature_increment: f32,
    /// Below this the text counts as repetitive and decoding is retried (WhisperKit's compression ratio threshold).
    pub entropy_threshold: f32,
    /// Below this average log probability decoding is retried.
    pub log_prob_threshold: f32,
    /// Segments more likely than this to be silence are dropped.
    pub no_speech_threshold: f32,
    pub suppress_blank: bool,
    /// Suppresses tokens that aren't speech, such as "[Music]".
    pub suppress_non_speech: bool,
    /// 0 picks automatically.
    pub threads: i32,
    /// Live previews skip retries and encode only the audio they need.
    pub fast_previews: bool,
    /// Live: seconds of silence that end a phrase.
    pub pause_interval: f64,
    /// Live: phrases longer than this many seconds are split.
    pub max_phrase_duration: f64,
    /// Live: below this level (RMS) audio counts as silence.
    pub speech_level: f32,
}

impl Default for Parameters {
    fn default() -> Self {
        Parameters {
            beam_size: 1,
            temperature: 0.0,
            temperature_increment: 0.2,
            entropy_threshold: 2.4,
            log_prob_threshold: -1.0,
            no_speech_threshold: 0.6,
            suppress_blank: false,
            suppress_non_speech: false,
            threads: 0,
            fast_previews: true,
            pause_interval: 0.6,
            max_phrase_duration: 15.0,
            speech_level: 0.006,
        }
    }
}

pub struct Options<'a> {
    /// Whisper's language code ("de"), or None to detect it.
    pub language: Option<&'a str>,
    pub parameters: &'a Parameters,
    /// Writes "ss" instead of "ß", as in Switzerland.
    pub swiss_spelling: bool,
    pub word_timestamps: bool,
    /// Quick, lower-effort decoding for live previews.
    pub preview: bool,
    /// Decoding ends early once this returns true.
    pub should_stop: Option<ShouldStop>,
}

#[derive(Default)]
pub struct Engine {
    loaded: Mutex<Option<(ModelSource, Arc<WhisperContext>)>>,
}

/// %APPDATA%\Transcriber\Whisper
pub fn models_folder() -> PathBuf {
    dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("Transcriber").join("Whisper")
}

/// Where the model is (or will be) stored.
pub fn local_path(source: &ModelSource) -> PathBuf {
    models_folder().join(source.repo.replace('/', "__")).join(&source.file)
}

pub fn is_downloaded(source: &ModelSource) -> bool {
    local_path(source).is_file()
}

impl Engine {
    pub fn is_loaded(&self, source: &ModelSource) -> bool {
        self.loaded.lock().unwrap().as_ref().map(|(s, _)| s == source).unwrap_or(false)
    }

    pub fn context(&self) -> Option<Arc<WhisperContext>> {
        self.loaded.lock().unwrap().as_ref().map(|(_, c)| c.clone())
    }

    /// Loads a downloaded model (blocking; run it off the main thread).
    pub fn load(&self, source: &ModelSource) -> Result<(), String> {
        if self.is_loaded(source) {
            return Ok(());
        }
        let path = local_path(source);
        let mut parameters = WhisperContextParameters::default();
        parameters.use_gpu(true);
        let context = WhisperContext::new_with_params(&path, parameters)
            .map_err(|e| format!("The Whisper model couldn't be loaded ({e}). Try downloading it again."))?;
        let context = Arc::new(context);
        // The first recognition after loading is slower; get it out of the way now.
        let _ = transcribe(&context, &vec![0.0; 16_000], &Options {
            language: Some("en"), parameters: &Parameters::default(), swiss_spelling: false, word_timestamps: false,
            preview: true, should_stop: None,
        });
        // Only one model stays in memory.
        *self.loaded.lock().unwrap() = Some((source.clone(), context));
        Ok(())
    }
}

/// Downloads the model file, reporting progress (0...1). Stops when `cancelled` becomes true.
pub async fn download(source: &ModelSource, cancelled: Arc<AtomicBool>,
                      progress: impl Fn(f64)) -> Result<(), String> {
    let target = local_path(source);
    if target.is_file() {
        return Ok(());
    }
    let folder = target.parent().unwrap().to_path_buf();
    tokio::fs::create_dir_all(&folder).await.map_err(|e| e.to_string())?;
    let url = format!("https://huggingface.co/{}/resolve/main/{}", source.repo, source.file);
    let response = reqwest::get(&url).await
        .map_err(|e| format!("The Whisper model couldn't be downloaded: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("The Whisper model couldn't be downloaded (HTTP {}). Check the model in Settings › Speech Recognition.",
                           response.status().as_u16()));
    }
    let total = response.content_length().unwrap_or(0);
    let partial = target.with_extension("part");
    let mut file = tokio::fs::File::create(&partial).await.map_err(|e| e.to_string())?;
    let mut received: u64 = 0;
    let mut stream = response.bytes_stream();
    let mut last_report = 0.0;
    while let Some(chunk) = stream.next().await {
        if cancelled.load(Ordering::SeqCst) {
            drop(file);
            let _ = tokio::fs::remove_file(&partial).await;
            return Err("cancelled".into());
        }
        let chunk = chunk.map_err(|e| format!("The download was interrupted: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if total > 0 {
            let fraction = received as f64 / total as f64;
            if fraction - last_report >= 0.005 {
                last_report = fraction;
                progress(fraction);
            }
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    tokio::fs::rename(&partial, &target).await.map_err(|e| e.to_string())?;
    progress(1.0);
    Ok(())
}

/// Recognizes 16 kHz mono samples. Returns None if they contain no speech.
pub fn transcribe(context: &WhisperContext, samples: &[f32], options: &Options) -> Result<Option<Recognition>, String> {
    let mut state = context.create_state().map_err(|e| e.to_string())?;
    let p = options.parameters;
    let strategy = if p.beam_size > 1 {
        SamplingStrategy::BeamSearch { beam_size: p.beam_size, patience: -1.0 }
    } else {
        SamplingStrategy::Greedy { best_of: 1 }
    };
    let mut params = FullParams::new(strategy);
    let threads = if p.threads > 0 {
        p.threads
    } else {
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8) as i32
    };
    params.set_n_threads(threads);
    params.set_language(options.language);
    params.set_detect_language(options.language.is_none());
    params.set_translate(false);
    params.set_no_context(true);
    params.set_temperature(p.temperature);
    params.set_temperature_inc(p.temperature_increment);
    params.set_entropy_thold(p.entropy_threshold);
    params.set_logprob_thold(p.log_prob_threshold);
    params.set_no_speech_thold(p.no_speech_threshold);
    params.set_suppress_blank(p.suppress_blank);
    params.set_suppress_nst(p.suppress_non_speech);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    if options.preview && p.fast_previews {
        // Previews are replaced moments later; skip the retries at higher temperatures.
        params.set_temperature_inc(0.0);
        params.set_no_timestamps(true);
        // Encode only as much of Whisper's 30-second window as the clip needs (1500 = 30 s), which makes
        // short previews several times faster. Final text always uses the full window.
        let audio_ctx = (samples.len() as f64 / 16_000.0 * 50.0).ceil() as i32 + 64;
        if audio_ctx < 1500 {
            params.set_audio_ctx(audio_ctx);
        }
    }
    if options.word_timestamps {
        // One segment per word, each with its own timing.
        params.set_token_timestamps(true);
        params.set_max_len(1);
        params.set_split_on_word(true);
    }
    // Not set_abort_callback_safe: in whisper-rs 0.16 it stores the closure as a boxed `dyn FnMut` but calls it
    // as the concrete closure type, which crashes the first time whisper.cpp checks it.
    // `should_stop` outlives `state.full` below, so pointing at it is safe.
    if let Some(stop) = &options.should_stop {
        unsafe {
            params.set_abort_callback(Some(abort_trampoline));
            params.set_abort_callback_user_data(stop as *const ShouldStop as *mut c_void);
        }
    }
    // whisper.cpp needs at least a second of audio.
    let mut audio = samples.to_vec();
    if audio.len() < 16_000 + 1600 {
        audio.resize(16_000 + 1600, 0.0);
    }
    state.full(params, &audio).map_err(|e| e.to_string())?;

    let clean = |text: &str| -> String {
        if options.swiss_spelling { text.replace('ß', "ss") } else { text.to_string() }
    };
    let mut pieces: Vec<String> = Vec::new();
    let mut words: Vec<TimedWord> = Vec::new();
    for segment in state.as_iter() {
        let Ok(text) = segment.to_str_lossy() else { continue };
        // Whisper invents text for silence and noise ("Untertitel im Auftrag des ZDF"); drop such segments.
        if segment.no_speech_probability() >= p.no_speech_threshold || is_hallucination(&text) {
            continue;
        }
        let text = clean(&text);
        if options.word_timestamps {
            let word = text.trim();
            if !word.is_empty() {
                words.push(TimedWord {
                    text: word.to_string(),
                    start: segment.start_timestamp() as f64 / 100.0,
                    end: segment.end_timestamp() as f64 / 100.0,
                });
            }
            pieces.push(text);
        } else {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                pieces.push(trimmed.to_string());
            }
        }
    }
    let text = if options.word_timestamps {
        pieces.concat().split_whitespace().collect::<Vec<_>>().join(" ")
    } else {
        pieces.join(" ")
    };
    if text.is_empty() || is_hallucination(&text) {
        return Ok(None);
    }
    Ok(Some(Recognition { text, words }))
}

pub type ShouldStop = Arc<dyn Fn() -> bool + Send + Sync>;

/// Called by whisper.cpp between computations with a pointer to `Options::should_stop`.
unsafe extern "C" fn abort_trampoline(user_data: *mut c_void) -> bool {
    let stop = unsafe { &*(user_data as *const ShouldStop) };
    // A panic must not unwind into C; stop decoding instead.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| stop())).unwrap_or(true)
}

/// Phrases Whisper is known to produce from silence, applause or music (learned from subtitled TV).
const HALLUCINATIONS: &[&str] = &[
    "untertitel im auftrag des zdf", "untertitel der amara.org-community", "untertitelung des zdf",
    "vielen dank fürs zuschauen", "danke fürs zuschauen", "copyright wdr", "swr 2020", "swr 2021",
    "thanks for watching", "thank you for watching", "subtitles by the amara.org community",
];

fn is_hallucination(text: &str) -> bool {
    let stripped = text.trim();
    // Sound descriptions such as "[Musik]", "(Applaus)" or "[BLANK_AUDIO]".
    let opens = ['[', '(', '*', '♪'];
    let closes = [']', ')', '*', '♪'];
    if stripped.chars().count() >= 2
        && opens.contains(&stripped.chars().next().unwrap())
        && closes.contains(&stripped.chars().last().unwrap())
    {
        return true;
    }
    let normalized = stripped.to_lowercase();
    let normalized = normalized.trim_matches(|c: char| c.is_ascii_punctuation() || c.is_whitespace());
    normalized.is_empty() || HALLUCINATIONS.iter().any(|h| normalized.starts_with(h))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_sound_descriptions_and_known_phrases() {
        assert!(is_hallucination(" [Musik]"));
        assert!(is_hallucination("(Applaus)"));
        assert!(is_hallucination("Untertitel im Auftrag des ZDF, 2021"));
        assert!(!is_hallucination("Grüezi mitenand."));
    }

    /// Needs the default model in %APPDATA%\Transcriber\Whisper: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn should_stop_is_called_without_crashing() {
        let source = ModelSource { repo: "ggerganov/whisper.cpp".into(), file: "ggml-large-v3-turbo-q5_0.bin".into() };
        let context = WhisperContext::new_with_params(&local_path(&source), WhisperContextParameters::default())
            .expect("model");
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = calls.clone();
        let should_stop: ShouldStop = Arc::new(move || counter.fetch_add(1, Ordering::SeqCst) > 1_000_000);
        let parameters = Parameters::default();
        let options = Options { language: Some("de"), parameters: &parameters, swiss_spelling: false,
                                word_timestamps: false, preview: true, should_stop: Some(should_stop) };
        transcribe(&context, &vec![0.0; 3 * 16_000], &options).expect("transcribe");
        assert!(calls.load(Ordering::SeqCst) > 0);

        // Returning true stops decoding early instead of crashing.
        let options = Options { should_stop: Some(Arc::new(|| true)), ..options };
        let _ = transcribe(&context, &vec![0.0; 3 * 16_000], &options);
    }
}
