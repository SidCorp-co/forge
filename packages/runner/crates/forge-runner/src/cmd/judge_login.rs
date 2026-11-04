//! `forge-runner judge-login <profile> <actor>`: sign in as one actor of the testing profile and
//! hand the judge only the session (ISS-959).
//!
//! FB-464 (catalog-api qa runs 94ef974e and 575d3ace, 2026-11-01): judges read the testing-secrets
//! route with `forge-runner api`, which prints the body, and twice the values reached their
//! transcripts. This command then wrote the one secret to a 0600 file, and the judge had to open it,
//! learn its shape and send the password itself — the act every brief forbids, and on 2026-11-04 two
//! judges printed fragments of it doing so (ISS-959). Now the secret is read the same way `api` reads
//! it — the pane's checkout credential, `self` named as the run declared over this checkout — and is
//! spent inside this process: [`session`] signs in at the deployment the run judges and writes only
//! the session. No file holds the password, and the line printed names paths, never contents.
//!
//! A `--service` is refused by name: a service's credential (an API key, a database login) is the
//! key itself, not a sign-in, and cannot be narrowed to a session; writing it to a file is the defect
//! this command was rebuilt to remove.

mod session;

use std::path::{Path, PathBuf};

use clap::Args as ClapArgs;
use runner_core::judge_dir;
use runner_core::ledger::Ledger;
use serde_json::Value;

use super::api::{get_json, rest_client, run_self};
use super::Ctx;
use session::{Session, SessionFiles};

/// Sign in as one actor of a testing profile and write only the session: a header line for
/// `curl -H @<file>` and a Playwright storage state. Prints their paths, never a value.
#[derive(ClapArgs)]
pub struct Args {
    /// The testing profile the environment you judge names (`environments.<env>.testing`).
    pub profile: String,
    /// The actor of that profile to sign in as, as the profile declares it (`GET
    /// /api/projects/<id>/testing-profiles/<profile>` lists them).
    pub actor: Option<String>,
    /// Refused: a service's credential is the key itself, not a sign-in, and is never written to a
    /// file.
    #[arg(long, conflicts_with = "actor")]
    pub service: Option<String>,
    /// The run to read as; default `self`, the run declared over this checkout.
    #[arg(long, default_value = "self")]
    pub run: String,
    /// Directory to write the session into (created 0700); default a `forge-judge-<run>` directory
    /// under the system temp dir, outside every checkout. The directory is recorded on the run and
    /// its close removes it; an `--out-dir` is recorded only when it is named `forge-judge-<run>`.
    #[arg(long)]
    pub out_dir: Option<PathBuf>,
}

/// A profile or actor name as core declares them: a letter, then letters, digits and `-`.
fn valid_name(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && s.len() <= 63
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The actor the arguments name, or the line refusing them. A service is refused before anything is
/// read, so no read of its key is made or audited.
pub(crate) fn named(
    profile: &str,
    actor: Option<&str>,
    service: Option<&str>,
    run: &str,
) -> Result<String, String> {
    if !valid_name(profile) {
        return Err(format!(
            "profile `{profile}` is no profile name: a letter, then letters, digits or `-`"
        ));
    }
    if run != "self" && !(run.len() == 36 && run.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
    {
        return Err(format!(
            "--run `{run}` is neither `self` nor a run id (a uuid)"
        ));
    }
    let actor =
        match (actor, service) {
            (Some(a), None) => a,
            (None, Some(s)) => {
                return Err(format!(
                    "--service `{s}` names a service's credential, which is the key itself and no \
                 sign-in; judge-login hands a judge only a session and writes no key to a file. \
                 Nothing was read or written"
                ))
            }
            _ => return Err(
                "name the one actor to sign in as (`judge-login <profile> <actor>`); a read is \
                 never handed the whole profile"
                    .to_string(),
            ),
        };
    if !valid_name(actor) {
        return Err(format!(
            "`{actor}` is no actor name: a letter, then letters, digits or `-`"
        ));
    }
    Ok(actor.to_string())
}

/// The read's path, before `self` is named as a run.
pub(crate) fn secret_path(profile: &str, run: &str, actor: &str) -> String {
    format!("/api/jobs/{run}/testing-profiles/{profile}/secrets?actor={actor}")
}

/// The one secret's value in core's answer, or the line saying what came back instead.
pub(crate) fn secret_of(answer: &Value) -> Result<&str, String> {
    let secrets = answer
        .get("secrets")
        .and_then(Value::as_array)
        .ok_or("core answered no `secrets` list")?;
    let [secret] = secrets.as_slice() else {
        return Err(format!(
            "core answered {} secrets for one name; nothing was written",
            secrets.len()
        ));
    };
    secret
        .get("value")
        .and_then(Value::as_str)
        .ok_or_else(|| "core's secret carries no `value`; nothing was written".to_string())
}

/// Sign in with the secret core answered and write the session into `dir`. Every refusal comes
/// before the first write, so a refused sign-in leaves nothing on disk.
pub(crate) async fn login_into(
    answer: &Value,
    dir: &Path,
    profile: &str,
    actor: &str,
) -> Result<(SessionFiles, Session), String> {
    let secret = session::parse_secret(secret_of(answer)?)?;
    let deployment = session::deployment_of(answer);
    let url = session::sign_in_url(secret.route(), deployment.as_ref())?;
    let signed_in = session::sign_in(&secret, &url, deployment.as_ref()).await?;
    drop(secret);
    let files = session::write_session(dir, profile, actor, &signed_in).map_err(|e| {
        format!(
            "the session could not be written into {} ({e})",
            dir.display()
        )
    })?;
    Ok((files, signed_in))
}

/// The lines printed: where the session is and how each file is used, never a value or a length,
/// and who removes it.
pub(crate) fn said(
    profile: &str,
    actor: &str,
    files: &SessionFiles,
    signed_in: &Session,
    removed: &str,
) -> String {
    let at = &signed_in.at;
    let origin = at.origin().ascii_serialization();
    format!(
        "signed in as actor `{actor}` of profile `{profile}` at {origin}{path}; the password stayed \
         inside this process and no file holds it.\n\
         - API: `curl -H @{header} {origin}/<path>` — the file is one request header line.\n\
         - Browser: {state} is a Playwright storage state holding {holds}: \
         `browser.newContext({{ storageState: '{state}' }})`, or `--load-storage={state}` on the \
         Playwright CLI.\n\
         Never open, print or measure either file; {removed}",
        path = at.path(),
        header = files.header.display(),
        state = files.state.display(),
        holds = session::state_says(signed_in),
    )
}

/// Who removes the directory just written, after recording it on `run` where there is one: the
/// line closing [`said`].
pub(crate) fn who_removes(
    dir: &Path,
    run: Result<&str, &str>,
    record: impl FnOnce(&str, &Path) -> Result<PathBuf, String>,
) -> String {
    match run.map(|r| (r, record(r, dir))) {
        Ok((r, Ok(at))) => format!("recorded on run {r}, whose close removes {}", at.display()),
        Ok((r, Err(why))) => format!(
            "not recorded on run {r} ({why}), so only a `run close {r}` typed under this same \
             $TMPDIR finds it — delete {} once the judging is done",
            dir.display()
        ),
        Err(why) => format!(
            "no run's close removes it ({why}), so delete {} once the judging is done",
            dir.display()
        ),
    }
}

/// Record `dir` on `run` in this box's ledger, where every close of the run reads it (ISS-920).
fn record_on(run: &str, dir: &Path) -> Result<PathBuf, String> {
    let led = Ledger::default_path()
        .and_then(|p| Ledger::open(&p))
        .map_err(|e| format!("this box's ledger cannot be opened: {e}"))?;
    judge_dir::record(&led, run, dir)
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let actor = match named(
        &args.profile,
        args.actor.as_deref(),
        args.service.as_deref(),
        &args.run,
    ) {
        Ok(a) => a,
        Err(why) => return refuse(&why),
    };
    let client = match rest_client(&ctx)? {
        Ok(c) => c,
        Err(why) => return refuse(&why),
    };
    let asked = secret_path(&args.profile, &args.run, &actor);
    let (path, run_label) = match std::env::current_dir() {
        Ok(here) => match run_self::name_self(&asked, &here, || {
            Ledger::default_path()
                .and_then(|p| Ledger::open_read_only(&p))
                .map_err(|e| e.to_string())
        }) {
            run_self::SelfNamed::Run { path, note } => {
                eprintln!("{note}");
                let run = path
                    .trim_start_matches("/api/jobs/")
                    .split('/')
                    .next()
                    .unwrap_or("self")
                    .to_string();
                (path, run)
            }
            run_self::SelfNamed::AsWritten(note) => {
                eprintln!("{note}");
                (asked, args.run.clone())
            }
            run_self::SelfNamed::Untouched => (asked, args.run.clone()),
        },
        Err(_) => (asked, args.run.clone()),
    };
    // a refusal from core names the profile's actors and services, never a value, so it is said whole
    let answer = match get_json(&client, &path).await {
        Ok(a) => a,
        Err(why) => return refuse(&why),
    };
    let (dir, run) = where_to_write(args.out_dir, &run_label, &answer);
    let (files, signed_in) = match login_into(&answer, &dir, &args.profile, &actor).await {
        Ok(done) => done,
        Err(why) => return refuse(&why),
    };
    let removed = who_removes(&dir, run.as_deref().map_err(String::as_str), record_on);
    println!(
        "{}",
        said(&args.profile, &actor, &files, &signed_in, &removed)
    );
    Ok(())
}

/// Where the session goes, and the run it is recorded on so that run's close removes it (ISS-920):
/// `forge-judge-<run>` under [`judge_dir::root`], named by [`judge_dir::dir`]. A `self` this
/// checkout could not name is taken from the run core answered for. An `--out-dir` is recorded only
/// where it is itself named `forge-judge-<run>`: a close removes nothing else, so a mistyped
/// `--out-dir` can never take a directory of the judge's with it. Otherwise the line says why
/// nothing is recorded.
pub(crate) fn where_to_write(
    out_dir: Option<PathBuf>,
    run_label: &str,
    answer: &Value,
) -> (PathBuf, Result<String, String>) {
    let run = Some(run_label)
        .filter(|r| judge_dir::is_run_id(r))
        .or_else(|| answer.get("jobId").and_then(Value::as_str))
        .filter(|r| judge_dir::is_run_id(r));
    let unnamed =
        || format!("the read named no run: `{run_label}`, and core answered no run id for it");
    if let Some(d) = out_dir {
        let Some(r) = run else {
            return (d, Err(unnamed()));
        };
        let named = d.file_name() == judge_dir::dir(Path::new("/"), r).unwrap().file_name();
        return if named {
            (d, Ok(r.to_string()))
        } else {
            let why = format!(
                "--out-dir {} is not named {}{r}, and a close removes only a directory of that name",
                d.display(),
                judge_dir::PREFIX
            );
            (d, Err(why))
        };
    }
    let root = judge_dir::root();
    match run.map(|r| (judge_dir::dir(&root, r), r)) {
        Some((Ok(d), r)) => (d, Ok(r.to_string())),
        _ => (
            root.join(format!("{}{run_label}", judge_dir::PREFIX)),
            Err(unnamed()),
        ),
    }
}

fn refuse(why: &str) -> anyhow::Result<()> {
    eprintln!("judge-login: {why}");
    std::process::exit(2);
}

#[cfg(test)]
mod tests;
