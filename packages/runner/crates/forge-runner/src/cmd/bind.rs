use std::path::PathBuf;

use clap::Args as ClapArgs;
use runner_platform::config::{Binding, Config};
use runner_platform::cred_store;
use runner_transport::runners::MeRunner;
use runner_transport::{runners, CoreClient};
use runner_workspace::git_cred;
use runner_workspace::provision;

use super::Ctx;
use runner_platform::config::config_dir;

#[derive(ClapArgs)]
pub struct Args {
    /// Project slug (as shown in Forge). Must already be assigned to this
    /// device on the server (bind the device in the web UI first).
    pub slug: String,
    /// Path to an EXISTING local checkout (preferred — no re-clone).
    #[arg(long)]
    pub path: Option<PathBuf>,
    /// Default branch for this binding.
    #[arg(long)]
    pub branch: Option<String>,
    /// No local checkout yet: let the server provision one (clone + skills +
    /// `.mcp.json`) under `projects_root`, then bind to it.
    #[arg(long)]
    pub clone: bool,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let cfg = Config::load()?;
    let client = client_for(&ctx, &cfg)?;
    let assignment = assignment_for(&client, &args.slug).await?;
    let given = args.path.is_some();
    let path = match args.path {
        Some(p) => p.canonicalize().unwrap_or(p),
        None if args.clone => provision_checkout(&client, &assignment).await?,
        None => {
            return super::stub(
                "bind (auto-detect)",
                "for now point at an existing repo with `--path <dir>`, or pass `--clone` to have one provisioned",
            )
        }
    };

    if !path.join(".git").exists() {
        eprintln!(
            "warning: {} has no `.git` — binding will still be saved, but double-check the path.",
            path.display()
        );
    }

    // Before anything is saved: a checkout of another host's repository is refused, not bound.
    let helper_host = if given {
        checkout_credential_host(&args.slug, &path, &assignment, origin_url(&path).as_deref())?
    } else {
        None
    };

    let bound = write_binding(&client, &assignment, &args.slug, &path, args.branch).await?;
    println!(
        "bound {} -> {} (synced to server)",
        args.slug,
        bound.display()
    );
    // A checkout bound by path is provisioned like any other: without this its orientation kept
    // whatever instance last wrote it, and a re-bind never put this instance's back.
    if given {
        provision::reprovision(&client, &Config::load()?, &assignment.runner_id).await;
    }
    if let Some(host) = helper_host {
        git_cred::set_repo_credential_helper(&bound, &host).map_err(|e| {
            anyhow::anyhow!(
                "bound, but the git credential helper for {host} was not installed in {}: {e}",
                bound.display()
            )
        })?;
        println!(
            "git credential helper: https://{host} -> forge-runner git-credential (repo-local)"
        );
    }
    Ok(())
}

/// `origin`'s URL in the checkout, or `None` where it has no such remote.
fn origin_url(path: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()?;
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !url.is_empty()).then_some(url)
}

/// Where a repository lives, as the project document or a git remote names it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Place {
    /// On a host: its lower-cased name, and the `owner/repo` path lower-cased without `.git`.
    Hosted { host: String, path: String },
    /// A repository on this box's disk.
    Local(std::path::PathBuf),
}

impl std::fmt::Display for Place {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Place::Hosted { host, path } => write!(f, "{host}/{path}"),
            Place::Local(p) => write!(f, "{}", p.display()),
        }
    }
}

fn repo_path_of(path: &str) -> String {
    let p = path.trim().trim_matches('/');
    let p = p.strip_suffix(".git").unwrap_or(p);
    p.to_ascii_lowercase()
}

fn hosted(host: &str, path: &str) -> Option<Place> {
    let host = host
        .rsplit('@')
        .next()?
        .split(':')
        .next()?
        .to_ascii_lowercase();
    let path = repo_path_of(path);
    (!host.is_empty() && !path.is_empty()).then_some(Place::Hosted { host, path })
}

fn local(path: &std::path::Path, base: &std::path::Path) -> Place {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    Place::Local(joined.canonicalize().unwrap_or(joined))
}

/// The document's `source.git.repository`: `host.tld/owner/repo`, `user@host:owner/repo`, or an
/// absolute local path.
fn declared_place(repository: &str) -> Option<Place> {
    let r = repository.trim();
    if r.starts_with('/') {
        return Some(local(std::path::Path::new(r), std::path::Path::new("/")));
    }
    if let Some((authority, path)) = r.split_once(':') {
        if authority.contains('@') && !authority.contains('/') {
            return hosted(authority, path);
        }
    }
    let (host, path) = r.split_once('/')?;
    hosted(host, path)
}

/// A git remote in any of its forms — `https://host/…`, `ssh://user@host:port/…`,
/// `user@host:path`, `file:///path`, or a path (relative ones resolved from the checkout, as git
/// resolves them).
fn remote_place(url: &str, checkout: &std::path::Path) -> Option<Place> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    if let Some(path) = url.strip_prefix("file://") {
        return Some(local(std::path::Path::new(path), checkout));
    }
    if let Some((_, rest)) = url.split_once("://") {
        let (authority, path) = rest.split_once('/')?;
        return hosted(authority, path);
    }
    if let Some((authority, path)) = url.split_once(':') {
        if !authority.contains('/') && authority.len() > 1 {
            return hosted(authority, path);
        }
    }
    Some(local(std::path::Path::new(url), checkout))
}

// `--clone` gets its helper from the provision; a checkout bound by `--path` gets the same
// one here, for the host the project document declares — and only once its origin is that repository
/// The host to point this checkout's credential helper at, `None` where none is wanted (core
/// mints no credential, or origin is reached over SSH or the disk with this box's own access), or
/// a refusal naming both when the checkout's origin is not the declared repository.
fn checkout_credential_host(
    slug: &str,
    path: &std::path::Path,
    assignment: &MeRunner,
    origin: Option<&str>,
) -> anyhow::Result<Option<String>> {
    let Some(repository) = assignment.repository.as_deref() else {
        eprintln!(
            "note: core names no source repository for {slug} (no git source declared, or a core older than this runner), so no git credential helper is installed"
        );
        return Ok(None);
    };
    let Some(declared) = declared_place(repository) else {
        anyhow::bail!(
            "BIND_SOURCE_UNREADABLE: project {slug} declares its source as {repository:?}, which is none of `host.tld/owner/repo`, `git@host:owner/repo` or an absolute path — change `source.git.repository` with PUT /api/projects/:id/config"
        );
    };
    let Some(url) = origin else {
        anyhow::bail!(
            "BIND_ORIGIN_UNREADABLE: {} has no `origin` remote git can read, so whether it is a checkout of {repository} cannot be checked — bind a checkout cloned from {repository}, or change `source.git.repository` with PUT /api/projects/:id/config",
            path.display()
        );
    };
    let found = remote_place(url, path);
    let same = match (&declared, &found) {
        (Place::Hosted { host: h1, path: p1 }, Some(Place::Hosted { host: h2, path: p2 })) => {
            h1 == h2 && p1 == p2
        }
        (Place::Local(a), Some(Place::Local(b))) => a == b,
        _ => false,
    };
    if !same {
        anyhow::bail!(
            "BIND_SOURCE_HOST_MISMATCH: {} has origin {url} ({}), and project {slug} declares its source at {repository} ({declared}) — bind a checkout whose origin is {repository}, or change `source.git.repository` with PUT /api/projects/:id/config",
            path.display(),
            found.map_or_else(|| "unreadable".to_string(), |p| p.to_string()),
        );
    }
    let Place::Hosted { host, .. } = declared else {
        eprintln!(
            "note: {repository} is a repository on this box's disk, so git reaches it with this box's own access and no credential helper is installed"
        );
        return Ok(None);
    };
    if !url.trim_start().starts_with("https://") {
        eprintln!(
            "note: origin {url} is not HTTPS, so git reaches it with this box's own access (its SSH key) and no Forge credential helper is installed"
        );
        return Ok(None);
    }
    if !assignment.host_credential {
        eprintln!(
            "note: core mints no git credential for {repository}, so no credential helper is installed — attach a source host binding that can mint one, then bind again"
        );
        return Ok(None);
    }
    Ok(Some(host))
}

/// The master skill is written at bind, so a bound project carries it whether
/// or not a master is ever placed for it (ISS-1357). The line printed, and
/// whether it was installed.
fn install_skill(
    slug: &str,
    repo: &std::path::Path,
    dir: Option<&std::path::Path>,
) -> (String, bool) {
    use runner_workspace::master_skill::{install_and_record, Point};
    let outcome = install_and_record(slug, repo, Point::Bind, dir);
    let build = format!(
        "{} ({})",
        runner_update::CURRENT_VERSION,
        runner_update::BUILD_COMMIT
    );
    (
        format!("skill {slug}: {}", outcome.says(Some(repo), &build)),
        outcome.installed(),
    )
}

/// A device-token client for the configured core, or the reason there is none.
pub fn client_for(ctx: &Ctx, cfg: &Config) -> anyhow::Result<CoreClient> {
    let core_url = ctx
        .resolve_core_url(cfg)
        .ok_or_else(|| anyhow::anyhow!("no core URL — run `forge-runner login` first"))?;
    let token = cred_store::load_device_token()?
        .ok_or_else(|| anyhow::anyhow!("no device token — run `forge-runner login` first"))?;
    Ok(CoreClient::new(core_url, token))
}

/// Resolve the project from the slug via the server's assignment list. The
/// device must already be bound to the project on the server (web UI) — we
/// refuse to bind an unassigned slug so a typo can't silently dead-route.
pub async fn assignment_for(client: &CoreClient, slug: &str) -> anyhow::Result<MeRunner> {
    let assignments = runners::list_me(client)
        .await
        .map_err(|e| anyhow::anyhow!("could not fetch device assignments from server: {e}"))?;

    assignments
        .into_iter()
        .find(|r| r.slug == slug)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "slug '{slug}' is not assigned to this device on the server; assign it in the web UI first"
            )
        })
}

/// Write the binding locally and push the path back to the server, so web and
/// CLI read the same field. Returns the path it bound.
pub async fn write_binding(
    client: &CoreClient,
    assignment: &MeRunner,
    slug: &str,
    path: &std::path::Path,
    branch: Option<String>,
) -> anyhow::Result<PathBuf> {
    let mut cfg = Config::load()?;
    let branch = branch.or_else(|| assignment.branch.clone());
    cfg.bindings.insert(
        slug.to_string(),
        Binding {
            repo_path: path.to_path_buf(),
            branch: branch.clone(),
            project_id: Some(assignment.project_id.clone()),
        },
    );
    cfg.save()?;

    // Before the server is asked: the binding is saved from here on, and a
    // refused PATCH must not leave it without the skill.
    let (line, installed) = install_skill(slug, path, config_dir().as_deref());
    if installed {
        println!("{line}");
    } else {
        eprintln!("{line}");
    }

    runners::patch_runner(
        client,
        &assignment.runner_id,
        Some(&path.to_string_lossy()),
        branch.as_deref(),
    )
    .await
    .map_err(|e| anyhow::anyhow!("saved locally, but failed to push path to server: {e}"))?;
    Ok(path.to_path_buf())
}

/// Ask the server to provision this project's workspace and run what it queues.
/// This is the SAME path the daemon takes on a `provision.request`, so a box
/// that ran `bind --clone` and one that was assigned from the web UI end up
/// with the same folder — there is no second clone implementation to drift.
pub async fn provision_checkout(
    client: &CoreClient,
    assignment: &MeRunner,
) -> anyhow::Result<PathBuf> {
    let cfg = Config::load()?;
    let target = assignment
        .repo_path
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| cfg.projects_root.as_ref().map(|r| r.join(&assignment.slug)))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "nowhere to put the checkout: this runner has no repo path on the server and no \
                 `projects_root` is configured. `forge-runner config set projects-root <dir>`, or \
                 pass `--path <dir>` to bind a checkout you already have."
            )
        })?;

    println!("provisioning {} → {}", assignment.slug, target.display());
    provision::reprovision(client, &cfg, &assignment.runner_id).await;

    if !target.join(".git").exists() && !target.exists() {
        anyhow::bail!(
            "provisioning did not leave a workspace at {} — check `forge-runner logs`, or clone it \
             yourself and re-run with `--path`",
            target.display()
        );
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assignment(repository: &str, host_credential: bool) -> MeRunner {
        MeRunner {
            project_id: "p".into(),
            runner_id: "r".into(),
            slug: "epod".into(),
            base_branch: None,
            repo_path: None,
            branch: None,
            status: "online".into(),
            master_policy: None,
            repository: Some(repository.into()),
            host_credential,
            rate_limited_for_seconds: None,
            limit_reason: None,
        }
    }

    fn scratch() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("forge-bind-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(d.join("remotes/epodsystem-core.git")).unwrap();
        std::fs::create_dir_all(d.join("epodsystem-core")).unwrap();
        d
    }

    #[test]
    fn a_local_bare_origin_matching_a_local_path_document_binds() {
        let d = scratch();
        let bare = d.join("remotes/epodsystem-core.git");
        let doc = bare.to_string_lossy().into_owned();
        let checkout = d.join("epodsystem-core");
        let a = assignment(&doc, false);
        assert!(checkout_credential_host("epod", &checkout, &a, Some(&doc)).is_ok());
        let file_url = format!("file://{doc}");
        assert!(checkout_credential_host("epod", &checkout, &a, Some(&file_url)).is_ok());
        // a relative origin is resolved from the checkout, as git resolves it
        assert!(checkout_credential_host(
            "epod",
            &checkout,
            &a,
            Some("../remotes/epodsystem-core.git")
        )
        .is_ok());
    }

    #[test]
    fn an_ssh_origin_matching_an_ssh_or_hosted_document_binds() {
        let checkout = std::env::temp_dir();
        let origin = "git@gitlab.com:sidcorp-internal/webauto.git";
        for doc in [
            "git@gitlab.com:sidcorp-internal/webauto",
            "gitlab.com/sidcorp-internal/webauto",
        ] {
            let got =
                checkout_credential_host("epod", &checkout, &assignment(doc, true), Some(origin));
            assert!(got.is_ok(), "{doc}: {got:?}");
        }
        let ssh_url = "ssh://git@gitlab.com:22/sidcorp-internal/webauto.git";
        assert!(checkout_credential_host(
            "epod",
            &checkout,
            &assignment("gitlab.com/sidcorp-internal/webauto", false),
            Some(ssh_url)
        )
        .is_ok());
    }

    #[test]
    fn a_mismatch_is_refused_by_name_and_never_says_to_repoint_origin() {
        let d = scratch();
        let checkout = d.join("epodsystem-core");
        let local = d
            .join("remotes/epodsystem-core.git")
            .to_string_lossy()
            .into_owned();
        for (doc, origin) in [
            ("gitlab.com/sidcorp-internal/webauto", local.as_str()),
            (
                local.as_str(),
                "git@gitlab.com:sidcorp-internal/webauto.git",
            ),
            (
                "gitlab.com/sidcorp-internal/webauto",
                "https://gitlab.com/someone/else.git",
            ),
        ] {
            let said =
                checkout_credential_host("epod", &checkout, &assignment(doc, true), Some(origin))
                    .err()
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| panic!("{doc} vs {origin} binds"));
            assert!(said.contains("BIND_SOURCE_HOST_MISMATCH"), "{said}");
            assert!(said.contains(doc) && said.contains(origin), "{said}");
            assert!(!said.contains("set-url"), "{said}");
        }
    }

    #[test]
    fn a_checkout_with_no_readable_origin_is_refused_by_name() {
        let checkout = std::env::temp_dir();
        let said = checkout_credential_host(
            "epod",
            &checkout,
            &assignment("gitlab.com/sidcorp-internal/webauto", true),
            None,
        )
        .err()
        .map(|e| e.to_string())
        .expect("refused");
        assert!(said.contains("BIND_ORIGIN_UNREADABLE"), "{said}");
        assert!(!said.contains("set-url"), "{said}");
    }
}
