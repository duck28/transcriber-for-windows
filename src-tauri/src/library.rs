//! The transcript folder, as the sidebar shows and changes it: listing, new folders, renaming and moving.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// A file or folder in the transcript folder.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_folder: bool,
    /// Milliseconds since 1970.
    pub modified: f64,
}

/// The folders and files directly in `folder`, folders first, each sorted by name. Creates the folder.
pub fn list(folder: &Path) -> Result<Vec<Entry>, String> {
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(folder).map_err(|e| e.to_string())?.flatten() {
        let Ok(metadata) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hidden(&name, &metadata) {
            continue;
        }
        let modified = metadata.modified().ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);
        entries.push(Entry { name, path: entry.path().to_string_lossy().to_string(), is_folder: metadata.is_dir(), modified });
    }
    entries.sort_by(|a, b| b.is_folder.cmp(&a.is_folder).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

/// Every folder inside `root`, at any depth (for "Move To").
pub fn subfolders(root: &Path) -> Vec<String> {
    let mut folders = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(folder) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        let children: Vec<PathBuf> = entries.flatten()
            .filter(|e| e.metadata().map(|m| m.is_dir() && !is_hidden(&e.file_name().to_string_lossy(), &m)).unwrap_or(false))
            .map(|e| e.path())
            .collect();
        pending.extend(children.iter().cloned());
        folders.extend(children);
    }
    // Sorting by path components puts every folder right after its parent.
    folders.sort_by_key(|p| p.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect::<Vec<_>>());
    folders.into_iter().map(|p| p.to_string_lossy().to_string()).collect()
}

/// Dot files, desktop.ini, unfinished downloads and files Windows marks as hidden aren't shown.
fn is_hidden(name: &str, metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if metadata.file_attributes() & (HIDDEN | SYSTEM) != 0 {
            return true;
        }
    }
    #[cfg(not(windows))]
    let _ = metadata;
    name.starts_with('.') || name.eq_ignore_ascii_case("desktop.ini") || name.ends_with(".part")
}

/// The name, trimmed, if Windows allows it for a file or folder.
fn valid_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err("Enter a name.".into());
    }
    if name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) || name.chars().any(char::is_control) {
        return Err("A name can't contain any of these characters: \\ / : * ? \" < > |".into());
    }
    if name.ends_with('.') {
        return Err("A name can't end with a period.".into());
    }
    Ok(name)
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

fn already_exists(name: &str) -> String {
    format!("There's already an item named “{name}” there.")
}

/// Creates a folder named `name` (or "name 2" and so on) in `parent` and returns its path.
pub fn create_folder(parent: &Path, name: &str) -> Result<String, String> {
    let name = valid_name(name)?;
    let mut path = parent.join(name);
    let mut number = 2;
    while path.exists() {
        path = parent.join(format!("{name} {number}"));
        number += 1;
    }
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Renames a file or folder in place and returns its new path.
pub fn rename(path: &Path, new_name: &str) -> Result<String, String> {
    let new_name = valid_name(new_name)?;
    let parent = path.parent().ok_or("This item can't be renamed.")?;
    let target = parent.join(new_name);
    // Changing only the capitalization is a rename of the same file.
    if target.exists() && !same_path(&target, path) {
        return Err(already_exists(new_name));
    }
    std::fs::rename(path, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// Moves a file or folder into `folder` and returns its new path.
pub fn move_into(path: &Path, folder: &Path) -> Result<String, String> {
    let name = path.file_name().ok_or("This item can't be moved.")?;
    let target = folder.join(name);
    if same_path(&target, path) {
        return Ok(path.to_string_lossy().to_string());
    }
    let inside = folder.to_string_lossy().to_lowercase();
    let moved = path.to_string_lossy().to_lowercase();
    if inside == moved || inside.starts_with(&format!("{moved}\\")) || inside.starts_with(&format!("{moved}/")) {
        return Err("A folder can't be moved into itself.".into());
    }
    if target.exists() {
        return Err(already_exists(&name.to_string_lossy()));
    }
    std::fs::rename(path, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// Moves a file or folder to the Recycle Bin.
pub fn delete(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err("This item no longer exists.".into());
    }
    trash::delete(path).map_err(|e| format!("“{}” couldn't be moved to the Recycle Bin: {e}",
                                            path.file_name().unwrap_or_default().to_string_lossy()))
}

/// Renames a saved transcript to `base` plus its extension, along with the files next to it that share its
/// name (subtitles, audio). Picks "base 2" and so on if any of the new names is taken. Returns the new path.
pub fn rename_transcript(path: &Path, base: &str) -> Result<String, String> {
    let base = valid_name(base)?;
    let folder = path.parent().ok_or("The transcript can't be renamed.")?;
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let extension = |p: &Path| p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let siblings: Vec<PathBuf> = std::fs::read_dir(folder).map_err(|e| e.to_string())?.flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && !same_path(p, path)
            && p.file_stem().map(|s| s.to_string_lossy().to_lowercase() == stem).unwrap_or(false))
        .collect();

    let taken = |candidate: &str| {
        std::iter::once(path).chain(siblings.iter().map(|p| p.as_path())).any(|p| {
            let target = folder.join(format!("{candidate}{}", extension(p)));
            target.exists() && !same_path(&target, p)
        })
    };
    let mut new_base = base.to_string();
    let mut number = 2;
    while taken(&new_base) {
        new_base = format!("{base} {number}");
        number += 1;
    }

    let target = folder.join(format!("{new_base}{}", extension(path)));
    std::fs::rename(path, &target).map_err(|e| e.to_string())?;
    for sibling in &siblings {
        // Audio that is still being recorded is locked; it keeps its name.
        let _ = std::fs::rename(sibling, folder.join(format!("{new_base}{}", extension(sibling))));
    }
    Ok(target.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_folder(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("transcriber-library-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn renames_a_transcript_with_its_subtitles() {
        let folder = temp_folder("rename");
        std::fs::write(folder.join("Talk.txt"), "text").unwrap();
        std::fs::write(folder.join("Talk.srt"), "subs").unwrap();
        std::fs::write(folder.join("Meeting.txt"), "taken").unwrap();
        let renamed = rename_transcript(&folder.join("Talk.txt"), "Meeting").unwrap();
        assert_eq!(PathBuf::from(renamed), folder.join("Meeting 2.txt"));
        assert!(folder.join("Meeting 2.srt").is_file());
        assert!(!folder.join("Talk.srt").exists());
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn moves_files_but_not_folders_into_themselves() {
        let folder = temp_folder("move");
        let inner = PathBuf::from(create_folder(&folder, "Inner").unwrap());
        std::fs::write(folder.join("a.txt"), "a").unwrap();
        move_into(&folder.join("a.txt"), &inner).unwrap();
        assert!(inner.join("a.txt").is_file());
        assert!(move_into(&inner, &inner).is_err());
        assert!(rename(&inner, "bad/name").is_err());
        assert_eq!(list(&folder).unwrap().len(), 1);
        std::fs::remove_dir_all(folder).unwrap();
    }
}
