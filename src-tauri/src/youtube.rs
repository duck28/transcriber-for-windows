//! Fetches captions or audio from YouTube with the `yt-dlp` command-line tool. Mirrors YouTubeImporter.swift.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::Command;

/// An installed yt-dlp and its version (a release date such as "2026.08.19").
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub path: String,
    pub version: String,
    /// YouTube regularly breaks older releases.
    pub is_outdated: bool,
    /// The command that updates this copy, depending on how it was installed.
    pub update_command: String,
}

#[derive(Serialize)]
pub struct CaptionSegment {
    pub offset: f64,
    pub text: String,
}

#[derive(Serialize)]
pub struct Captions {
    pub title: String,
    pub segments: Vec<CaptionSegment>,
}

#[derive(Serialize)]
pub struct DownloadedAudio {
    pub title: String,
    pub file: String,
}

pub const INSTALL_COMMAND: &str = "winget install yt-dlp.yt-dlp";

fn failed(message: &str) -> String {
    format!("yt-dlp failed: {message} YouTube changes often, so updating yt-dlp usually fixes this.")
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

fn executable_name(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

/// Folders in PATH that contain `name`.
fn in_path(name: &str) -> Vec<PathBuf> {
    let file = executable_name(name);
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).map(|p| p.join(&file)).filter(|p| p.is_file()).collect())
        .unwrap_or_default()
}

/// Subfolders of `root` whose name starts with `prefix`, joined with `rest`.
fn matching(root: &Path, prefix: &str, rest: &str) -> Vec<PathBuf> {
    std::fs::read_dir(root)
        .map(|entries| entries.flatten()
            .filter(|e| e.file_name().to_string_lossy().to_lowercase().starts_with(&prefix.to_lowercase()))
            .map(|e| e.path().join(rest))
            .filter(|p| p.is_file())
            .collect())
        .unwrap_or_default()
}

fn candidates(custom_path: &str) -> Vec<PathBuf> {
    let custom = custom_path.trim();
    if !custom.is_empty() {
        let path = PathBuf::from(custom);
        return if path.is_file() { vec![path] } else { vec![] };
    }
    let exe = executable_name("yt-dlp");
    let mut paths = in_path("yt-dlp");
    if let Some(local) = env_path("LOCALAPPDATA") {
        paths.push(local.join("Microsoft").join("WinGet").join("Links").join(&exe));
        paths.extend(matching(&local.join("Microsoft").join("WinGet").join("Packages"), "yt-dlp.yt-dlp", &exe));
        // pip installs into a folder per Python version.
        paths.extend(matching(&local.join("Programs").join("Python"), "Python", &format!("Scripts\\{exe}")));
    }
    if let Some(roaming) = env_path("APPDATA") {
        paths.extend(matching(&roaming.join("Python"), "Python", &format!("Scripts\\{exe}")));
    }
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join("scoop").join("shims").join(&exe));
        paths.push(home.join(".local").join("bin").join(&exe));
    }
    paths.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin").join(&exe));
    let mut seen = std::collections::HashSet::new();
    paths.into_iter()
        .filter(|p| p.is_file())
        .filter(|p| seen.insert(std::fs::canonicalize(p).unwrap_or_else(|_| p.clone())))
        .collect()
}

fn update_command(path: &Path) -> String {
    let lower = path.to_string_lossy().to_lowercase();
    if lower.contains("\\winget\\") { return "winget upgrade yt-dlp.yt-dlp".into(); }
    if lower.contains("\\scoop\\") { return "scoop update yt-dlp".into(); }
    if lower.contains("\\chocolatey\\") { return "choco upgrade yt-dlp".into(); }
    if lower.contains("\\python") || lower.contains("\\pipx\\") { return "pip install -U \"yt-dlp[default]\"".into(); }
    format!("\"{}\" -U", path.display())
}

fn is_outdated(version: &str) -> bool {
    let date = version.get(..10).unwrap_or("");
    let Ok(released) = chrono::NaiveDate::parse_from_str(date, "%Y.%m.%d") else { return false };
    (chrono::Local::now().date_naive() - released).num_days() > 180
}

fn command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    #[cfg(windows)]
    {
        // Don't flash a console window.
        command.creation_flags(0x0800_0000);
    }
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    command
}

/// The yt-dlp to use: `custom_path` if set, otherwise the newest one found in common install locations.
pub async fn find_tool(custom_path: &str) -> Option<Tool> {
    let mut tools = Vec::new();
    for path in candidates(custom_path) {
        let Ok(output) = command(&path).arg("--version").output().await else { continue };
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() && !version.is_empty() {
            tools.push(Tool {
                path: path.to_string_lossy().to_string(),
                is_outdated: is_outdated(&version),
                update_command: update_command(&path),
                version,
            });
        }
    }
    tools.into_iter().max_by(|a, b| a.version.cmp(&b.version))
}

/// Deno is used automatically when it's on the PATH; Node or Bun have to be named explicitly.
fn javascript_runtime_arguments() -> Vec<String> {
    if !in_path("deno").is_empty() {
        return vec![];
    }
    let mut nodes = in_path("node");
    if let Some(program_files) = env_path("ProgramFiles") {
        nodes.push(program_files.join("nodejs").join("node.exe"));
    }
    if let Some(node) = nodes.into_iter().find(|p| p.is_file()) {
        return vec!["--js-runtimes".into(), format!("node:{}", node.display())];
    }
    if let Some(bun) = in_path("bun").into_iter().next() {
        return vec!["--js-runtimes".into(), format!("bun:{}", bun.display())];
    }
    vec![]
}

/// Runs yt-dlp. Returns its standard output, and the error it reported if it failed.
/// Setting `cancelled` terminates the process.
async fn run(tool: &Tool, arguments: Vec<String>, cancelled: Arc<AtomicBool>,
             on_line: impl Fn(&str)) -> Result<(String, Option<String>), String> {
    let mut all = if tool.version.as_str() >= "2025.11" { javascript_runtime_arguments() } else { vec![] };
    all.extend(arguments);
    let mut child = command(Path::new(&tool.path)).args(&all).spawn().map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let error_task = tokio::spawn(async move {
        let mut text = String::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_string(&mut text).await;
        text
    });
    let mut output = Vec::new();
    let mut buffer = [0u8; 4096];
    let mut partial = String::new();
    loop {
        if cancelled.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            return Err("cancelled".into());
        }
        let read = tokio::time::timeout(std::time::Duration::from_millis(100), stdout.read(&mut buffer)).await;
        let Ok(read) = read else { continue };
        let count = read.map_err(|e| e.to_string())?;
        if count == 0 { break; }
        output.extend_from_slice(&buffer[..count]);
        // yt-dlp ends progress lines with \r or \n.
        partial.push_str(&String::from_utf8_lossy(&buffer[..count]));
        let mut parts: Vec<String> = partial.split(['\r', '\n']).map(String::from).collect();
        partial = parts.pop().unwrap_or_default();
        for line in parts.iter().filter(|l| !l.is_empty()) {
            on_line(line);
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let errors = error_task.await.unwrap_or_default();
    let output = String::from_utf8_lossy(&output).to_string();
    if status.success() {
        return Ok((output, None));
    }
    let lines: Vec<&str> = errors.lines().filter(|l| !l.trim().is_empty()).collect();
    let message = lines.iter().rev().find(|l| l.starts_with("ERROR:")).map(|l| l["ERROR:".len()..].trim().to_string())
        .or_else(|| lines.last().map(|l| l.trim().to_string()))
        .unwrap_or_else(|| format!("exit status {}.", status.code().unwrap_or(-1)));
    Ok((output, Some(failed(&message))))
}

fn title(output: &str) -> Option<String> {
    output.lines().find_map(|l| l.strip_prefix("TITLE:").map(String::from))
}

/// Captions in `language_code` (uploaded ones preferred over automatic ones), or None if the video has none.
pub async fn captions(tool: &Tool, video: &str, language_code: &str, directory: &Path,
                      cancelled: Arc<AtomicBool>) -> Result<Option<Captions>, String> {
    // Only this language and its regional variants (en-GB), not YouTube's machine translations
    // ("en-de" etc.): requesting dozens of those gets the download rate-limited (HTTP 429).
    let languages = format!("{language_code},{language_code}-orig,{language_code}-[A-Z]{{2}}");
    let (output, failure) = run(tool, vec![
        "--no-playlist".into(), "--skip-download".into(), "--no-simulate".into(),
        "--write-subs".into(), "--write-auto-subs".into(), "--sub-langs".into(), languages,
        "--sub-format".into(), "json3".into(),
        "--print".into(), "TITLE:%(title)s".into(),
        "-o".into(), directory.join("captions.%(ext)s").to_string_lossy().to_string(),
        video.into(),
    ], cancelled, |_| {}).await?;

    let mut files: Vec<PathBuf> = std::fs::read_dir(directory).map(|entries| entries.flatten().map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "json3").unwrap_or(false)).collect()).unwrap_or_default();
    files.sort();
    // Prefer exactly the requested language over regional variants.
    let preferred = [format!("captions.{language_code}.json3"), format!("captions.{language_code}-orig.json3")];
    let file = preferred.iter()
        .find_map(|name| files.iter().find(|f| f.file_name().map(|n| n.to_string_lossy() == *name).unwrap_or(false)))
        .or(files.first());
    let Some(file) = file else {
        return match failure { Some(failure) => Err(failure), None => Ok(None) };
    };
    // A caption file arrived, so a failure on another track doesn't matter.
    let data = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
    let segments = parse_json3(&data)?;
    if segments.is_empty() {
        return Ok(None);
    }
    Ok(Some(Captions { title: title(&output).unwrap_or_else(|| video.to_string()), segments }))
}

/// Downloads the audio track into `directory`. `progress` gets 0...1.
pub async fn download_audio(tool: &Tool, video: &str, directory: &Path, cancelled: Arc<AtomicBool>,
                            progress: impl Fn(f64)) -> Result<DownloadedAudio, String> {
    let percent = Regex::new(r"[0-9.]+(?:%)").unwrap();
    let (output, failure) = run(tool, vec![
        "--no-playlist".into(), "--no-simulate".into(), "--progress".into(), "--newline".into(),
        // m4a/mp4 can be read without ffmpeg.
        "-f".into(), "bestaudio[ext=m4a]/best[ext=mp4]/bestaudio".into(),
        "--print".into(), "TITLE:%(title)s".into(),
        "-o".into(), directory.join("audio.%(ext)s").to_string_lossy().to_string(),
        video.into(),
    ], cancelled, |line| {
        if line.starts_with("[download]") {
            if let Some(m) = percent.find(line) {
                if let Ok(value) = m.as_str().trim_end_matches('%').parse::<f64>() {
                    progress(value / 100.0);
                }
            }
        }
    }).await?;
    if let Some(failure) = failure {
        return Err(failure);
    }
    let file = std::fs::read_dir(directory).ok()
        .and_then(|entries| entries.flatten().map(|e| e.path()).find(|p| {
            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            name.starts_with("audio.") && !name.ends_with(".part")
        }))
        .ok_or("yt-dlp didn't download any audio.")?;
    Ok(DownloadedAudio {
        title: title(&output).unwrap_or_else(|| video.to_string()),
        file: file.to_string_lossy().to_string(),
    })
}

#[derive(Deserialize)]
#[allow(non_snake_case)]
struct Json3 {
    events: Option<Vec<Json3Event>>,
}

#[derive(Deserialize)]
#[allow(non_snake_case)]
struct Json3Event {
    tStartMs: Option<f64>,
    segs: Option<Vec<Json3Segment>>,
}

#[derive(Deserialize)]
struct Json3Segment {
    utf8: Option<String>,
}

/// Joins YouTube's short caption lines into paragraphs of a few sentences.
pub fn parse_json3(data: &str) -> Result<Vec<CaptionSegment>, String> {
    let parsed: Json3 = serde_json::from_str(data).map_err(|e| e.to_string())?;
    let mut paragraphs = Vec::new();
    let mut start: Option<f64> = None;
    let mut words: Vec<String> = Vec::new();

    fn flush(paragraphs: &mut Vec<CaptionSegment>, start: &mut Option<f64>, words: &mut Vec<String>) {
        if let Some(offset) = *start {
            if !words.is_empty() {
                paragraphs.push(CaptionSegment { offset, text: words.join(" ") });
            }
        }
        *start = None;
        words.clear();
    }

    for event in parsed.events.unwrap_or_default() {
        let line: String = event.segs.unwrap_or_default().into_iter().filter_map(|s| s.utf8).collect();
        let line_words: Vec<String> = line.split_whitespace().map(String::from).collect();
        if line_words.is_empty() {
            continue;
        }
        let time = event.tStartMs.unwrap_or(0.0) / 1000.0;
        if let Some(s) = start {
            let length = time - s;
            let ends_sentence = words.last().and_then(|w| w.chars().last()).map(|c| ".?!".contains(c)).unwrap_or(false);
            if length >= 30.0 || (length >= 10.0 && ends_sentence) {
                flush(&mut paragraphs, &mut start, &mut words);
            }
        }
        if start.is_none() {
            start = Some(time);
        }
        words.extend(line_words);
    }
    flush(&mut paragraphs, &mut start, &mut words);
    Ok(paragraphs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_caption_lines_into_paragraphs() {
        let data = r#"{"events":[{"tStartMs":0,"segs":[{"utf8":"Hello there."}]},
            {"tStartMs":12000,"segs":[{"utf8":"Second"},{"utf8":" paragraph"}]},
            {"tStartMs":13000,"segs":[{"utf8":"\n"}]}]}"#;
        let paragraphs = parse_json3(data).unwrap();
        assert_eq!(paragraphs.len(), 2);
        assert_eq!(paragraphs[1].text, "Second paragraph");
        assert_eq!(paragraphs[1].offset, 12.0);
    }
}
