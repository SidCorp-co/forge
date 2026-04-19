use std::fs;
use std::path::PathBuf;

/// Strip surrounding quotes from path strings (Tauri IPC sometimes adds them).
pub fn clean(path: &str) -> &str {
    path.trim_matches('"')
}

/// Read a file — native fs for all paths (Windows handles UNC paths natively).
pub fn read_file(repo_path: &str, rel_path: &str) -> Option<String> {
    let path = PathBuf::from(clean(repo_path)).join(rel_path);
    fs::read_to_string(path).ok()
}

/// Write a file — native fs for all paths (Windows handles UNC paths natively).
/// Uses atomic write (tmp + rename) to prevent corruption on crash.
pub fn write_file(repo_path: &str, rel_path: &str, content: &str) -> Result<(), String> {
    let path = PathBuf::from(clean(repo_path)).join(rel_path);
    super::atomic_write(&path, content)
}

/// Remove a directory recursively.
pub fn rm_rf(repo_path: &str, rel_path: &str) -> Result<(), String> {
    let path = PathBuf::from(clean(repo_path)).join(rel_path);
    if path.exists() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Copy a directory recursively.
pub fn copy_dir(src: &std::path::Path, repo_path: &str, rel_path: &str) -> Result<(), String> {
    let dest = PathBuf::from(clean(repo_path)).join(rel_path);
    super::skills::copy_dir_recursive(src, &dest)
}
