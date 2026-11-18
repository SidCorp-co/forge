//! `forge-runner box` — Forge Boxes (ISS-1276) from a terminal: the act an agent drives a box with,
//! and the device's own setup, doctor, install and canary for the tools boxes run on.
//!
//! `act` goes through core (`POST /api/boxes/:id/acts`), never to the box directly: core holds the
//! lock no tool has, refusing a write `BOX_HELD_BY_PERSON` while a person holds the box, and
//! records every act. It prints what the driver printed and exits with its exit code.
//!
//! `attach` (ISS-1322) asks core for a browser box's CDP URL, which core hands only to a credential
//! bound to the box's own device: the device's proxy serves it, where the person's hold binds and
//! every write reaches the act feed. It prints the URL alone on stdout.

use std::time::Duration;

use clap::{Args as ClapArgs, Subcommand};
use runner_platform::config::Config;
use runner_transport::api::{build, run as run_api, RequestSpec, Response, SlugSources};
use serde_json::{json, Value};

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    pub cmd: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Run one driver command on a box, through core: `forge-runner box act <box> -- snapshot -i`.
    /// While a person holds the box a state-changing command is refused BOX_HELD_BY_PERSON (exit
    /// 6); reads (snapshot, get, is, screenshot, wait) still answer.
    Act {
        /// The box's id.
        #[arg(name = "BOX")]
        box_id: String,
        /// The run acting; defaults to $FORGE_RUN.
        #[arg(long)]
        run: Option<String>,
        /// The driver command (agent-browser, agent-device or agent-desktop, by the box's mode).
        #[arg(last = true, required = true)]
        command: Vec<String>,
    },
    /// For an agent on the box's device: print a browser box's CDP URL for Playwright
    /// (`connectOverCDP`) or chrome-devtools-mcp (`--browserUrl`). Elsewhere it is refused
    /// BOX_ATTACH_REMOTE; an android or desktop box BOX_ATTACH_UNAVAILABLE.
    Attach {
        /// The box's id.
        #[arg(name = "BOX")]
        box_id: String,
        /// The run attaching; defaults to $FORGE_RUN.
        #[arg(long)]
        run: Option<String>,
    },
    /// The modes this device serves, what each lacks and the command that fixes it.
    Doctor,
    /// Install this user's box tools (pinned npm tools, base AVD and snapshot), adopting what
    /// stands, and list the root parts for `forge-runner setup`.
    Setup,
    /// Install a pinned tool's version beside the pinned one; the pin moves only on a canary.
    Install { tool: String, version: String },
    /// Open a throwaway box on a tool's candidate version; a pass moves the pin in config.toml.
    Canary {
        tool: String,
        version: String,
        /// Report only: leave the pin where it is.
        #[arg(long)]
        dry_run: bool,
    },
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    match args.cmd {
        Command::Act {
            box_id,
            run,
            command,
        } => act(&ctx, &box_id, run, command).await,
        Command::Attach { box_id, run } => attach(&ctx, &box_id, run).await,
        Command::Doctor => {
            let cfg = Config::load()?;
            let served = doctor_rows(&cfg);
            anyhow::ensure!(served > 0, "this device serves no box mode");
            Ok(())
        }
        Command::Setup => super::forge_box_setup::user_space(&Config::load()?).await,
        Command::Install { tool, version } => {
            super::forge_box_setup::install(&tool, &version).await
        }
        Command::Canary {
            tool,
            version,
            dry_run,
        } => super::forge_box_setup::canary(&tool, &version, dry_run).await,
    }
}

/// Print each mode as doctor reads it; the count of modes served.
pub fn doctor_rows(cfg: &Config) -> usize {
    let s = &cfg.boxes;
    let data = s.data_dir().unwrap_or_default();
    let env = runner_box::modes::Env::of_host(s, &data);
    println!("Boxes");
    let mut served = 0;
    for m in runner_box::modes::all(&env, s) {
        println!("  {}", mode_line(&m));
        served += usize::from(m.serves);
    }
    served
}

/// One mode's doctor line: served with its pins, or what it lacks and the fix.
pub fn mode_line(m: &runner_box::modes::ModeReport) -> String {
    if m.serves {
        let pins: Vec<String> = m.versions.iter().map(|(k, v)| format!("{k} {v}")).collect();
        format!("[ok]   {:<8} serves ({})", m.mode, pins.join(", "))
    } else {
        let fix = m
            .fix
            .as_deref()
            .map(|f| format!(" — fix: {f}"))
            .unwrap_or_default();
        format!("[--]   {:<8} lacks {}{fix}", m.mode, m.lacks.join(", "))
    }
}

async fn attach(ctx: &Ctx, box_id: &str, run: Option<String>) -> anyhow::Result<()> {
    let client = match super::api::rest_client(ctx)? {
        Ok(c) => c,
        Err(why) => {
            eprintln!("{why}");
            std::process::exit(2);
        }
    };
    let run = run_of(run);
    let body = match &run {
        Some(r) => json!({ "runId": r }),
        None => json!({}),
    };
    let path = format!("boxes/{box_id}/attach");
    let resp = call(
        &client,
        "POST",
        &path,
        Some(body.to_string()),
        run.as_deref(),
    )
    .await?;
    let (url, how) = attach_lines(&answered(&resp))?;
    eprintln!("{how}");
    println!("{url}");
    Ok(())
}

/// The URL `attach` answered, and the line saying how to use it.
fn attach_lines(answer: &Value) -> anyhow::Result<(String, String)> {
    let url = answer["attach"]["cdp"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("core answered no CDP URL: {answer}"))?;
    let how = format!(
        "Playwright: chromium.connectOverCDP(\"{url}\"); chrome-devtools-mcp: --browserUrl {url}. While a person holds the box, input and navigation answer BOX_HELD_BY_PERSON; reads still answer."
    );
    Ok((url.to_string(), how))
}

/// The run named, else `$FORGE_RUN`.
fn run_of(run: Option<String>) -> Option<String> {
    run.or_else(|| std::env::var("FORGE_RUN").ok())
        .filter(|r| !r.trim().is_empty())
}

async fn act(
    ctx: &Ctx,
    box_id: &str,
    run: Option<String>,
    command: Vec<String>,
) -> anyhow::Result<()> {
    let client = match super::api::rest_client(ctx)? {
        Ok(c) => c,
        Err(why) => {
            eprintln!("{why}");
            std::process::exit(2);
        }
    };
    let run = run_of(run);
    let mut body = json!({ "command": command });
    if let Some(r) = &run {
        body["runId"] = r.clone().into();
    }
    let resp = call(
        &client,
        "POST",
        &format!("boxes/{box_id}/acts"),
        Some(body.to_string()),
        run.as_deref(),
    )
    .await?;
    let (mut record, hand_back) = act_of(answered(&resp));
    if let Some(said) = hand_back {
        eprintln!("{said}");
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    while record["state"] == "pending" && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let after = record["seq"].as_i64().unwrap_or(1) - 1;
        let feed = call(
            &client,
            "GET",
            &format!("boxes/{box_id}/acts?after={after}"),
            None,
            run.as_deref(),
        )
        .await?;
        if let Some(found) = find_act(&answered(&feed), &record["id"]) {
            record = found;
        }
    }
    std::process::exit(print_act(&record));
}

async fn call(
    client: &runner_transport::CoreClient,
    method: &str,
    path: &str,
    data: Option<String>,
    run: Option<&str>,
) -> anyhow::Result<Response> {
    let cfg = Config::load()?;
    let env_slug = std::env::var("FORGE_PROJECT_SLUG").ok();
    let bindings: Vec<String> = cfg.bindings.keys().cloned().collect();
    let spec = RequestSpec {
        path,
        method: Some(method),
        data: data.as_deref(),
        fields: &[],
        stdin: None,
        form: &[],
        project: None,
        headers: &[],
        include: false,
    };
    let sources = SlugSources {
        env: env_slug.as_deref(),
        bindings: &bindings,
    };
    let mut req = build(&spec, &sources).map_err(anyhow::Error::msg)?;
    if let Some(run) = run {
        req.headers.push((
            super::api::run_self::RUN_HEADER.to_string(),
            run.to_string(),
        ));
    }
    Ok(run_api(client, &req).await)
}

/// Core's answer, or the refusal said by name and the call's exit code taken.
fn answered(resp: &Response) -> Value {
    if resp.outcome.exit_code != 0 {
        let said = String::from_utf8_lossy(&resp.refused_body);
        eprintln!("{}: {}", resp.outcome.code, said.trim());
        if !resp.stderr.is_empty() {
            eprintln!("{}", resp.stderr);
        }
        std::process::exit(resp.outcome.exit_code);
    }
    serde_json::from_slice(&resp.stdout).unwrap_or(Value::Null)
}

/// Core's answer to an act (`{ act, personActed? }`, `AgentActAnswer`): the act's record, and a
/// line saying a person acted on the box since this agent's previous act, where one did.
fn act_of(mut answer: Value) -> (Value, Option<String>) {
    let said = answer.get("personActed").map(|p| {
        format!(
            "a person acted on this box since your last act ({} input(s)); read them: forge-runner api {}",
            p["inputs"],
            p["feed"].as_str().unwrap_or("").trim_start_matches("/api/")
        )
    });
    (answer["act"].take(), said)
}

/// The act named `id` in a feed answer (`{ acts: [...] }` or a bare list).
fn find_act(feed: &Value, id: &Value) -> Option<Value> {
    feed.get("acts")
        .unwrap_or(feed)
        .as_array()?
        .iter()
        .find(|a| &a["id"] == id)
        .cloned()
}

/// Print an act as its driver printed it; the exit code to leave with.
pub fn print_act(record: &Value) -> i32 {
    match record["state"].as_str() {
        Some("done") | Some("failed") => {
            print!("{}", record["stdout"].as_str().unwrap_or_default());
            eprint!("{}", record["stderr"].as_str().unwrap_or_default());
            record["exitCode"].as_i64().unwrap_or(1) as i32
        }
        Some("refused") => {
            eprintln!("{}", record["refusal"].as_str().unwrap_or("refused"));
            6
        }
        Some("pending") => {
            eprintln!("the act is still pending on the box; read it with `forge-runner api boxes/<box>/acts`");
            10
        }
        _ => {
            eprintln!("core answered no act record: {record}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doctor_names_a_served_mode_with_its_pins_and_an_unserved_one_with_its_fix() {
        let served = runner_box::modes::ModeReport {
            mode: "browser",
            serves: true,
            lacks: vec![],
            fix: None,
            cost: runner_box::modes::base_cost("browser"),
            versions: [("agent-browser".to_string(), "0.43.0".to_string())].into(),
        };
        assert_eq!(
            mode_line(&served),
            "[ok]   browser  serves (agent-browser 0.43.0)"
        );
        let ios = runner_box::modes::ios();
        assert_eq!(
            mode_line(&ios),
            "[--]   ios      lacks a macOS host with the iOS Simulator"
        );
    }

    #[test]
    fn attach_prints_the_cdp_url_alone_and_says_how_to_connect() {
        let (url, how) = attach_lines(&json!({
            "box": { "id": "b" },
            "attach": { "mode": "browser", "cdp": "http://127.0.0.1:41733" }
        }))
        .unwrap();
        assert_eq!(url, "http://127.0.0.1:41733");
        assert!(
            how.contains("connectOverCDP(\"http://127.0.0.1:41733\")"),
            "{how}"
        );
        assert!(how.contains("--browserUrl http://127.0.0.1:41733"), "{how}");
        assert!(attach_lines(&json!({ "box": {} })).is_err());
    }

    #[test]
    fn an_act_exits_with_the_drivers_code_and_a_refusal_with_six() {
        assert_eq!(
            print_act(&json!({ "state": "done", "exitCode": 3, "stdout": "", "stderr": "" })),
            3
        );
        assert_eq!(
            print_act(&json!({ "state": "refused", "refusal": "BOX_HELD_BY_PERSON" })),
            6
        );
        let feed =
            json!({ "acts": [{ "id": "a", "state": "pending" }, { "id": "b", "state": "done" }] });
        let (act, said) = act_of(json!({
            "act": { "id": "c", "state": "done", "exitCode": 0, "stdout": "ok" },
            "personActed": { "inputs": 2, "feed": "/api/boxes/x/acts?by=person&after=4" }
        }));
        assert_eq!(print_act(&act), 0, "the record is read from `act`");
        assert!(said
            .unwrap()
            .ends_with("forge-runner api boxes/x/acts?by=person&after=4"));
        assert_eq!(act_of(json!({ "act": { "state": "pending" } })).1, None);
        assert_eq!(find_act(&feed, &json!("b")).unwrap()["state"], "done");
    }
}
