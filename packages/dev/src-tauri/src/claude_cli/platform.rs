/// Cross-platform path utilities for Windows ↔ WSL ↔ Linux path conversion.
///
/// Path formats handled:
///   Linux:   /home/dmin/project
///   Windows: C:\Users\Admin\project
///   WSL UNC: \\wsl.localhost\Ubuntu-24.04\home\dmin\project
///            \\wsl$\Ubuntu-24.04\home\dmin\project
use std::sync::OnceLock;

/// Cached WSL distro name (detected once, reused).
static WSL_DISTRO: OnceLock<String> = OnceLock::new();

/// Detect the default WSL distro name. Returns empty string if WSL unavailable.
pub(crate) fn wsl_distro() -> &'static str {
    WSL_DISTRO.get_or_init(|| {
        std::process::Command::new("wsl")
            .args(["-l", "-q"])
            .output()
            .ok()
            .and_then(|d| {
                // wsl -l outputs UTF-16LE on Windows
                let raw = d.stdout;
                let decoded = if raw.len() >= 2 && raw[0] == 0xFF && raw[1] == 0xFE {
                    let u16s: Vec<u16> = raw[2..]
                        .chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect();
                    String::from_utf16_lossy(&u16s)
                } else {
                    String::from_utf8_lossy(&raw).to_string()
                };
                decoded
                    .lines()
                    .map(|l| l.trim().trim_matches('\0').trim())
                    .find(|l| !l.is_empty())
                    .map(|s| s.replace('\0', ""))
            })
            .unwrap_or_default()
    })
}

/// Get the WSL home directory as a Linux path. Returns None if WSL unavailable.
pub(crate) fn wsl_home() -> Option<String> {
    let output = std::process::Command::new("wsl")
        .args(["-e", "bash", "-c", "echo $HOME"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let home = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if home.is_empty() { None } else { Some(home) }
}

// ─── Path classification ────────────────────────────────────────────────────

fn is_wsl_unc(path: &str) -> bool {
    let p = path.replace('\\', "/");
    p.starts_with("//wsl.localhost/") || p.starts_with("//wsl$/")
}

fn is_windows_drive(path: &str) -> bool {
    path.len() >= 2
        && path.as_bytes()[0].is_ascii_alphabetic()
        && path.as_bytes()[1] == b':'
}

fn is_linux(path: &str) -> bool {
    path.starts_with('/')
}

// ─── Conversions ────────────────────────────────────────────────────────────

/// Convert any path to a Linux WSL path.
///
/// - `\\wsl.localhost\Distro\home\user` → `/home/user`
/// - `C:\Users\Admin` → `/mnt/c/Users/Admin`
/// - `/home/user` → `/home/user` (passthrough)
pub(crate) fn to_wsl_path(path: &str) -> String {
    let path = path.trim_matches('"').replace('\n', "").replace('\r', "").replace('\0', "").replace('\\', "/");

    // WSL UNC → strip prefix + distro
    for prefix in &["//wsl.localhost/", "//wsl$/"] {
        if let Some(rest) = path.strip_prefix(prefix) {
            if let Some(pos) = rest.find('/') {
                return rest[pos..].to_string();
            }
        }
    }

    // Already a Linux path
    if is_linux(&path) {
        return path;
    }

    // Windows drive letter → /mnt/<drive>/...
    if path.len() >= 2 && path.as_bytes()[1] == b':' {
        let drive = (path.as_bytes()[0] as char).to_ascii_lowercase();
        return format!("/mnt/{}{}", drive, &path[2..]);
    }

    path
}

/// Convert any path to a Windows-accessible path.
///
/// - `/home/user` → `\\wsl.localhost\<distro>\home\user`
/// - `C:\Users\Admin` → `C:\Users\Admin` (passthrough)
/// - `\\wsl.localhost\...` → passthrough (already Windows UNC)
pub(crate) fn to_windows_path(path: &str) -> String {
    let clean = path.trim_matches('"').replace('\n', "").replace('\r', "").replace('\0', "");

    // Already a Windows UNC path
    if is_wsl_unc(&clean) {
        return clean.replace('/', "\\");
    }

    // Already a Windows drive path
    if is_windows_drive(&clean) {
        return clean;
    }

    // Linux path → WSL UNC
    if is_linux(&clean) {
        let distro = wsl_distro();
        if distro.is_empty() {
            // No WSL — can't convert, return as-is
            return clean.to_string();
        }
        return format!(
            "\\\\wsl.localhost\\{}{}",
            distro,
            clean.replace('/', "\\")
        );
    }

    clean
}
