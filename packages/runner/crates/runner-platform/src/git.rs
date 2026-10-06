//! The one way the runner reads git: a non-interactive child in `dir`, killed
//! with its caller, whose failure is `None` rather than an error to plumb.

use std::path::Path;
use std::process::{Output, Stdio};

use tokio::process::Command;

pub async fn git(dir: &Path, args: &[&str]) -> Option<Output> {
    non_interactive(Command::new("git").args(args).current_dir(dir))
        .output()
        .await
        .ok()
}

/// Make `cmd`, a git child, one that can never wait on a person: stdin closed,
/// no terminal prompt, no askpass program (an empty `GIT_ASKPASS` also stops
/// git falling back to `SSH_ASKPASS`), Git Credential Manager told not to open
/// a dialog, and the child killed when its caller's future is dropped, so a
/// timeout around it leaves no git behind. A credential git needs and has not
/// got is then a refusal it prints at once, never a prompt nobody answers.
pub fn non_interactive(cmd: &mut Command) -> &mut Command {
    cmd.stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("GCM_INTERACTIVE", "never")
        .kill_on_drop(true)
}

/// Trimmed stdout of a successful git call, or `None` when it failed or said nothing.
pub async fn git_line(dir: &Path, args: &[&str]) -> Option<String> {
    let out = git(dir, args).await?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !s.is_empty()).then_some(s)
}

/// `origin`'s URL as git itself reaches it: `remote get-url` applies `url.*.insteadOf`, so this is
/// what `ls-remote origin` and a clone talk to. Bind's check and the head read both take it from
/// here, so a checkout one accepts is never one the other reads under another name.
pub async fn origin_url(dir: &Path) -> Option<String> {
    git_line(dir, &["remote", "get-url", "origin"]).await
}

/// `text` with the userinfo of every `scheme://user[:password]@host` in it removed, so a token a
/// checkout was cloned with never leaves this box in an origin or an error naming one. An
/// scp-style `git@host:path` carries a user and never a password, and is left as it is.
pub fn strip_userinfo(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let (before, after) = rest.split_at(at + 3);
        out.push_str(before);
        let authority_end = after
            .find(|c: char| c == '/' || c.is_whitespace() || matches!(c, ')' | '\'' | '"' | '`'))
            .unwrap_or(after.len());
        let authority = &after[..authority_end];
        match authority.rfind('@') {
            Some(i) => out.push_str(&authority[i + 1..]),
            None => out.push_str(authority),
        }
        rest = &after[authority_end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::strip_userinfo;

    #[test]
    fn userinfo_is_removed_from_every_url_and_nothing_else() {
        let cases = [
            (
                "https://x-access-token:ghp_x@github.com/org/repo.git",
                "https://github.com/org/repo.git",
            ),
            (
                "https://tok@github.com/org/repo",
                "https://github.com/org/repo",
            ),
            (
                "ssh://git@host:22/org/repo.git",
                "ssh://host:22/org/repo.git",
            ),
            ("git@github.com:org/repo.git", "git@github.com:org/repo.git"),
            ("/srv/git/repo.git", "/srv/git/repo.git"),
            ("file:///srv/git/repo.git", "file:///srv/git/repo.git"),
            (
                "in /w (https://u:p@h.io/a) failed: 'https://u:p@h.io/a'",
                "in /w (https://h.io/a) failed: 'https://h.io/a'",
            ),
            ("https://h.io", "https://h.io"),
            ("https://u:p@h.io", "https://h.io"),
            ("", ""),
        ];
        for (given, want) in cases {
            assert_eq!(strip_userinfo(given), want, "{given}");
        }
    }
}
