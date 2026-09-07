//! Build a temp MCP config file for a job run.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::auth::cred_store::load_pat;
use crate::error::{Error, Result};

/// Write `{ mcpServers: { forge: <http>, ...override } }` to a temp file and
/// return its path. The Forge server points at `<core>/mcp` and authenticates
/// with the BOX'S OWN agent credential + project slug header.
///
/// Core mints no per-job credential since ISS-932 wave 4, so there is exactly
/// one credential on the box and `load_pat` is the only source.
///
/// When the box holds none the `forge` entry is OMITTED and a warning names why.
/// The device token is deliberately NOT a fallback: `/mcp` refuses it (ISS-931),
/// so writing it would buy a 401 at the first tool call instead of an absent
/// server at startup, and the 401 arrives with no line naming the writer.
// cm:edge contract -> packages/core/src/middleware/require-pat.ts — `requirePat` accepts `forge_pat_*` and refuses every other bearer BY NAME; the refusal text tells a box reading it to install a newer forge-runner, and this function is what makes that upgrade the fix
// cm:guard NEVER fall back to `device_token` here. It authenticates `/ws` and the `requireDevice` REST routes and nothing on `/mcp`, and a config carrying it is indistinguishable at startup from a working one — `claude` connects, `tools/list` 401s, and the session reads it as a core outage.
pub fn write(
    core_url: &str,
    project_slug: &str,
    job_id: &str,
    override_servers: Option<&Value>,
) -> Result<PathBuf> {
    write_in(
        &mcp_config_dir(),
        core_url,
        project_slug,
        job_id,
        override_servers,
    )
}

/// [`write`] with the directory named rather than resolved.
///
/// The seam exists for the tests. The file NAME is the property two of them
/// assert — it is stable, derived from slug and job id, never a uuid — so it
/// cannot be randomised to make a run independent of every other run on the
/// box. Isolation has to come from the directory instead: with a single shared
/// one, two `cargo test --workspace` runs write the same path and the loser
/// panics on a file the winner already unlinked, which reads as a defect in the
/// config writer rather than as two runs colliding (ISS-939).
// cm:guard tests pass a directory of their own; production passes `mcp_config_dir()` and nothing else. A test that reaches this through `write` is back on the shared path and will fail somebody else's run instead of its own.
fn write_in(
    dir: &Path,
    core_url: &str,
    project_slug: &str,
    job_id: &str,
    override_servers: Option<&Value>,
) -> Result<PathBuf> {
    let mcp_url = format!("{}/mcp", core_url.trim_end_matches('/'));
    let token = load_pat().ok().flatten();
    let mut servers = match token.as_deref() {
        Some(t) => serde_json::json!({
            "forge": {
                "type": "http",
                "url": mcp_url,
                "headers": {
                    "Authorization": format!("Bearer {t}"),
                    "X-Forge-Project-Slug": project_slug
                }
            }
        }),
        None => {
            tracing::warn!(
                job_id,
                "mcp config: this box holds no agent credential — omitting the `forge` MCP \
                 server. Tools that only exist there (forge_uploads, forge_step_start) will be \
                 absent for this job; run `forge-runner login` to pair the box."
            );
            serde_json::json!({})
        }
    };

    if let Some(extra) = override_servers {
        if let (Some(base), Some(extra)) = (servers.as_object_mut(), extra.as_object()) {
            for (name, cfg) in extra {
                // ISS-683 belt-and-suspenders: a non-object entry (e.g. a
                // catalog-shorthand `true` that failed to expand upstream)
                // is not a valid MCP server spec — writing it verbatim would
                // silently break that server's `claude --mcp-config` parse.
                // Skip and warn rather than propagate an invalid entry.
                if !cfg.is_object() {
                    tracing::warn!(
                        "mcp config: skipping non-object override entry for server={name} (expected an object spec)"
                    );
                    continue;
                }
                let enabled = cfg.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                if enabled {
                    base.insert(name.clone(), cfg.clone());
                }
            }
        }
    }

    let doc = serde_json::json!({ "mcpServers": servers });

    // The runner keeps all its state under `~/.config/forge-runner/` (credentials,
    // config, skills-cache); the per-job MCP config lives beside them in `mcp/`,
    // never as a UUID in the shared `/tmp` root.
    // cm:guard one file per JOB, not per slug, and the unlink at completion is why. A shared per-slug path was safe only while the repo-root lock serialised same-project spawns through `runner.start`; ISS-920 released that lock earlier on purpose, so a sibling's completion would unlink the path this job is about to hand `claude` — read back as `agent_startup_failed: MCP config file not found`.
    sweep_stale(dir);
    let path = dir.join(format!(
        "forge-mcp-{}-{}.json",
        sanitize_slug(project_slug),
        sanitize_slug(job_id)
    ));
    let body = serde_json::to_string_pretty(&doc).map_err(|e| Error::Other(e.to_string()))?;
    // cm:guard write-then-rename, never a bare `fs::write`: that truncates first, so a reader opening the path mid-write gets a partial document and `claude` reports an invalid MCP config with nothing naming the writer. UNTESTED and untestable in this suite — the difference is only visible to a concurrent reader, and a test that races is a test that lies either way. It is here on the argument, not on a green.
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    std::fs::write(&tmp, body)?;
    restrict_perms(&tmp); // the file carries a bearer token — 0600 it
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// Age past which an MCP config left behind by a crashed daemon is removed.
const MCP_CONFIG_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Drop MCP configs no live job can own.
// cm:guard the per-job path costs this sweep, and the sweep is the whole reason a per-job path is affordable: every spawn unlinks its own file at completion and on a spawn failure, so anything left is a daemon that died between the two, and without this the folder grows one token-bearing 0600 file per crash forever. Since ISS-931 the token in there is the JOB's, revoked when the job ends, so a leaked file ages out of usefulness as well as off disk — the sweep is still what keeps the disk bounded. 24h is NOT slack over the longest live job — `timeoutSeconds` reaches exactly 86_400 and a parked duplex session adds its residency on top. It is safe because `claude` reads `--mcp-config` at startup only, so unlinking under a running session costs nothing; a future that re-reads it makes this number wrong.
fn sweep_stale(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t.elapsed().is_ok_and(|age| age > MCP_CONFIG_MAX_AGE))
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Dedicated folder for the runner's per-job MCP configs:
/// `~/.config/forge-runner/mcp/`. Falls back to `<tmp>/forge-runner/mcp/` only
/// when no config dir is resolvable. Created on demand; best-effort `0700`.
fn mcp_config_dir() -> PathBuf {
    let base = dirs_next::config_dir()
        .map(|d| d.join("forge-runner"))
        .unwrap_or_else(|| std::env::temp_dir().join("forge-runner"));
    let dir = base.join("mcp");
    let _ = std::fs::create_dir_all(&dir);
    restrict_dir_perms(&dir);
    dir
}

/// Sanitize a project slug into a filesystem-safe token. Non `[A-Za-z0-9_-]`
/// chars become `-`; an empty / all-stripped slug falls back to `default`, so
/// the runner still resolves to a single stable path.
fn sanitize_slug(slug: &str) -> String {
    let cleaned: String = slug
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "default".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Restrict the MCP folder to owner-only (`0700`). Best-effort; no-op on non-unix.
#[cfg(unix)]
fn restrict_dir_perms(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
}
#[cfg(not(unix))]
fn restrict_dir_perms(_dir: &Path) {}

/// Restrict the config file to owner-only (`0600`) — it carries a bearer token.
/// Best-effort; no-op on non-unix.
#[cfg(unix)]
fn restrict_perms(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn restrict_perms(_path: &Path) {}

/// Write a persistent `<repo>/.mcp.json` wiring the project's Forge MCP server
/// so a human running `claude` in the provisioned folder can talk to Forge out
/// of the box. Distinct from [`write`], which is the per-job temp config (it
/// also merges integration overrides with fresh tokens).
///
/// Authed by the OPERATOR'S PAT — the credential a human can actually hold —
/// and never by the box's device token, which `/mcp` refuses (ISS-931), nor by
/// a machine-minted job token, which belongs to one job and is revoked when it
/// ends. With no stored PAT the `forge` entry is left ALONE rather than written
/// with something that cannot work: whatever is already in the file (possibly a
/// working hand-written entry) survives, and the warning names the fix.
///
/// READ-MERGE, not overwrite: any servers a human (or another tool) added to an
/// existing `.mcp.json` are preserved; only the `forge` entry is upserted
/// (overridden on key collision). A missing/empty file is created fresh; a file
/// that exists but isn't valid JSON / isn't an object is left untouched and an
/// error is returned, so we never clobber a user's hand-written config.
///
/// The file carries a bearer token, so we add it to `.git/info/exclude` (NOT
/// the tracked `.gitignore`) to guarantee it's never committed. Idempotent.
// cm:guard read the PAT through `cred_store::load_pat`, never take a token as a parameter. That helper is the ONE place `$FORGE_PAT` and the stored credential are resolved in one order (see its own guard), and a parameter here is how the provisioned folder would start honouring a different credential from `forge-runner api` on the same box.
pub fn write_persistent(repo_path: &Path, core_url: &str, project_slug: &str) -> Result<()> {
    let mcp_url = format!("{}/mcp", core_url.trim_end_matches('/'));
    let Some(pat) = load_pat().ok().flatten() else {
        tracing::warn!(
            project_slug,
            "mcp config: no stored PAT — leaving the `forge` entry in the provisioned \
             .mcp.json alone. Run `forge-runner login --pat <token>` so a human running \
             `claude` in this folder reaches Forge."
        );
        return Ok(());
    };
    let forge_server = serde_json::json!({
        "type": "http",
        "url": mcp_url,
        "headers": {
            "Authorization": format!("Bearer {pat}"),
            "X-Forge-Project-Slug": project_slug
        }
    });

    let path = repo_path.join(".mcp.json");

    // Start from the existing doc when present so other servers survive. A
    // malformed existing file is a refuse-to-clobber situation, not a reset.
    let mut doc = match std::fs::read_to_string(&path) {
        Ok(existing) if !existing.trim().is_empty() => {
            serde_json::from_str::<Value>(&existing).map_err(|e| {
                Error::Other(format!(
                    ".mcp.json exists but is not valid JSON ({e}); refusing to overwrite — fix or remove it, then re-provision"
                ))
            })?
        }
        _ => serde_json::json!({}),
    };
    let root = doc.as_object_mut().ok_or_else(|| {
        Error::Other(".mcp.json top-level value is not an object; refusing to overwrite".into())
    })?;

    // Ensure `mcpServers` is an object, then upsert `forge` (override on collision).
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() {
        *servers = serde_json::json!({});
    }
    servers
        .as_object_mut()
        .expect("mcpServers coerced to object above")
        .insert("forge".to_string(), forge_server);

    let body = serde_json::to_string_pretty(&doc).map_err(|e| Error::Other(e.to_string()))?;
    std::fs::write(&path, body)?;
    ensure_git_excluded(repo_path, ".mcp.json");
    Ok(())
}

/// Append `entry` to `<repo>/.git/info/exclude` if not already present. Touches
/// only the local-untracked excludes, never the repo's committed `.gitignore`.
fn ensure_git_excluded(repo_path: &Path, entry: &str) {
    let info = repo_path.join(".git").join("info");
    if std::fs::create_dir_all(&info).is_err() {
        return; // not a git repo (or no perms) — best-effort
    }
    let exclude = info.join("exclude");
    let current = std::fs::read_to_string(&exclude).unwrap_or_default();
    if current.lines().any(|l| l.trim() == entry) {
        return;
    }
    let sep = if current.is_empty() || current.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    let _ = std::fs::write(&exclude, format!("{current}{sep}{entry}\n"));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_repo(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("forge-mcp-persist-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A config directory belonging to this process alone.
    // cm:guard every test that writes a per-job config takes one of these and calls `write_in`. The path `write` resolves is `~/.config/forge-runner/mcp/`, shared by every run on the box AND by the operator's own daemon, so a test on it deletes a sibling run's file — measured 2026-09-06 as `write_uses_a_stable_named_path_not_a_uuid ... FAILED` under two concurrent `cargo test --workspace` runs, 311 passed serially (ISS-939). The pid is the isolation; the file name inside stays stable, which is the property these tests are for.
    fn tmp_mcp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("forge-mcp-cfg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read_doc(repo: &Path) -> Value {
        let s = std::fs::read_to_string(repo.join(".mcp.json")).unwrap();
        serde_json::from_str(&s).unwrap()
    }

    /// The provisioned folder is for a human, and the box's device token is not
    /// a credential a human holds — `/mcp` refuses it outright (ISS-931). With
    /// no operator PAT the existing entry is left alone rather than replaced by
    /// something that answers 401.

    #[test]
    fn sanitizes_slug_to_fs_safe_token() {
        assert_eq!(
            sanitize_slug("home-kieutrung-anhome"),
            "home-kieutrung-anhome"
        );
        assert_eq!(sanitize_slug("a/b c.d"), "a-b-c-d");
        assert_eq!(sanitize_slug(""), "default");
        assert_eq!(sanitize_slug("///"), "default");
    }

    #[test]
    fn write_uses_a_stable_named_path_not_a_uuid() {
        let slug = "forge-test-stable-slug-xyz";
        let dir = tmp_mcp_dir("stable");
        let p1 = write_in(&dir, "https://core.example", slug, "job-a", None).unwrap();
        let p2 = write_in(&dir, "https://core.example", slug, "job-a", None).unwrap();
        assert_eq!(p1, p2, "the same job must resolve to the same path");
        assert_eq!(
            p1.file_name().unwrap().to_str().unwrap(),
            "forge-mcp-forge-test-stable-slug-xyz-job-a.json"
        );
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&p1).unwrap()).unwrap();
        assert_eq!(
            doc["mcpServers"]["forge"]["url"],
            "https://core.example/mcp"
        );
        let _ = std::fs::remove_file(&p1);
    }

    /// The file name is stable and the directory is not, which is the whole of
    /// ISS-939: two `cargo test --workspace` runs on one box must not resolve to
    /// the same path, while the name inside each run stays derived from the slug
    /// and job id rather than randomised.
    // cm:guard assert BOTH halves in one test. Asserting only the stable name leaves a suite that passes while every run shares a path; asserting only that the paths differ would pass against the uuid naming this file exists to refuse.
    #[test]
    fn the_directory_isolates_runs_and_the_file_name_stays_stable() {
        let one = tmp_mcp_dir("iso-one");
        let two = tmp_mcp_dir("iso-two").join("second");
        std::fs::create_dir_all(&two).unwrap();

        let a = write_in(&one, "https://core.example", "iso", "job-a", None).unwrap();
        let b = write_in(&two, "https://core.example", "iso", "job-a", None).unwrap();

        assert_ne!(a, b, "two runs must not write the same path");
        assert_eq!(a.file_name(), b.file_name());
        assert_eq!(
            a.file_name().unwrap().to_str().unwrap(),
            "forge-mcp-iso-job-a.json"
        );

        std::fs::remove_file(&a).unwrap();
        assert!(
            b.exists(),
            "one run's cleanup must not unlink another run's file"
        );
        let _ = std::fs::remove_dir_all(&one);
        let _ = std::fs::remove_dir_all(&two);
    }

    /// Two jobs on one project overlap inside `runner.start` since ISS-920, and
    /// each unlinks its config when it finishes. A shared path would let the
    /// first one home delete the file the second is about to hand `claude`.
    #[test]
    fn two_jobs_on_one_project_do_not_share_a_config_file() {
        let slug = "forge-test-two-jobs";
        let dir = tmp_mcp_dir("two-jobs");
        let a = write_in(&dir, "https://core.example", slug, "job-a", None).unwrap();
        let b = write_in(&dir, "https://core.example", slug, "job-b", None).unwrap();
        assert_ne!(a, b);
        let _ = std::fs::remove_file(&a);
        assert!(
            b.exists(),
            "one job's completion must not unlink another job's config"
        );
        let _ = std::fs::remove_file(&b);
    }

    #[test]
    fn skips_non_object_override_entry() {
        // ISS-683 — a boolean override entry (e.g. an unexpanded catalog
        // shorthand) must never be written verbatim; a valid sibling entry
        // still comes through.
        let overrides = serde_json::json!({
            "chrome-devtools-mcp": true,
            "playwright": { "type": "stdio", "command": "npx" },
        });
        let path = write_in(
            &tmp_mcp_dir("skip-non-object"),
            "https://core.example",
            "skip-non-object-slug",
            "job-skip",
            Some(&overrides),
        )
        .unwrap();
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(doc["mcpServers"]["chrome-devtools-mcp"].is_null());
        assert_eq!(doc["mcpServers"]["playwright"]["command"], "npx");
        let _ = std::fs::remove_file(&path);
    }

    /// ONE test for everything that reads the credential store, because the
    /// store resolves process-wide env and cargo runs tests in threads — the
    /// same reason `auth/cred_store.rs` states above its own single case. The
    /// lock is shared with that module; the cases below are ordered, not
    /// independent.
    // cm:guard hold `ENV_TEST_LOCK` for the WHOLE body and never split these into separate `#[test]`s. `load_pat` reads `$FORGE_PAT` first, so two tests setting it are two tests reading each other's value — measured as four simultaneous failures the first time they were written apart (ISS-931).
    #[test]
    fn credential_store_paths() {
        let _env = crate::auth::cred_store::ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        std::env::set_var("FORGE_PAT", "forge_pat_dev_operator");

        // -- the provisioned folder is authed by the operator's PAT --
        let repo = tmp_repo("fresh");
        write_persistent(&repo, "https://core.example/", "proj").unwrap();
        let forge = read_doc(&repo)["mcpServers"]["forge"].clone();
        assert_eq!(forge["type"], "http");
        assert_eq!(forge["url"], "https://core.example/mcp");
        assert_eq!(
            forge["headers"]["Authorization"],
            "Bearer forge_pat_dev_operator"
        );
        assert_eq!(forge["headers"]["X-Forge-Project-Slug"], "proj");
        let _ = std::fs::remove_dir_all(&repo);

        // cm:guard assert the header VALUE, not merely that a `forge` entry exists. The entry existed before ISS-932 wave 4 too, carrying first the device token and then a per-job one; a presence-only assertion stays green against exactly the config `requirePat` refuses.
        let path = write_in(
            &tmp_mcp_dir("box-cred"),
            "https://core.example",
            "box-cred-slug",
            "job-tok",
            None,
        )
        .unwrap();
        let per_job: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            per_job["mcpServers"]["forge"]["headers"]["Authorization"],
            "Bearer forge_pat_dev_operator"
        );
        let _ = std::fs::remove_file(&path);

        // -- read-merge: a human's other servers survive --
        let repo = tmp_repo("merge");
        std::fs::write(
            repo.join(".mcp.json"),
            r#"{"mcpServers":{"playwright":{"type":"stdio","command":"npx"}}}"#,
        )
        .unwrap();
        write_persistent(&repo, "https://core.example", "proj").unwrap();
        let doc = read_doc(&repo);
        assert_eq!(doc["mcpServers"]["playwright"]["command"], "npx");
        assert_eq!(
            doc["mcpServers"]["forge"]["url"],
            "https://core.example/mcp"
        );
        let _ = std::fs::remove_dir_all(&repo);

        // -- an existing `forge` entry is replaced, siblings are not --
        let repo = tmp_repo("override");
        std::fs::write(
            repo.join(".mcp.json"),
            r#"{"mcpServers":{"forge":{"type":"http","url":"https://stale/mcp"},"other":{"x":1}}}"#,
        )
        .unwrap();
        write_persistent(&repo, "https://fresh.example", "proj2").unwrap();
        let doc = read_doc(&repo);
        assert_eq!(
            doc["mcpServers"]["forge"]["url"],
            "https://fresh.example/mcp"
        );
        assert_eq!(doc["mcpServers"]["other"]["x"], 1);
        let _ = std::fs::remove_dir_all(&repo);

        // -- a malformed file is never clobbered --
        let repo = tmp_repo("malformed");
        std::fs::write(repo.join(".mcp.json"), "{ not json").unwrap();
        let err = write_persistent(&repo, "https://core.example", "proj").unwrap_err();
        assert!(format!("{err}").contains("not valid JSON"));
        assert_eq!(
            std::fs::read_to_string(repo.join(".mcp.json")).unwrap(),
            "{ not json"
        );
        let _ = std::fs::remove_dir_all(&repo);

        // -- a box against an older core: no job token on the frame, the
        //    operator's PAT stands in. This is what lets core and the fleet
        //    upgrade in either order.
        let path = write_in(
            &tmp_mcp_dir("fallback"),
            "https://core.example",
            "fallback-slug",
            "job-fb",
            None,
        )
        .unwrap();
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            doc["mcpServers"]["forge"]["headers"]["Authorization"],
            "Bearer forge_pat_dev_operator"
        );
        let _ = std::fs::remove_file(&path);

        // -- a blank token is the shape a frame carries when core could not
        //    mint; treat it as absent, never write `Bearer `.
        let path = write_in(
            &tmp_mcp_dir("blank"),
            "https://core.example",
            "blank-slug",
            "job-blank",
            None,
        )
        .unwrap();
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            doc["mcpServers"]["forge"]["headers"]["Authorization"],
            "Bearer forge_pat_dev_operator"
        );
        let _ = std::fs::remove_file(&path);

        // -- with NO credential at all the `forge` server is ABSENT and the
        //    sibling overrides still come through. Writing an unusable bearer
        //    would buy a 401 at the first tool call with nothing naming the
        //    writer; the provisioned folder likewise keeps whatever was there.
        std::env::set_var("FORGE_PAT", "");
        std::env::set_var("FORGE_RUNNER_CRED_STORE", "file");
        let empty = std::env::temp_dir().join(format!("forge-mcp-nocred-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&empty);
        std::fs::create_dir_all(&empty).unwrap();
        std::env::set_var("XDG_CONFIG_HOME", &empty);

        let overrides = serde_json::json!({
            "playwright": { "type": "stdio", "command": "npx" },
        });
        let path = write_in(
            &tmp_mcp_dir("no-cred"),
            "https://core.example",
            "no-cred-slug",
            "job-nocred",
            Some(&overrides),
        )
        .unwrap();
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(doc["mcpServers"]["forge"].is_null());
        assert_eq!(doc["mcpServers"]["playwright"]["command"], "npx");
        let _ = std::fs::remove_file(&path);

        let repo = tmp_repo("no-pat");
        std::fs::write(
            repo.join(".mcp.json"),
            r#"{"mcpServers":{"forge":{"type":"http","url":"https://hand-written/mcp"}}}"#,
        )
        .unwrap();
        write_persistent(&repo, "https://core.example", "proj").unwrap();
        assert_eq!(
            read_doc(&repo)["mcpServers"]["forge"]["url"],
            "https://hand-written/mcp"
        );
        let _ = std::fs::remove_dir_all(&repo);

        let _ = std::fs::remove_dir_all(&empty);
        std::env::remove_var("FORGE_PAT");
        std::env::remove_var("XDG_CONFIG_HOME");
        std::env::remove_var("FORGE_RUNNER_CRED_STORE");
    }
}
