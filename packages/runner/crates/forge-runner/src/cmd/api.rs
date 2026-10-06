use std::io::Read;

use clap::Args as ClapArgs;
use runner_platform::config::Config;
use runner_platform::cred_store;
use runner_transport::api::{
    build, run as run_api, usage_failure, RequestSpec, SlugSources, EXIT_TAXONOMY,
};
use runner_transport::CoreClient;
use serde_json::Value;

use super::Ctx;

/// `forge-runner api <PATH>` — call any Forge REST endpoint with a personal
/// access token, fenced to the projects that token may speak for. Shaped after
/// `gh api`. In a master pane that token is the checkout's own credential, the
/// one its `forge` CLI borrows (`mcp::config::borrowed_credential`), sent only to the core that
/// minted it; elsewhere it is
/// `$FORGE_PAT` or the stored PAT. The device token is a different credential.
#[derive(ClapArgs)]
#[command(after_help = EXIT_TAXONOMY)]
pub struct Args {
    /// Endpoint path. `issues`, `/issues` and `/api/issues` are the same.
    pub path: String,

    /// HTTP method (default GET, or POST when --data or -F is given).
    #[arg(short = 'X', long)]
    pub method: Option<String>,

    /// JSON request body. `-` reads stdin.
    #[arg(short = 'd', long)]
    pub data: Option<String>,

    /// A `multipart/form-data` field, repeatable: `name=@path` sends a file, `name=@path;type=<mime>`
    /// claims its media type, `name=value` sends text. An attachment route reads `file`:
    /// `forge-runner api issues/<id>/attachments -F file=@./shot.png`. Not with --data.
    #[arg(short = 'F', long = "form")]
    pub form: Vec<String>,

    /// Project slug for the `X-Forge-Project-Slug` header. Defaults to
    /// `$FORGE_PROJECT_SLUG`, then the sole bound project when there is one.
    #[arg(long)]
    pub project: Option<String>,

    /// Extra header, `Name: value`. Repeatable.
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
    let cfg = Config::load()?;
    let borrowed = match runner_workspace::mcp::config::borrowed_credential() {
        Ok(b) => b,
        Err(e) => return Ok(Err(e.to_string())),
    };
    let env_pat = std::env::var("FORGE_PAT")
        .ok()
        .is_some_and(|v| !v.trim().is_empty());
    let (core_url, token) = match credential_for(ctx.resolve_core_url(&cfg), borrowed, env_pat) {
        Credential::Borrowed { url, token, note } => {
            if let Some(note) = note {
                eprintln!("{note}");
            }
            (url, token)
        }
        Credential::Own(url) => match cred_store::load_pat()? {
            Some(token) => (url, token),
            None => return Ok(Err(
                "no personal access token — the REST API is reached with a PAT, not the device token. \
                 Mint one in the web UI under Settings → Access tokens, then either \
                 `forge-runner login --pat <token>` to store it or export FORGE_PAT=<token>."
                    .to_string(),
            )),
        },
        Credential::Refused(why) => return Ok(Err(why)),
    };
    Ok(Ok(CoreClient::new(core_url, token)))
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let client = match rest_client(&ctx)? {
        Ok(c) => c,
        Err(why) => return usage(&why),
    };
    let cfg = Config::load()?;

    let stdin_body = match args.data.as_deref() {
        Some("-") => {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s)?;
            Some(s)
        }
        _ => None,
    };
    let data = match (&stdin_body, args.data.as_deref()) {
        (Some(s), _) => Some(s.as_str()),
        (None, d) => d,
    };

    let env_slug = std::env::var("FORGE_PROJECT_SLUG").ok();
    let bindings: Vec<String> = cfg.bindings.keys().cloned().collect();
    let spec = RequestSpec {
        path: &args.path,
        method: args.method.as_deref(),
        data,
        form: &args.form,
        project: args.project.as_deref(),
        headers: &args.headers,
        include: args.include,
    };
    let sources = SlugSources {
        env: env_slug.as_deref(),
        bindings: &bindings,
    };
    let req = match build(&spec, &sources) {
        Ok(r) => r,
        Err(message) => return usage(&message),
    };

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
    std::process::exit(resp.outcome.exit_code);
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
            "API_BORROW_OTHER_CORE: this pane's checkout credential (${}) was minted by {}, and this call is addressed to {url}, so it is not sent there — drop --core-url to call {}, or run outside the master pane to call {url} as yourself",
            runner_workspace::mcp::config::CLI_BORROW_VAR,
            b.url,
            b.url
        ));
    }
    let note = env_pat.then(|| {
        format!(
            "note: FORGE_PAT is set, but this is a master pane, so the call goes out as the checkout's credential (${}) and not as FORGE_PAT's account",
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
            help.contains("POST when --data or -F is given"),
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
