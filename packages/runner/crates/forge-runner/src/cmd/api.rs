use std::io::Read;

mod mark_paths;

use clap::Args as ClapArgs;
use runner_platform::config::Config;
use runner_platform::cred_store;
use runner_transport::api::{
    build, reads_stdin, run as run_api, usage_failure, Body, RequestSpec, SlugSources,
    EXIT_TAXONOMY,
};
use runner_transport::CoreClient;
use serde_json::Value;

use super::Ctx;

/// `forge-runner api <PATH>` — call any Forge REST endpoint with a personal
/// access token, fenced to the projects that token may speak for. Shaped after
/// `gh api`. In a pane a box started for a project, master or job, that token is the
/// checkout's own credential, the one its `forge` CLI borrows
/// (`mcp::config::borrowed_credential`), sent only to the core that minted it; elsewhere it is
/// `$FORGE_PAT` or the stored PAT. The device token is a different credential.
#[derive(ClapArgs)]
#[command(after_help = EXIT_TAXONOMY)]
pub struct Args {
    /// Endpoint path. `issues`, `/issues` and `/api/issues` are the same.
    pub path: String,

    /// HTTP method (default GET, or POST when --data, -f or -F is given).
    #[arg(short = 'X', long)]
    pub method: Option<String>,

    /// JSON request body. `-` reads stdin.
    #[arg(short = 'd', long)]
    pub data: Option<String>,

    /// A string field of a JSON body this command builds and escapes, repeatable: `name=value`,
    /// `name=@path` reads the text from a file, `name=@-` from stdin, each less one final line
    /// break. Prose goes through a quoted heredoc and needs no quoting by hand:
    /// `forge-runner api issues/<id>/comments -f body=@- <<'FORGE_TEXT'`, the text, then a line
    /// reading `FORGE_TEXT`. Not with --data or -F.
    #[arg(short = 'f', long = "field")]
    pub fields: Vec<String>,

    /// A `multipart/form-data` field, repeatable: `name=@path` sends a file, `name=@path;type=<mime>`
    /// claims its media type, `name=value` sends text. An attachment route reads `file`:
    /// `forge-runner api issues/<id>/attachments -F file=@./shot.png`. Not with --data.
    #[arg(short = 'F', long = "form")]
    pub form: Vec<String>,

    /// Project slug for the `X-Forge-Project-Slug` header. Defaults to
    /// `$FORGE_PROJECT_SLUG`, then the sole bound project when there is one.
    #[arg(long)]
    pub project: Option<String>,

    /// Extra header, `Name: value`. Repeatable. Replaces the runner's own header of that name;
    /// `Authorization`, and `Content-Type` beside `-F`, are refused.
    #[arg(short = 'H', long = "header")]
    pub headers: Vec<String>,

    /// Print the status line and response headers to stderr.
    #[arg(short = 'i', long)]
    pub include: bool,
}

/// The client a REST call from this box goes out with — the pane's borrowed checkout credential, or
/// this person's own PAT — or the line that refuses it. `api` and `run brief` both call core as the
/// person, never as the device. The outer error is a fault reading this box's own files; the inner
/// one a refusal to say as a usage failure.
pub(crate) fn rest_client(ctx: &Ctx) -> anyhow::Result<Result<CoreClient, String>> {
    Ok(rest_credential(ctx)?.map(|(client, _)| client))
}

/// [`rest_client`], with the line naming the credential the call goes out on — never the token —
/// for a refusal to say: which credential was used is what a `404 project not found` from a fenced
/// token leaves out.
fn rest_credential(ctx: &Ctx) -> anyhow::Result<Result<(CoreClient, String), String>> {
    let cfg = Config::load()?;
    let borrowed = match runner_workspace::mcp::config::borrowed_credential() {
        Ok(b) => b,
        Err(e) => return Ok(Err(e.to_string())),
    };
    let env_pat = std::env::var("FORGE_PAT")
        .ok()
        .is_some_and(|v| !v.trim().is_empty());
    let (core_url, token, sent_as) = match credential_for(ctx.resolve_core_url(&cfg), borrowed, env_pat) {
        Credential::Borrowed { url, token, note } => {
            if let Some(note) = note {
                eprintln!("{note}");
            }
            let from = std::env::var(runner_workspace::mcp::config::CLI_BORROW_VAR).unwrap_or_default();
            let sent_as = format!(
                "this pane's checkout credential, read from {from} (${})",
                runner_workspace::mcp::config::CLI_BORROW_VAR
            );
            (url, token, sent_as)
        }
        Credential::Own(url) => match cred_store::load_pat()? {
            Some(token) => (url, token, own_pat_source(env_pat)),
            None => return Ok(Err(
                "no personal access token — the REST API is reached with a PAT, not the device token. \
                 Mint one in the web UI under Settings → Access tokens, then either \
                 `forge-runner login --pat <token>` to store it or export FORGE_PAT=<token>."
                    .to_string(),
            )),
        },
        Credential::Refused(why) => return Ok(Err(why)),
    };
    Ok(Ok((CoreClient::new(core_url, token), sent_as)))
}

/// Where `cred_store::load_pat` took this person's own PAT from, in its own order.
fn own_pat_source(env_pat: bool) -> String {
    if env_pat {
        return "the personal access token in $FORGE_PAT".to_string();
    }
    match cred_store::active_backend() {
        cred_store::Backend::Keychain => {
            "this box's stored personal access token, from the OS keychain".to_string()
        }
        cred_store::Backend::File => format!(
            "this box's stored personal access token, the `pat` key of {}",
            cred_store::credential_file_path()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "its credential file".to_string())
        ),
    }
}

/// The line a refusal is followed by: a `403` or `404` from core is answered to one credential,
/// and on a box serving several projects which one went out is not otherwise visible.
fn refused_on(exit_code: i32, sent_as: &str) -> Option<String> {
    matches!(exit_code, 4 | 5).then(|| {
        format!(
            "note: this call went out on {sent_as}; a credential reaches only the projects it was minted for, so a refusal here may be the credential's, not the route's"
        )
    })
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let (client, sent_as) = match rest_credential(&ctx)? {
        Ok(c) => c,
        Err(why) => return usage(&why),
    };
    let cfg = Config::load()?;

    let data_reads_stdin = args.data.as_deref() == Some("-");
    let stdin_text = if data_reads_stdin || reads_stdin(&args.fields) {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s)?;
        Some(s)
    } else {
        None
    };
    let data = match (data_reads_stdin, args.data.as_deref()) {
        (true, _) => stdin_text.as_deref(),
        (false, d) => d,
    };

    let env_slug = std::env::var("FORGE_PROJECT_SLUG").ok();
    let bindings: Vec<String> = cfg.bindings.keys().cloned().collect();
    let spec = RequestSpec {
        path: &args.path,
        method: args.method.as_deref(),
        data,
        fields: &args.fields,
        stdin: stdin_text.as_deref(),
        form: &args.form,
        project: args.project.as_deref(),
        headers: &args.headers,
        include: args.include,
    };
    let sources = SlugSources {
        env: env_slug.as_deref(),
        bindings: &bindings,
    };
    let mut req = match build(&spec, &sources) {
        Ok(r) => r,
        Err(message) => return usage(&message),
    };
    if let (Some(Body::Json(json)), Ok(here)) = (&req.body, std::env::current_dir()) {
        match mark_paths::attach(&req.method, &req.path, json, &here) {
            mark_paths::Attach::Sent(with_paths) => req.body = Some(Body::Json(with_paths)),
            mark_paths::Attach::Skipped(note) => eprintln!("{note}"),
            mark_paths::Attach::Untouched => {}
        }
    }

    let resp = run_api(&client, &req).await;
    {
        use std::io::Write;
        let mut out = std::io::stdout().lock();
        out.write_all(&resp.printed())?;
        out.flush()?;
    }
    if !resp.stderr.is_empty() {
        eprintln!("{}", resp.stderr);
    }
    if let Some(note) = refused_on(resp.outcome.exit_code, &sent_as) {
        eprintln!("{note}");
    }
    if let Some((code, detail)) = own_project_refusal(
        &resp.outcome.code,
        resp.outcome.exit_code,
        &resp.stdout,
        std::env::var("FORGE_PROJECT_ID").ok().as_deref(),
        std::env::var("FORGE_PROJECT_SLUG").ok().as_deref(),
    ) {
        tell_daemon_refused(&code, &detail).await;
    }
    std::process::exit(resp.outcome.exit_code);
}

/// The refusal of this pane's own credential by this pane's own project, as `(code, core's words)`,
/// or `None`: a token core no longer takes at all (401), or a fence refusal naming the project the
/// pane was started for (`PAT_PROJECT_OUTSIDE_FENCE … names project <id or slug>,`). A fence
/// refusal naming another project is the call's, not the pane's: a job may read a project its
/// checkout credential does not reach and carry on. Outside a project's pane there is none.
pub(crate) fn own_project_refusal(
    code: &str,
    exit_code: i32,
    body: &[u8],
    project_id: Option<&str>,
    project_slug: Option<&str>,
) -> Option<(String, String)> {
    let own: Vec<&str> = [project_id, project_slug]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if own.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(body);
    let said = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| {
            ["message", "detail", "error"]
                .iter()
                .find_map(|k| v.get(*k).and_then(Value::as_str).map(str::to_string))
        })
        .unwrap_or_else(|| text.chars().take(1000).collect());
    let fenced_here = code == "PAT_PROJECT_OUTSIDE_FENCE"
        && own.iter().any(|p| {
            let p = p.to_ascii_lowercase();
            said.to_ascii_lowercase()
                .contains(&format!("names project {p},"))
        });
    (fenced_here || exit_code == 3).then(|| (code.to_string(), said))
}

/// Tell this box's daemon the pane's own project refused its credential, so the job ends on it by
/// name (`control::Request::CredentialRefused`). Said on stderr either way: a pane with no
/// capability, or a daemon that cannot be reached, leaves the job to end on its silence.
async fn tell_daemon_refused(code: &str, detail: &str) {
    let Ok(token) = runner_daemon::session_tokens::token_from_env() else {
        return;
    };
    let Some(sock) = Config::path()
        .ok()
        .map(|p| p.with_file_name("control.sock"))
        .filter(|s| s.exists())
    else {
        eprintln!("note: this pane's own project refused its credential ({code}), and this box's daemon has no control socket to be told on");
        return;
    };
    match runner_daemon::control::request_credential_refused(&sock, &token, code, detail).await {
        Ok(reply) if reply.ok => eprintln!(
            "note: this pane's own project refused its credential ({code}); this box's daemon was told, and ends this job on that refusal rather than retrying it"
        ),
        Ok(reply) => eprintln!(
            "note: this pane's own project refused its credential ({code}), and this box's daemon refused to be told: {}",
            reply.reason.unwrap_or_default()
        ),
        Err(e) => eprintln!(
            "note: this pane's own project refused its credential ({code}), and this box's daemon could not be told: {e}"
        ),
    }
}

/// Which credential a call goes out with, and to which core.
#[derive(Debug, PartialEq, Eq)]
enum Credential {
    /// The pane's borrowed checkout credential, to the core that minted it, with the line said
    /// when it stands in for an exported `FORGE_PAT`.
    Borrowed {
        url: String,
        token: String,
        note: Option<String>,
    },
    /// This person's own PAT, to the resolved core.
    Own(String),
    Refused(String),
}

fn same_core(a: &str, b: &str) -> bool {
    a.trim()
        .trim_end_matches('/')
        .eq_ignore_ascii_case(b.trim().trim_end_matches('/'))
}

/// A borrowed checkout credential goes only to the core it was minted by: another URL, from
/// `--core-url` or the config, is refused naming both, never sent that token.
fn credential_for(
    resolved: Option<String>,
    borrowed: Option<runner_workspace::mcp::config::Borrowed>,
    env_pat: bool,
) -> Credential {
    let Some(b) = borrowed else {
        return match resolved {
            Some(url) => Credential::Own(url),
            None => Credential::Refused(
                "no core URL — pass --core-url or run `forge-runner login`".to_string(),
            ),
        };
    };
    if let Some(url) = resolved.as_deref().filter(|u| !same_core(u, &b.url)) {
        return Credential::Refused(format!(
            "API_BORROW_OTHER_CORE: this pane's checkout credential (${}) was minted by {}, and this call is addressed to {url}, so it is not sent there — drop --core-url to call {}, or run outside the project's pane to call {url} as yourself",
            runner_workspace::mcp::config::CLI_BORROW_VAR,
            b.url,
            b.url
        ));
    }
    let note = env_pat.then(|| {
        format!(
            "note: FORGE_PAT is set, but this pane was started for a project, so the call goes out as the checkout's credential (${}) and not as FORGE_PAT's account",
            runner_workspace::mcp::config::CLI_BORROW_VAR
        )
    });
    Credential::Borrowed {
        url: b.url,
        token: b.token,
        note,
    }
}

/// One GET to core, answered as JSON or as the line that says why not.
pub(crate) async fn get_json(client: &CoreClient, path: &str) -> Result<Value, String> {
    let resp = client
        .get(path)
        .send()
        .await
        .map_err(|e| format!("GET {path}: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("GET {path} answered {status}: {}", text.trim()));
    }
    serde_json::from_str(&text).map_err(|e| format!("GET {path} answered no JSON: {e}"))
}

fn usage(message: &str) -> anyhow::Result<()> {
    let (outcome, line) = usage_failure(message);
    eprintln!("{line}");
    std::process::exit(outcome.exit_code);
}

#[cfg(test)]
mod tests {
    use super::*;
    use runner_workspace::mcp::config::Borrowed;

    const MAIL: &str = "a417a126-7b96-4b8f-8d83-faa1e7ccbd56";

    fn fence_body(named: &str) -> Vec<u8> {
        serde_json::json!({
            "code": "PAT_PROJECT_OUTSIDE_FENCE",
            "message": format!("PAT_PROJECT_OUTSIDE_FENCE: this request came on token \"dev-runner-box\" (fc4fe551), which reaches forge (d1bb4907); the path names project {named}, which it does not reach, so nothing on that project is answered to it.")
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn a_fence_refusal_naming_the_panes_own_project_is_the_panes_own() {
        let got = own_project_refusal(
            "PAT_PROJECT_OUTSIDE_FENCE",
            4,
            &fence_body(MAIL),
            Some(MAIL),
            Some("sidcorp-mail"),
        );
        let (code, detail) = got.expect("the pane's own project refused it");
        assert_eq!(code, "PAT_PROJECT_OUTSIDE_FENCE");
        assert!(detail.contains("dev-runner-box"), "{detail}");
        // named by the slug header, as a call with no project in its path names it
        assert!(own_project_refusal(
            "PAT_PROJECT_OUTSIDE_FENCE",
            4,
            &fence_body("sidcorp-mail"),
            Some(MAIL),
            Some("sidcorp-mail")
        )
        .is_some());
    }

    #[test]
    fn a_fence_refusal_naming_another_project_is_the_calls_and_not_the_panes() {
        let other = "d180bdca-a927-4b11-b370-fa2ec923dba4";
        assert!(own_project_refusal(
            "PAT_PROJECT_OUTSIDE_FENCE",
            4,
            &fence_body(other),
            Some(MAIL),
            Some("sidcorp-mail")
        )
        .is_none());
        // a slug that only begins another project's slug is not it
        assert!(own_project_refusal(
            "PAT_PROJECT_OUTSIDE_FENCE",
            4,
            &fence_body("sidcorp-mail-archive"),
            Some(MAIL),
            Some("sidcorp-mail")
        )
        .is_none());
    }

    #[test]
    fn a_token_core_no_longer_takes_is_the_panes_and_any_other_refusal_is_not() {
        let body = br#"{"code":"UNAUTHORIZED","message":"token revoked"}"#;
        assert_eq!(
            own_project_refusal("UNAUTHORIZED", 3, body, Some(MAIL), None),
            Some(("UNAUTHORIZED".to_string(), "token revoked".to_string()))
        );
        assert!(own_project_refusal(
            "NOT_THE_HOLDER",
            4,
            br#"{"code":"NOT_THE_HOLDER"}"#,
            Some(MAIL),
            None
        )
        .is_none());
        assert!(own_project_refusal("NOT_FOUND", 5, b"{}", Some(MAIL), None).is_none());
    }

    #[test]
    fn outside_a_projects_pane_nothing_is_the_panes() {
        assert!(own_project_refusal(
            "PAT_PROJECT_OUTSIDE_FENCE",
            4,
            &fence_body(MAIL),
            None,
            None
        )
        .is_none());
        assert!(own_project_refusal("UNAUTHORIZED", 3, b"{}", Some(" "), Some("")).is_none());
    }

    fn borrow() -> Option<Borrowed> {
        Some(Borrowed {
            url: "https://forge-dev-api.example".into(),
            token: "tok-dev".into(),
        })
    }

    #[test]
    fn the_help_says_a_form_is_posted_as_json_is() {
        use clap::Args as _;
        let help = Args::augment_args(clap::Command::new("api"))
            .render_help()
            .to_string();
        assert!(
            help.contains("POST when --data, -f or -F is given"),
            "the help for -X does not say what -F does to the method:\n{help}"
        );
    }

    #[test]
    fn a_borrowed_credential_is_never_sent_to_another_core() {
        let got = credential_for(Some("https://forge-api.example".into()), borrow(), false);
        let Credential::Refused(why) = got else {
            panic!("the dev checkout's token went to another core: {got:?}");
        };
        assert!(why.starts_with("API_BORROW_OTHER_CORE"), "{why}");
        assert!(
            why.contains("https://forge-api.example")
                && why.contains("https://forge-dev-api.example"),
            "{why}"
        );
        assert!(!why.contains("tok-dev"), "{why}");
    }

    #[test]
    fn a_borrowed_credential_goes_to_its_own_core_however_spelled() {
        for resolved in [
            None,
            Some("https://forge-dev-api.example".to_string()),
            Some("https://forge-dev-api.example/".to_string()),
        ] {
            assert_eq!(
                credential_for(resolved.clone(), borrow(), false),
                Credential::Borrowed {
                    url: "https://forge-dev-api.example".into(),
                    token: "tok-dev".into(),
                    note: None
                },
                "{resolved:?}"
            );
        }
    }

    #[test]
    fn an_exported_forge_pat_the_borrow_overrides_is_said() {
        let Credential::Borrowed { note, .. } = credential_for(None, borrow(), true) else {
            panic!("refused");
        };
        assert!(note.is_some_and(|n| n.contains("FORGE_PAT")));
    }

    #[test]
    fn a_refusal_names_the_credential_it_went_out_on_and_nothing_else_does() {
        let sent_as = "this pane's checkout credential, read from /x/forge-cli.json";
        for refused in [4, 5] {
            let note = refused_on(refused, sent_as).expect("a 403/404 named no credential");
            assert!(note.contains(sent_as), "{note}");
        }
        for answered in [0, 2, 3, 6, 7, 8] {
            assert_eq!(refused_on(answered, sent_as), None, "exit {answered}");
        }
    }

    #[test]
    fn outside_a_pane_the_own_pat_goes_to_the_resolved_core() {
        assert_eq!(
            credential_for(Some("https://c".into()), None, true),
            Credential::Own("https://c".into())
        );
        assert!(matches!(
            credential_for(None, None, false),
            Credential::Refused(_)
        ));
    }
}
