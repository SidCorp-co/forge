//! GUI-launch PATH inheritance fix.
//!
//! macOS GUI apps (Finder/Dock launches) inherit a minimal PATH —
//! `/usr/bin:/bin:/usr/sbin:/sbin` — that excludes Homebrew (Apple Silicon
//! `/opt/homebrew/bin`), nvm shims, npm-global, and user-managed install
//! dirs like `~/.local/bin`. Linux apps launched from a `.desktop` file
//! face the same problem. The result: `Command::new("claude")` (or git,
//! gh, …) returns ENOENT even though the binary is installed.
//!
//! At app startup we run the user's login shell once with `-lc`, capture
//! its `$PATH`, and `setenv("PATH", …)` for the entire process. Every
//! subsequent spawn resolves against the user's real PATH.
//!
//! Industry precedent: this is the same approach VS Code, Atom, GitHub
//! Desktop, and JetBrains use; the npm package is `fix-path` /
//! `shell-env`. There is no equivalent crate in the Rust ecosystem yet,
//! so we inline ~80 lines.

#[cfg(target_os = "windows")]
pub fn fix_gui_path() {
    // Windows GUI processes inherit System+User PATH from the registry,
    // not from a per-user shell rc. The WSL spawn path (claude_cli/spawn.rs)
    // explicitly initialises PATH inside the wsl bash invocation, so this
    // problem does not apply on Windows.
}

#[cfg(not(target_os = "windows"))]
pub fn fix_gui_path() {
    let probed = match probe_login_shell_path() {
        Some(p) => p,
        None => return,
    };

    let current = std::env::var("PATH").unwrap_or_default();
    if current == probed {
        return;
    }
    eprintln!(
        "[env] PATH replaced via login shell ({} entries → {} entries)",
        current.split(':').count(),
        probed.split(':').count()
    );
    std::env::set_var("PATH", probed);
}

#[cfg(not(target_os = "windows"))]
fn probe_login_shell_path() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    // Sentinels survive any chatty shell rc that prints a banner before
    // (or after) our printf — we slice between the markers and ignore the
    // rest. `printf` is a POSIX builtin in bash/zsh/fish so this works
    // across shells without spawning /usr/bin/printf.
    const SENTINEL_BEGIN: &str = "__FORGE_PATH_BEGIN__";
    const SENTINEL_END: &str = "__FORGE_PATH_END__";
    const SCRIPT: &str =
        "printf '__FORGE_PATH_BEGIN__%s__FORGE_PATH_END__' \"$PATH\"";
    const TIMEOUT: Duration = Duration::from_secs(5);

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    if shell.trim().is_empty() || !std::path::Path::new(&shell).exists() {
        eprintln!("[env] $SHELL ({shell}) missing or invalid; skipping PATH probe");
        return None;
    }

    let mut child = Command::new(&shell)
        .args(["-lc", SCRIPT])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // Drain stdout in a thread so a slow rc that writes >pipe-buffer bytes
    // can't deadlock us.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });

    let deadline = Instant::now() + TIMEOUT;
    let exited = loop {
        match child.try_wait() {
            Ok(Some(_)) => break true,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break false,
        }
    };

    if !exited {
        eprintln!("[env] login-shell PATH probe timed out after 5s; keeping inherited PATH");
        return None;
    }

    let stdout_text = reader.join().ok()?;
    let begin = stdout_text.find(SENTINEL_BEGIN)? + SENTINEL_BEGIN.len();
    let end = stdout_text[begin..].find(SENTINEL_END)? + begin;
    let path = stdout_text[begin..end].trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}
