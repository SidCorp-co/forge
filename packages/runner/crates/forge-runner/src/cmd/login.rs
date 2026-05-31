use std::time::{Duration, Instant};

use clap::Args as ClapArgs;
use forge_runner_core::auth::pairing::LoginPoll;
use forge_runner_core::auth::{cred_store, git_cred, pairing};
use forge_runner_core::config::Config;

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    /// Pairing code minted from the web UI (paste-code flow). When omitted,
    /// the browser-approve device-login flow runs instead.
    #[arg(long)]
    pub code: Option<String>,
    /// Device name shown in the dashboard (default: hostname).
    #[arg(long)]
    pub name: Option<String>,
    /// Skip opening the browser; print the approval URL instead.
    #[arg(long)]
    pub no_browser: bool,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let mut cfg = Config::load()?;
    let core_url = ctx
        .resolve_core_url(&cfg)
        .ok_or_else(|| anyhow::anyhow!("no core URL — pass --core-url <url>"))?;
    let name = args.name.clone().unwrap_or_else(pairing::default_device_name);

    // Back-compat: explicit --code keeps the paste-code project-pairing flow.
    if let Some(code) = args.code {
        let resp = pairing::pair(&core_url, &code, &name).await?;
        cred_store::store_device_token(&resp.device_token)?;
        cfg.core_url = Some(core_url);
        cfg.device_id = Some(resp.device_id.clone());
        cfg.save()?;
        println!(
            "✔ paired device {} (token store: {})",
            resp.device_id,
            cred_store::active_backend()
        );
        if let Some(pid) = resp.project_id {
            println!("  project hint: {pid}");
            println!("  next: forge-runner bind <slug> --path <dir> --project-id {pid}");
        }
        return Ok(());
    }

    // Browser-approve device login (OAuth device-authorization flow).
    let init = pairing::login_init(&core_url, &name).await?;
    let verify_url = format!("{}{}", core_url.trim_end_matches('/'), init.verify_url);

    println!("Pairing code: {}", init.pairing_code);
    println!("Approve this device in your browser:");
    println!("  {verify_url}");
    if args.no_browser {
        println!("(browser auto-open skipped — open the URL above)");
    } else if webbrowser::open(&verify_url).is_err() {
        println!("(could not open a browser automatically — open the URL above)");
    }
    println!("Waiting for approval (expires {})…", init.expires_at);

    // Poll until approved / expired. 2s cadence, hard 11-min ceiling (code TTL
    // is 10 min server-side; the extra minute covers clock skew).
    let deadline = Instant::now() + Duration::from_secs(11 * 60);
    let approved = loop {
        if Instant::now() >= deadline {
            anyhow::bail!("device login timed out before approval");
        }
        match pairing::login_poll(&core_url, &init.pairing_code).await? {
            LoginPoll::Pending => {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            LoginPoll::Gone(reason) => {
                anyhow::bail!("device login code is no longer valid: {reason}");
            }
            LoginPoll::Approved(a) => break a,
        }
    };

    cred_store::store_device_token(&approved.device_token)?;
    cfg.core_url = Some(core_url);
    cfg.device_id = Some(approved.device_id.clone());
    cfg.save()?;

    println!(
        "✔ logged in device {} (token store: {})",
        approved.device_id,
        cred_store::active_backend()
    );

    // Auto git-credential provisioning (server returns this only when enabled).
    if let Some(cred) = approved.git_credential.as_ref() {
        match git_cred::write_git_credential(cred) {
            Ok(note) => println!("✔ {note}"),
            Err(e) => println!("⚠ git credential not configured ({e}) — set up push manually"),
        }
    }

    println!("  next: forge-runner bind <slug> --path <dir>");
    Ok(())
}
