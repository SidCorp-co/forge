//! The Claude Code version this box runs, pinned in its config (`[runner] claude_version`), and
//! the refusal a different installed version gets (ISS-1268 B5, C1).

use std::time::Duration;

/// The version `claude --version` printed, e.g. `2.1.322 (Claude Code)` -> `2.1.322`.
pub fn parse(printed: &str) -> Option<String> {
    let v = printed.split_whitespace().next()?;
    v.chars()
        .all(|c| c.is_ascii_digit() || c == '.' || c.is_ascii_alphanumeric() || c == '-')
        .then(|| v.to_string())
        .filter(|v| v.contains('.'))
}

/// Whether `installed` is the version this box is pinned to, refused by name naming both.
pub fn check(pinned: Option<&str>, installed: &str) -> Result<(), String> {
    match pinned.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) if p == installed => Ok(()),
        Some(p) => Err(format!(
            "[CLAUDE_VERSION_UNPINNED] this box is pinned to Claude Code {p} and {installed} is \
             installed; no session is started on a version the canary has not passed \
             (`forge-runner claude canary {installed}` moves the pin on a pass)"
        )),
        None => Err(format!(
            "[CLAUDE_VERSION_UNPINNED] this box pins no Claude Code version and {installed} is \
             installed; pin the one the canary passed: `forge-runner config set \
             runner.claude-version <version>`"
        )),
    }
}

/// The installed version, as `claude --version` prints it.
pub async fn installed() -> Result<String, String> {
    installed_at(runner_platform::process::resolve_claude_bin()).await
}

/// [`installed`] for the binary at `bin`.
pub async fn installed_at(bin: &str) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(20), cmd.output())
        .await
        .map_err(|_| format!("`{bin} --version` did not answer within 20s"))?
        .map_err(|e| format!("`{bin} --version` could not be run: {e}"))?;
    let printed = String::from_utf8_lossy(&out.stdout);
    parse(&printed).ok_or_else(|| format!("`{bin} --version` printed no version: {printed}"))
}

/// The pin from this box's config.
pub fn pinned() -> Option<String> {
    runner_platform::config::Config::load()
        .ok()
        .and_then(|c| c.runner.claude_version)
}

/// The installed version where it is the pinned one; the refusal otherwise.
pub async fn ensure_pinned() -> Result<String, String> {
    let installed = installed().await?;
    check(pinned().as_deref(), &installed)?;
    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_other_than_the_pin_is_refused_naming_both() {
        assert_eq!(parse("2.1.322 (Claude Code)\n").as_deref(), Some("2.1.322"));
        assert_eq!(parse("command not found"), None);
        assert!(check(Some("2.1.322"), "2.1.322").is_ok());
        let e = check(Some("2.1.322"), "2.1.326").unwrap_err();
        assert!(e.starts_with("[CLAUDE_VERSION_UNPINNED]"), "{e}");
        assert!(e.contains("2.1.322") && e.contains("2.1.326"), "{e}");
        let none = check(None, "2.1.326").unwrap_err();
        assert!(none.starts_with("[CLAUDE_VERSION_UNPINNED]") && none.contains("2.1.326"));
    }
}
