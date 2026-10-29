//! `forge-runner session-gh -- <gh args>` — the `gh` an owner-mode channel agent runs (ISS-765).
//!
//! The session's `PATH` starts with a shim that runs this: it reads the clone's `origin`, asks core
//! for a credential to that repository as the session (`git-credential --session`), and runs the
//! real `gh` with it as `GH_TOKEN`. Core mints a GitHub installation token narrowed to that one
//! repository, so `gh` reaches nothing else; this box's own `gh` login is out of the session's view.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use clap::Args as ClapArgs;

use super::git_credential::session_grant;
use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    /// The arguments for `gh`.
    #[arg(last = true, value_parser = clap::value_parser!(OsString))]
    args: Vec<OsString>,
}

/// `host` and `owner/repo.git` of an https origin.
fn origin_parts(url: &str) -> Option<(String, String)> {
    let rest = url.trim().strip_prefix("https://")?;
    let rest = rest.rsplit_once('@').map_or(rest, |(_, r)| r);
    let (host, path) = rest.split_once('/')?;
    let path = path.trim_end_matches('/');
    let path = if path.ends_with(".git") {
        path.to_string()
    } else {
        format!("{path}.git")
    };
    (!host.is_empty() && path.matches('/').count() == 1).then(|| (host.to_lowercase(), path))
}

/// The real `gh` on `PATH`: the first that is not the owner-mode shim.
fn real_gh() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("gh"))
        .find(|candidate| is_real(candidate))
}

fn is_real(candidate: &Path) -> bool {
    candidate.is_file()
        && !std::fs::read(candidate)
            .map(|b| String::from_utf8_lossy(&b).contains(runner_platform::confine::GH_SHIM_MARK))
            .unwrap_or(false)
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let out = std::process::Command::new("git")
        .args(["config", "--get", "remote.origin.url"])
        .output()
        .map_err(|e| anyhow::anyhow!("gh: git could not run to read this clone's origin: {e}"))?;
    let origin = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let (host, path) = origin_parts(&origin).ok_or_else(|| {
        anyhow::anyhow!(
            "gh runs here against this clone's own repository, and its origin {origin:?} is no https repository URL"
        )
    })?;
    let grant = session_grant(&ctx, &host, &path).await?;
    let gh = real_gh().ok_or_else(|| anyhow::anyhow!("gh is not installed on this box"))?;
    let mut cmd = std::process::Command::new(gh);
    cmd.args(&args.args).env("GH_TOKEN", &grant.password);
    if host != "github.com" {
        cmd.env("GH_HOST", &host);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = cmd.exec();
        anyhow::bail!("gh could not run: {err}");
    }
    #[cfg(not(unix))]
    {
        let status = cmd.status()?;
        std::process::exit(status.code().unwrap_or(1));
    }
}

#[cfg(test)]
mod tests {
    use super::origin_parts;

    #[test]
    fn an_https_origin_names_its_host_and_repository() {
        assert_eq!(
            origin_parts("https://github.com/junixlabs/orbit.git"),
            Some(("github.com".into(), "junixlabs/orbit.git".into()))
        );
        assert_eq!(
            origin_parts("https://x-access-token@GitHub.com/a/b"),
            Some(("github.com".into(), "a/b.git".into()))
        );
        assert_eq!(origin_parts("git@github.com:a/b.git"), None);
        assert_eq!(origin_parts("https://github.com/a/b/c.git"), None);
    }
}
