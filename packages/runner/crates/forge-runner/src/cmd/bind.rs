use std::path::PathBuf;

use clap::Args as ClapArgs;
use forge_runner_core::auth::{cred_store, git_cred};
use forge_runner_core::config::{Binding, Config};
use forge_runner_core::transport::runners::MeRunner;
use forge_runner_core::transport::{runners, CoreClient};
use forge_runner_core::workspace::provision;

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    /// Project slug (as shown in Forge). Must already be assigned to this
    /// device on the server (bind the device in the web UI first).
    pub slug: String,
    /// Path to an EXISTING local checkout (preferred — no re-clone).
    #[arg(long)]
    pub path: Option<PathBuf>,
    /// Deprecated — the project id is now resolved from the slug via
    /// `/me/runners`. Accepted but ignored to avoid breaking older scripts.
    #[arg(long, hide = true)]
    pub project_id: Option<String>,
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

    if args.project_id.is_some() {
        eprintln!(
            "note: --project-id is deprecated and ignored; the project is resolved from the slug via the server."
        );
    }
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

/// The host of a git remote in any of its forms — `https://host/…`, `ssh://user@host:port/…`,
/// `user@host:path` — lower-cased and without a port.
fn remote_host(url: &str) -> Option<String> {
    let url = url.trim();
    let authority = match url.split_once("://") {
        Some((_, rest)) => rest.split('/').next()?,
        None => url.split_once(':')?.0,
    };
    let host = authority.rsplit('@').next()?;
    let host = host.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

// cm:why `--clone` gets its helper from the provision; a checkout bound by `--path` gets the same
// one here, for the host the project document declares — and only once its origin is that host
/// The host to point this checkout's credential helper at, `None` where core mints no credential
/// for the project, or a refusal naming both hosts when the checkout's origin is another host's.
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
    let declared = repository
        .split('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    match origin {
        Some(url) => {
            let found = remote_host(url);
            if found.as_deref() != Some(declared.as_str()) {
                anyhow::bail!(
                    "BIND_SOURCE_HOST_MISMATCH: {} has origin {url} (host {}), and project {slug} declares its source at {repository} (host {declared}) — bind a checkout of {repository}, or fix `origin` with `git -C {} remote set-url origin https://{repository}.git`",
                    path.display(),
                    found.as_deref().unwrap_or("unreadable"),
                    path.display()
                );
            }
            if !url.trim_start().starts_with("https://") && assignment.host_credential {
                eprintln!(
                    "note: origin {url} is not HTTPS, so git will not ask the credential helper for it until origin is https://{repository}.git"
                );
            }
        }
        None => eprintln!(
            "warning: {} has no `origin` remote, so its host could not be checked against {repository}",
            path.display()
        ),
    }
    if !assignment.host_credential {
        eprintln!(
            "note: core mints no git credential for {repository}, so no credential helper is installed — attach a source host binding that can mint one, then bind again"
        );
        return Ok(None);
    }
    Ok(Some(declared))
}

fn config_dir() -> Option<PathBuf> {
    forge_runner_core::daemon::control::config_dir()
}

/// The master skill is written at bind, so a bound project carries it whether
/// or not a master is ever placed for it (ISS-1357). The line printed, and
/// whether it was installed.
fn install_skill(
    slug: &str,
    repo: &std::path::Path,
    dir: Option<&std::path::Path>,
) -> (String, bool) {
    use forge_runner_core::daemon::master_skill::{install_and_record, Point};
    let outcome = install_and_record(slug, repo, Point::Bind, dir);
    let build = format!(
        "{} ({})",
        forge_runner_core::update::CURRENT_VERSION,
        forge_runner_core::update::BUILD_COMMIT
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

    fn assigned(repository: Option<&str>, host_credential: bool) -> MeRunner {
        MeRunner {
            project_id: "p".into(),
            runner_id: "r".into(),
            slug: "autoflow".into(),
            base_branch: None,
            repo_path: None,
            branch: None,
            status: "online".into(),
            workspace_setup: None,
            master_policy: None,
            repository: repository.map(str::to_string),
            host_credential,
            rate_limited_for_seconds: None,
            limit_reason: None,
        }
    }

    #[test]
    fn a_remote_names_its_host_in_every_form() {
        assert_eq!(
            remote_host("https://gitlab.com/acme/app.git").as_deref(),
            Some("gitlab.com")
        );
        assert_eq!(
            remote_host("https://tok@GitLab.com/acme/app").as_deref(),
            Some("gitlab.com")
        );
        assert_eq!(
            remote_host("git@gitlab.com:acme/app.git").as_deref(),
            Some("gitlab.com")
        );
        assert_eq!(
            remote_host("ssh://git@git.example.co:2222/acme/app.git").as_deref(),
            Some("git.example.co")
        );
        assert_eq!(remote_host("/srv/repos/app.git"), None);
    }

    #[test]
    fn a_checkout_of_the_declared_host_gets_its_helper() {
        let a = assigned(Some("gitlab.com/acme/app"), true);
        let host = checkout_credential_host(
            "autoflow",
            std::path::Path::new("/w"),
            &a,
            Some("https://gitlab.com/acme/app.git"),
        )
        .unwrap();
        assert_eq!(host.as_deref(), Some("gitlab.com"));
    }

    #[test]
    fn a_checkout_of_another_host_is_refused_by_name() {
        let a = assigned(Some("gitlab.com/acme/app"), true);
        let err = checkout_credential_host(
            "autoflow",
            std::path::Path::new("/w"),
            &a,
            Some("git@github.com:acme/app.git"),
        )
        .unwrap_err()
        .to_string();
        assert!(err.starts_with("BIND_SOURCE_HOST_MISMATCH: "), "{err}");
        assert!(
            err.contains("github.com") && err.contains("gitlab.com/acme/app"),
            "{err}"
        );
    }

    #[test]
    fn no_helper_where_core_mints_nothing_or_declares_no_repository() {
        let p = std::path::Path::new("/w");
        let origin = Some("https://gitlab.com/acme/app.git");
        let none = checkout_credential_host(
            "a",
            p,
            &assigned(Some("gitlab.com/acme/app"), false),
            origin,
        );
        assert_eq!(none.unwrap(), None);
        assert_eq!(
            checkout_credential_host("a", p, &assigned(None, true), origin).unwrap(),
            None
        );
    }

    #[test]
    fn bind_path_installs_the_helper_into_the_checkout() {
        let scratch = Scratch::new("bind-helper");
        let repo = scratch.path().join("app");
        git_checkout(&repo, true);
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["remote", "add", "origin", "https://gitlab.com/acme/app.git"])
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let a = assigned(Some("gitlab.com/acme/app"), true);
        let host = checkout_credential_host("autoflow", &repo, &a, origin_url(&repo).as_deref())
            .unwrap()
            .unwrap();
        git_cred::set_repo_credential_helper(&repo, &host).unwrap();
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args([
                "config",
                "--local",
                "--get-all",
                "credential.https://gitlab.com.helper",
            ])
            .output()
            .unwrap();
        let helpers = String::from_utf8_lossy(&out.stdout);
        assert!(helpers.contains("git-credential"), "{helpers}");
    }
    use forge_runner_core::daemon::master_skill::{self, path_in, Outcome, Read, ASSET};
    use forge_runner_core::test_scratch::Scratch;

    fn git_checkout(dir: &std::path::Path, ignores: bool) {
        std::fs::create_dir_all(dir).unwrap();
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["init", "-q"])
            .env_remove("GIT_DIR")
            .status()
            .unwrap()
            .success();
        assert!(ok);
        if ignores {
            std::fs::write(dir.join(".gitignore"), ".claude/\n").unwrap();
        }
    }

    #[test]
    fn bind_writes_the_skill_and_says_so() {
        let s = Scratch::new("bind-skill");
        let repo = s.path().join("repo");
        git_checkout(&repo, true);
        let cfg = s.path().join("cfg");

        let (line, installed) = install_skill("acme", &repo, Some(&cfg));

        assert!(installed, "{line}");
        assert!(line.starts_with("skill acme: written by "), "{line}");
        assert_eq!(std::fs::read_to_string(path_in(&repo)).unwrap(), ASSET);
        let Read::Record(r) = master_skill::read(&cfg) else {
            panic!("bind recorded nothing")
        };
        let lines: Vec<_> = r.of("acme").map(|e| (&e.outcome, e.point)).collect();
        assert_eq!(lines, [(&Outcome::Written, master_skill::Point::Bind)]);
    }

    /// Owner, 2026-09-30: a checkout that merely does not ignore `.claude/`
    /// gets it in its exclude file and the skill.
    #[test]
    fn bind_into_a_checkout_that_does_not_ignore_it_excludes_and_writes() {
        let s = Scratch::new("bind-skill-open");
        let repo = s.path().join("repo");
        git_checkout(&repo, false);

        let (line, installed) = install_skill("acme", &repo, Some(&s.path().join("cfg")));

        assert!(installed, "{line}");
        assert_eq!(std::fs::read_to_string(path_in(&repo)).unwrap(), ASSET);
        assert!(
            std::fs::read_to_string(repo.join(".git").join("info").join("exclude"))
                .unwrap()
                .lines()
                .any(|l| l == ".claude/")
        );
    }

    #[test]
    fn bind_into_a_checkout_whose_own_rule_un_ignores_it_writes_nothing_and_says_why() {
        let s = Scratch::new("bind-skill-negated");
        let repo = s.path().join("repo");
        git_checkout(&repo, false);
        std::fs::write(repo.join(".gitignore"), "!.claude/\n!.claude/**\n").unwrap();

        let (line, installed) = install_skill("acme", &repo, Some(&s.path().join("cfg")));

        assert!(!installed);
        assert!(
            line.contains("NOT WRITTEN") && line.contains("does not ignore"),
            "{line}"
        );
        assert!(!repo.join(".claude").exists());
    }

    /// Review 294dd5's successor F1: the binding is saved before the server is
    /// asked, so the skill is installed between the two, and a refused PATCH
    /// leaves a saved binding that already carries it.
    #[test]
    fn the_skill_is_installed_after_the_save_and_before_the_server_is_asked() {
        static SRC: std::sync::LazyLock<&str> = std::sync::LazyLock::new(|| {
            forge_runner_core::test_scratch::lf(include_str!("bind.rs"))
        });
        let body = SRC
            .split("\npub async fn write_binding(")
            .nth(1)
            .and_then(|r| r.split("\n}\n").next())
            .expect("write_binding");
        let at = |n: &str| {
            body.find(n)
                .unwrap_or_else(|| panic!("`{n}` in write_binding"))
        };
        assert!(at("cfg.save()?;") < at("install_skill(slug, path,"));
        assert!(at("install_skill(slug, path,") < at("runners::patch_runner("));
    }
}
