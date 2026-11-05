//! Transcriber for Windows. The interface (src/) holds the app's state, like TranscriptionModel.swift
//! on the Mac; this backend captures audio, runs Whisper, talks to yt-dlp and writes files.

mod audio;
mod file;
mod library;
mod live;
mod whisper;
mod youtube;

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, State};

struct AppState {
    engine: Arc<whisper::Engine>,
    /// Serializes model loading, so a background preload and Start don't load the model twice.
    load_lock: Arc<tokio::sync::Mutex<()>>,
    live: Mutex<Option<live::LiveSession>>,
    /// Set by Cancel; checked by downloads, file transcription and yt-dlp.
    cancelled: Arc<AtomicBool>,
    /// Whether the transcript folder pane is open, and if so whether opening it widened the window.
    sidebar: Mutex<Option<bool>>,
}

type Result<T> = std::result::Result<T, String>;

// MARK: - Whisper

#[derive(serde::Serialize)]
struct WhisperStatus {
    downloaded: bool,
    loaded: bool,
}

#[tauri::command]
fn whisper_status(source: whisper::ModelSource, state: State<AppState>) -> WhisperStatus {
    WhisperStatus { downloaded: whisper::is_downloaded(&source), loaded: state.engine.is_loaded(&source) }
}

#[tauri::command]
fn models_folder() -> String {
    let folder = whisper::models_folder();
    let _ = std::fs::create_dir_all(&folder);
    folder.to_string_lossy().to_string()
}

/// Downloads (first time only) and loads the model. Emits `whisper-progress` with the download
/// progress (0...1), then null while the model is being loaded.
#[tauri::command]
async fn prepare_whisper(source: whisper::ModelSource, app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    if !whisper::is_downloaded(&source) {
        let progress_app = app.clone();
        whisper::download(&source, state.cancelled.clone(), move |p| {
            let _ = progress_app.emit("whisper-progress", Some(p));
        }).await?;
    }
    let _ = app.emit("whisper-progress", None::<f64>);
    load(&state, source).await
}

/// Loads an already downloaded model in the background, so Start doesn't have to wait for it.
#[tauri::command]
async fn preload_whisper(source: whisper::ModelSource, state: State<'_, AppState>) -> Result<()> {
    if !whisper::is_downloaded(&source) {
        return Ok(());
    }
    load(&state, source).await
}

async fn load(state: &AppState, source: whisper::ModelSource) -> Result<()> {
    let _guard = state.load_lock.lock().await;
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || engine.load(&source)).await.map_err(|e| e.to_string())?
}

// MARK: - Live transcription

#[tauri::command]
fn list_input_devices() -> Vec<audio::AudioInputDevice> {
    audio::input_devices()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveOptions {
    source: String,
    language: Option<String>,
    #[serde(default)]
    parameters: whisper::Parameters,
    swiss_spelling: bool,
    record_path: Option<String>,
}

/// Emits `live-partial` (preview text), `live-final` (finished phrases) and `live-level` (RMS).
#[tauri::command]
fn start_live(options: LiveOptions, app: AppHandle, state: State<AppState>) -> Result<()> {
    let context = state.engine.context().ok_or("Choose a Whisper model in Settings › Speech Recognition.")?;
    let session = live::LiveSession::start(app, context, &options.source, options.language, options.parameters,
                                           options.swiss_spelling, options.record_path.map(PathBuf::from))?;
    *state.live.lock().unwrap() = Some(session);
    Ok(())
}

/// Stops listening; resolves once the last phrase has been emitted. Returns an error message if the
/// audio couldn't be saved.
#[tauri::command]
async fn stop_live(state: State<'_, AppState>) -> Result<Option<String>> {
    let session = state.live.lock().unwrap().take();
    let Some(session) = session else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || session.stop()).await.map_err(|e| e.to_string())
}

// MARK: - Files

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileOptions {
    path: String,
    language: Option<String>,
    #[serde(default)]
    parameters: whisper::Parameters,
    swiss_spelling: bool,
    word_timestamps: bool,
}

/// Emits `file-progress` (0...1 or null) and `file-passage` for every recognized chunk.
#[tauri::command]
async fn transcribe_file(options: FileOptions, app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let context = state.engine.context().ok_or("Choose a Whisper model in Settings › Speech Recognition.")?;
    let cancelled = state.cancelled.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let progress_app = app.clone();
        file::transcribe(Path::new(&options.path), &context, options.language.as_deref(), &options.parameters,
                         options.swiss_spelling, options.word_timestamps, cancelled,
                         move |p| { let _ = progress_app.emit("file-progress", p); },
                         move |passage| { let _ = app.emit("file-passage", passage); })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn audio_info(path: String) -> Result<file::AudioInfo> {
    file::audio_info(Path::new(&path))
}

#[tauri::command]
fn cancel_import(state: State<AppState>) {
    state.cancelled.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn reset_cancel(state: State<AppState>) {
    state.cancelled.store(false, Ordering::SeqCst);
}

#[tauri::command]
fn default_save_folder() -> String {
    dirs::document_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default())
        .join("Transcriber").to_string_lossy().to_string()
}

#[tauri::command]
fn write_text(path: String, contents: String) -> Result<()> {
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// A file in `folder` named `base` that doesn't exist yet ("base 2.ext" and so on). Creates the folder.
#[tauri::command]
fn unique_path(folder: String, base: String, extension: String) -> Result<String> {
    let folder = PathBuf::from(folder);
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let mut path = folder.join(format!("{base}.{extension}"));
    let mut number = 2;
    while path.exists() {
        path = folder.join(format!("{base} {number}.{extension}"));
        number += 1;
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn move_file(from: String, to: String) -> Result<()> {
    if std::fs::rename(&from, &to).is_err() {
        // Across drives a rename fails; copy instead.
        std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&from);
    }
    Ok(())
}

#[tauri::command]
fn make_temp_folder() -> Result<String> {
    let folder = std::env::temp_dir().join(format!("Transcriber-{}", std::process::id()))
        .join(format!("{}", chrono::Local::now().timestamp_nanos_opt().unwrap_or_default()));
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    Ok(folder.to_string_lossy().to_string())
}

#[tauri::command]
fn remove_folder(path: String) {
    let _ = std::fs::remove_dir_all(path);
}

// MARK: - Transcript folder

#[tauri::command]
fn list_folder(path: String) -> Result<Vec<library::Entry>> {
    library::list(Path::new(&path))
}

#[tauri::command]
fn list_subfolders(root: String) -> Vec<String> {
    library::subfolders(Path::new(&root))
}

#[tauri::command]
fn create_folder(parent: String, name: String) -> Result<String> {
    library::create_folder(Path::new(&parent), &name)
}

#[tauri::command]
fn rename_entry(path: String, name: String) -> Result<String> {
    library::rename(Path::new(&path), &name)
}

#[tauri::command]
fn move_entry(path: String, folder: String) -> Result<String> {
    library::move_into(Path::new(&path), Path::new(&folder))
}

#[tauri::command]
fn rename_transcript(path: String, base: String) -> Result<String> {
    library::rename_transcript(Path::new(&path), &base)
}

#[tauri::command]
fn delete_entry(path: String) -> Result<()> {
    library::delete(Path::new(&path))
}

/// Width of the transcript folder pane, in logical pixels (`PANE_WIDTH` in ContentView.tsx).
const SIDEBAR_WIDTH: f64 = 280.0;
/// The main window's smallest size without the pane (as in tauri.conf.json).
const MIN_CONTENT_WIDTH: f64 = 660.0;
const MIN_HEIGHT: f64 = 420.0;

/// A window's position and size in physical pixels: x, y, width, height.
type Frame = [i32; 4];

/// Where the window goes to open or close the transcript folder pane: it grows (or shrinks) on the right by the
/// pane's width. The left edge stays put; moving it would shift the page for a few frames before it catches up.
/// Returns the start and end frames for the interface to animate through with `set_window_frame`, or None when
/// the window keeps its size (a maximized window, or closing a pane that was opened maximized).
/// `background` (the page's background, "#rrggbb") fills any strip the page hasn't painted yet as it grows.
#[tauri::command]
fn plan_sidebar(open: bool, background: String, window: tauri::WebviewWindow,
                state: State<AppState>) -> Result<Option<[Frame; 2]>> {
    if let Some(color) = parse_hex_color(&background) {
        let _ = window.set_background_color(Some(color));
    }
    let mut sidebar = state.sidebar.lock().unwrap();
    let previous = sidebar.take();
    if open && previous.is_some() {
        // Already open: don't widen twice.
        *sidebar = previous;
        return Ok(None);
    }
    let grew = previous == Some(true);
    let can_resize = !window.is_maximized().unwrap_or(false) && !window.is_fullscreen().unwrap_or(false);
    if !can_resize || (!open && !grew) {
        if open {
            *sidebar = Some(false);
        }
        return Ok(None);
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let extra = (SIDEBAR_WIDTH * scale).round() as i32;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let from = [position.x, position.y, size.width as i32, size.height as i32];

    if !open {
        return Ok(Some([from, [from[0], from[1], (from[2] - extra).max(1), from[3]]]));
    }
    let mut to = [from[0], from[1], from[2] + extra, from[3]];
    // Stay on the screen: move left only as far as needed, and never get wider than the screen.
    if let Ok(Some(monitor)) = window.current_monitor() {
        let area = monitor.work_area();
        let (left, right) = (area.position.x, area.position.x + area.size.width as i32);
        to[2] = to[2].min(right - left);
        to[0] = to[0].min(right - to[2]).max(left);
    }
    *sidebar = Some(true);
    Ok(Some([from, to]))
}

/// One step of the pane animation. Moves and resizes in a single call, so the edges never wobble.
/// (Synchronous, so steps run on the main thread in the order they were sent.)
#[tauri::command]
fn set_window_frame(frame: Frame, window: tauri::WebviewWindow) {
    set_frame(&window, frame);
}

/// While the pane is open the window can't get narrower than the pane plus the transcript's minimum.
/// Raised once the pane has opened and lowered before it closes: changing it can resize the window on the spot.
#[tauri::command]
fn set_sidebar_min_size(open: bool, window: tauri::WebviewWindow) -> Result<()> {
    let extra = if open { SIDEBAR_WIDTH } else { 0.0 };
    window.set_min_size(Some(LogicalSize::new(MIN_CONTENT_WIDTH + extra, MIN_HEIGHT))).map_err(|e| e.to_string())
}

fn parse_hex_color(hex: &str) -> Option<tauri::window::Color> {
    let hex = hex.trim().strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    Some(tauri::window::Color(channel(0)?, channel(2)?, channel(4)?, 255))
}

#[cfg(windows)]
fn set_frame(window: &tauri::WebviewWindow, [x, y, width, height]: Frame) {
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(hwnd: *mut std::ffi::c_void, after: *mut std::ffi::c_void, x: i32, y: i32, cx: i32, cy: i32,
                        flags: u32) -> i32;
    }
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_NOOWNERZORDER: u32 = 0x0200;
    let Ok(hwnd) = window.hwnd() else { return };
    unsafe {
        SetWindowPos(hwnd.0 as *mut std::ffi::c_void, std::ptr::null_mut(), x, y, width, height,
                     SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    }
}

#[cfg(not(windows))]
fn set_frame(window: &tauri::WebviewWindow, [x, y, width, height]: Frame) {
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = window.set_size(tauri::PhysicalSize::new(width.max(1) as u32, height.max(1) as u32));
}

// MARK: - YouTube

#[tauri::command]
async fn find_ytdlp(custom_path: String) -> Option<youtube::Tool> {
    youtube::find_tool(&custom_path).await
}

#[tauri::command]
fn ytdlp_install_command() -> &'static str {
    youtube::INSTALL_COMMAND
}

#[tauri::command]
async fn youtube_captions(tool: youtube::Tool, video: String, language_code: String, folder: String,
                          state: State<'_, AppState>) -> Result<Option<youtube::Captions>> {
    youtube::captions(&tool, &video, &language_code, Path::new(&folder), state.cancelled.clone()).await
}

/// Emits `youtube-progress` (0...1).
#[tauri::command]
async fn youtube_download_audio(tool: youtube::Tool, video: String, folder: String, app: AppHandle,
                                state: State<'_, AppState>) -> Result<youtube::DownloadedAudio> {
    youtube::download_audio(&tool, &video, Path::new(&folder), state.cancelled.clone(), move |p| {
        let _ = app.emit("youtube-progress", p);
    }).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState {
            engine: Arc::new(whisper::Engine::default()),
            load_lock: Arc::new(tokio::sync::Mutex::new(())),
            live: Mutex::new(None),
            cancelled: Arc::new(AtomicBool::new(false)),
            sidebar: Mutex::new(None),
        })
        .on_window_event(|window, event| {
            // Closing the main window quits, Settings included (like the Mac app).
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            whisper_status, models_folder, prepare_whisper, preload_whisper,
            list_input_devices, start_live, stop_live,
            transcribe_file, audio_info, cancel_import, reset_cancel,
            default_save_folder, write_text, unique_path, move_file, make_temp_folder, remove_folder,
            list_folder, list_subfolders, create_folder, rename_entry, move_entry, rename_transcript, delete_entry,
            plan_sidebar, set_window_frame, set_sidebar_min_size,
            find_ytdlp, ytdlp_install_command, youtube_captions, youtube_download_audio,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Transcriber");
}
