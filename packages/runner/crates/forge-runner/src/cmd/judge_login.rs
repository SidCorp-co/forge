//! `forge-runner judge-login <profile> <actor>`: the one testing secret a judge needs, written to a
//! 0600 file, its value never on the terminal.
//!
//! FB-464 (catalog-api qa runs 94ef974e and 575d3ace, 2026-11-01): judges read the testing-secrets
//! route with `forge-runner api`, which prints the body, and twice the values reached their
//! transcripts. Core now answers one named secret per read (ISS-868); this command reads it the same
//! way `api` does — the pane's checkout credential, `self` named as the run declared over this
//! checkout — and prints only where the file is and which fields it holds.

use std::io::Write;
use std::path::{Path, PathBuf};

use clap::Args as ClapArgs;
use runner_core::judge_dir;
use runner_core::ledger::Ledger;
use serde_json::{json, Value};

use super::api::{get_json, rest_client, run_self};
use super::Ctx;

/// Read one actor's (or service's) testing secret into a 0600 file and print only its path and
/// field names, never a value.
#[derive(ClapArgs)]
pub struct Args {
    /// The testing profile the environment you judge names (`environments.<env>.testing`).
    pub profile: String,
    /// The actor of that profile to log in as, as the profile declares it (`GET
    /// /api/projects/<id>/testing-profiles/<profile>` lists them).
    pub actor: Option<String>,
    /// Read this service of the profile instead of an actor.
    #[arg(long, conflicts_with = "actor")]
    pub service: Option<String>,
    /// The run to read as; default `self`, the run declared over this checkout.
    #[arg(long, default_value = "self")]
    pub run: String,
    /// Directory to write the file into (created 0700); default a `forge-judge-<run>` directory
    /// under the system temp dir, outside every checkout, which `run close <run>` removes.
    #[arg(long)]
    pub out_dir: Option<PathBuf>,
}

/// What the read names: an actor or a service of the profile.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Named {
    Actor(String),
    Service(String),
}

impl Named {
    fn query(&self) -> String {
        match self {
            Named::Actor(a) => format!("actor={a}"),
            Named::Service(s) => format!("service={s}"),
        }
    }
    fn file_stem(&self) -> String {
        match self {
            Named::Actor(a) => format!("actor-{a}"),
            Named::Service(s) => format!("service-{s}"),
        }
    }
}

/// A profile, actor or service name as core declares them: a letter, then letters, digits and `-`.
fn valid_name(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && s.len() <= 63
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// What the arguments name, or the line refusing them.
pub(crate) fn named(
    profile: &str,
    actor: Option<&str>,
    service: Option<&str>,
    run: &str,
) -> Result<Named, String> {
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
    let chosen = match (actor, service) {
        (Some(a), None) => Named::Actor(a.to_string()),
        (None, Some(s)) => Named::Service(s.to_string()),
        _ => {
            return Err(
                "name the one actor to log in as (`judge-login <profile> <actor>`), or `--service <name>`; \
                 a read is never handed the whole profile"
                    .to_string(),
            )
        }
    };
    let (Named::Actor(n) | Named::Service(n)) = &chosen;
    if !valid_name(n) {
        return Err(format!(
            "`{n}` is no actor or service name: a letter, then letters, digits or `-`"
        ));
    }
    Ok(chosen)
}

/// The read's path, before `self` is named as a run.
pub(crate) fn secret_path(profile: &str, run: &str, what: &Named) -> String {
    format!(
        "/api/jobs/{run}/testing-profiles/{profile}/secrets?{}",
        what.query()
    )
}

/// The file's contents from core's answer: exactly one secret, or the line saying what came back.
pub(crate) fn file_body(answer: &Value, profile: &str, what: &Named) -> Result<Value, String> {
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
    let (Some(r#ref), Some(value)) = (
        secret.get("ref").and_then(Value::as_str),
        secret.get("value").and_then(Value::as_str),
    ) else {
        return Err("core's secret carries no `ref` and `value`; nothing was written".to_string());
    };
    let mut body = json!({
        "profile": profile,
        "environment": answer.get("environment").cloned().unwrap_or(Value::Null),
        "ref": r#ref,
        "value": value,
    });
    match what {
        Named::Actor(a) => body["actor"] = json!(a),
        Named::Service(s) => body["service"] = json!(s),
    }
    Ok(body)
}

/// Write `body` to `<dir>/<profile>-<stem>.json`, the directory 0700 and the file 0600, replacing
/// any earlier copy. Answers the file's path.
pub(crate) fn write_private(
    dir: &Path,
    profile: &str,
    what: &Named,
    body: &Value,
) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let path = dir.join(format!("{profile}-{}.json", what.file_stem()));
    let _ = std::fs::remove_file(&path);
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    let mut file = open.open(&path)?;
    file.write_all(serde_json::to_string_pretty(body)?.as_bytes())?;
    file.write_all(b"\n")?;
    Ok(path)
}

/// The one line printed: where the file is, the names of its fields, never a value, and who
/// removes it.
pub(crate) fn said(path: &Path, body: &Value, removed: &str) -> String {
    let mut fields: Vec<&str> = body
        .as_object()
        .map(|o| o.keys().map(String::as_str).collect())
        .unwrap_or_default();
    fields.sort_unstable();
    format!(
        "wrote {} (0600), fields: {}; read the value from the file, and keep it out of every comment, commit and transcript; {removed}",
        path.display(),
        fields.join(", ")
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
    let what = match named(
        &args.profile,
        args.actor.as_deref(),
        args.service.as_deref(),
        &args.run,
    ) {
        Ok(w) => w,
        Err(why) => return refuse(&why),
    };
    let client = match rest_client(&ctx)? {
        Ok(c) => c,
        Err(why) => return refuse(&why),
    };
    let asked = secret_path(&args.profile, &args.run, &what);
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
    let body = match file_body(&answer, &args.profile, &what) {
        Ok(b) => b,
        Err(why) => return refuse(&why),
    };
    let (dir, run) = where_to_write(args.out_dir, &run_label, &answer);
    let written = write_private(&dir, &args.profile, &what, &body)?;
    let removed = who_removes(&dir, run.as_deref().map_err(String::as_str), record_on);
    println!("{}", said(&written, &body, &removed));
    Ok(())
}

/// Where the file goes, and the run it is recorded on so that run's close removes it (ISS-920):
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
mod tests {
    use super::*;

    const VALUE: &str = "stg-admin@adminhub.test:Corr3ct-H0rse-Battery";

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn answer() -> Value {
        json!({
            "jobId": null,
            "environment": "stg",
            "profileId": "stg",
            "secrets": [{ "ref": "secret://test/stg-admin", "value": VALUE }],
        })
    }

    #[test]
    fn a_read_names_one_actor_or_service_and_never_the_whole_profile() {
        assert_eq!(
            named("stg", Some("admin"), None, "self"),
            Ok(Named::Actor("admin".into()))
        );
        assert_eq!(
            named("stg", None, Some("store"), "self"),
            Ok(Named::Service("store".into()))
        );
        let none = named("stg", None, None, "self").unwrap_err();
        assert!(none.contains("never handed the whole profile"), "{none}");
        for (profile, actor, run) in [
            ("stg", "admin&service=store", "self"),
            ("stg/../x", "admin", "self"),
            ("stg", "admin", "not-a-run"),
        ] {
            assert!(
                named(profile, Some(actor), None, run).is_err(),
                "{profile} {actor} {run}"
            );
        }
    }

    #[test]
    fn the_path_asks_for_the_one_name_as_self_or_the_run() {
        assert_eq!(
            secret_path("stg", "self", &Named::Actor("admin".into())),
            "/api/jobs/self/testing-profiles/stg/secrets?actor=admin"
        );
        let run = "53077902-cb16-408f-904c-e0e4b762a1c9";
        assert_eq!(
            secret_path("stg", run, &Named::Service("store".into())),
            format!("/api/jobs/{run}/testing-profiles/stg/secrets?service=store")
        );
    }

    #[test]
    fn the_file_holds_the_one_secret_and_more_than_one_is_refused() {
        let body = file_body(&answer(), "stg", &Named::Actor("admin".into())).unwrap();
        assert_eq!(body["value"], VALUE);
        assert_eq!(body["actor"], "admin");
        assert_eq!(body["ref"], "secret://test/stg-admin");
        let mut two = answer();
        two["secrets"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "ref": "secret://dev/epod-store", "value": "x".repeat(20) }));
        let err = file_body(&two, "stg", &Named::Actor("admin".into())).unwrap_err();
        assert!(err.contains("2 secrets for one name"), "{err}");
        assert!(!err.contains(VALUE));
    }

    #[test]
    fn the_file_is_written_0600_and_the_line_printed_holds_no_value() {
        let root = Scratch(
            std::env::temp_dir().join(format!("forge-judge-login-test-{}", std::process::id())),
        );
        let what = Named::Actor("admin".into());
        let body = file_body(&answer(), "stg", &what).unwrap();
        write_private(&root.0.join("run"), "stg", &what, &body).unwrap();
        // written again, it replaces the earlier copy rather than failing
        let path = write_private(&root.0.join("run"), "stg", &what, &body).unwrap();
        assert_eq!(path, root.0.join("run/stg-actor-admin.json"));
        let read: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(read["value"], VALUE);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            let dir = std::fs::metadata(root.0.join("run"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!((file, dir), (0o600, 0o700));
        }
        let line = said(&path, &body, "");
        assert!(!line.contains(VALUE), "{line}");
        assert!(!line.contains("Corr3ct"), "{line}");
        assert!(
            line.contains("fields: actor, environment, profile, ref, value"),
            "{line}"
        );
        assert!(line.contains(&path.display().to_string()), "{line}");
    }
    #[test]
    fn the_login_is_written_where_its_runs_close_removes_it() {
        let run = "53077902-cb16-408f-904c-e0e4b762a1c9";
        let root = judge_dir::root();
        let none = json!({ "jobId": null });
        let ours = || Ok(run.to_string());
        assert_eq!(
            where_to_write(None, run, &none),
            (judge_dir::dir(&root, run).unwrap(), ours())
        );
        // a `self` this checkout could not name is the run core answered for
        let core = json!({ "jobId": run });
        assert_eq!(
            where_to_write(None, "self", &core),
            (judge_dir::dir(&root, run).unwrap(), ours())
        );
        // a read naming no run is nobody's close to remove, and says why
        let (unnamed, by) = where_to_write(None, "self", &none);
        assert_eq!(unnamed, root.join("forge-judge-self"));
        assert!(by.unwrap_err().contains("named no run"));
        // an --out-dir named for the run is recorded on it; any other is not, and says why
        let named = PathBuf::from(format!("/somewhere/forge-judge-{run}"));
        assert_eq!(
            where_to_write(Some(named.clone()), run, &core),
            (named, ours())
        );
        let asked = PathBuf::from("/somewhere/else");
        let (d, by) = where_to_write(Some(asked.clone()), run, &core);
        assert_eq!(d, asked);
        assert!(by.unwrap_err().contains("is not named forge-judge-"));
    }

    #[test]
    fn the_line_says_where_the_login_is_recorded_or_why_it_is_not() {
        let run = "53077902-cb16-408f-904c-e0e4b762a1c9";
        let dir = PathBuf::from(format!("/t/forge-judge-{run}"));
        let recorded = who_removes(&dir, Ok(run), |_, d| Ok(d.to_path_buf()));
        assert_eq!(
            recorded,
            format!(
                "recorded on run {run}, whose close removes {}",
                dir.display()
            )
        );
        let unrecorded = who_removes(&dir, Ok(run), |_, _| Err("no ledger".into()));
        assert!(unrecorded.contains("not recorded on run") && unrecorded.contains("no ledger"));
        let nobody = who_removes(&dir, Err("no run"), |_, _| unreachable!());
        assert!(
            nobody.contains("no run's close removes it (no run)"),
            "{nobody}"
        );
        let body = file_body(&answer(), "stg", &Named::Actor("admin".into())).unwrap();
        let line = said(&dir.join("stg-actor-admin.json"), &body, &recorded);
        assert!(line.ends_with(&recorded), "{line}");
    }
}
