//! `forge-runner setup` — the one command a new box runs after the installer.
//!
//! Every step is idempotent and every question has a flag, so the same command
//! serves a person at a terminal and a cloud-init script with no tty. What it
//! does NOT do is invent work: pairing is `login`'s, the checkout is the
//! server's provisioning path, the verdict is `doctor`'s. Setup is the order
//! those are done in, and the questions that decide their arguments.

use std::io::{IsTerminal, Write};
use std::path::PathBuf;

use clap::Args as ClapArgs;
use forge_runner_core::auth::{cred_store, pairing};
use forge_runner_core::config::Config;
use forge_runner_core::transport::runners::MeRunner;

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    /// Pairing code from the web UI, instead of the browser-approve flow.
    #[arg(long)]
    pub code: Option<String>,
    /// Device name shown in the dashboard (default: hostname).
    #[arg(long)]
    pub name: Option<String>,
    /// Open the approval URL in a browser (off by default — most boxes are headless).
    #[arg(long)]
    pub open: bool,
    /// Project slug to bind. Repeatable. Default with a tty: ask. Without one: every assignment.
    #[arg(long)]
    pub project: Vec<String>,
    /// Local checkout for the single `--project` given. Otherwise the server provisions one.
    #[arg(long)]
    pub path: Option<PathBuf>,
    /// Where provisioned checkouts live (persisted as `projects_root`).
    #[arg(long)]
    pub projects_root: Option<PathBuf>,
    /// Install + start the OS service without asking.
    #[arg(long)]
    pub service: bool,
    /// Do not install the OS service.
    #[arg(long, conflicts_with = "service")]
    pub no_service: bool,
    /// Personal access token for the `forge` CLI and the provisioned `.mcp.json`.
    #[arg(long)]
    pub pat: Option<String>,
    /// Never prompt; take the defaults and the flags as given.
    #[arg(long)]
    pub yes: bool,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let interactive = !args.yes && std::io::stdin().is_terminal();
    println!("Forge Runner — setup\n");

    require_tools()?;
    let core_url = resolve_core_url(&ctx)?;
    ensure_paired(&core_url, &args).await?;

    ensure_pat(&core_url, &args, interactive)?;

    let cfg = Config::load()?;
    let client = super::bind::client_for(&ctx, &cfg)?;
    let assignments = wait_for_assignments(&client, &core_url, interactive).await?;
    let chosen = choose_projects(&assignments, &args, interactive)?;

    ensure_projects_root(&args, &chosen, interactive)?;
    for slug in &chosen {
        bind_one(
            &client,
            slug,
            args.path.clone().filter(|_| chosen.len() == 1),
        )
        .await?;
    }

    ensure_service(&args, interactive)?;

    println!("\nRunning doctor…\n");
    super::doctor::run(
        Ctx {
            core_url_override: Some(core_url),
        },
        super::doctor::Args { offline: false },
    )
    .await
}

/// The three binaries a job needs. Checked FIRST: a box with no `claude` can
/// pair and bind perfectly and still never run a job, and finding that out
/// after five steps is finding it out in the wrong place.
fn require_tools() -> anyhow::Result<()> {
    let missing: Vec<&str> = ["claude", "git", "tmux"]
        .into_iter()
        .filter(|bin| which(bin).is_none())
        .collect();
    if missing.is_empty() {
        println!("✔ tools        claude, git, tmux");
        return Ok(());
    }
    anyhow::bail!(
        "missing on PATH: {}. A runner launches `claude` inside a `tmux` pane against a `git` \
         checkout, so setup stops here rather than pairing a box that cannot run a job. Install \
         them (and sign in to Claude Code with `claude`), then run `forge-runner setup` again.",
        missing.join(", ")
    )
}

fn which(bin: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(bin))
            .find(|p| p.is_file())
    })
}

fn resolve_core_url(ctx: &Ctx) -> anyhow::Result<String> {
    let cfg = Config::load()?;
    ctx.resolve_core_url(&cfg).ok_or_else(|| {
        anyhow::anyhow!(
            "no core URL configured — the installer normally writes it. \
             `forge-runner config set core-url <https://core.example.com>`, then run setup again."
        )
    })
}

async fn ensure_paired(core_url: &str, args: &Args) -> anyhow::Result<()> {
    let cfg = Config::load()?;
    let token = cred_store::load_device_token().unwrap_or_default();
    if let (Some(id), Some(_)) = (cfg.device_id.as_deref(), token.as_deref()) {
        println!("✔ paired       device {id} (already)");
        return Ok(());
    }
    let name = args
        .name
        .clone()
        .unwrap_or_else(pairing::default_device_name);
    super::login::pair_device(core_url, &name, args.code.clone(), args.open).await
}

/// The device token names this box; a PAT names the human. The provisioned
/// `.mcp.json` and the `forge` CLI both speak with the second, so a box with
/// only the first pairs, binds and provisions perfectly and then hands a human
/// a checkout whose `claude` cannot see Forge. Setup asks for it here rather
/// than letting that turn up later as an empty tool list.
fn ensure_pat(core_url: &str, args: &Args, interactive: bool) -> anyhow::Result<()> {
    if let Some(pat) = args.pat.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        cred_store::store_pat(pat)?;
        println!("✔ rest token   stored ({})", cred_store::active_backend());
        return Ok(());
    }
    if cred_store::load_pat().ok().flatten().is_some() {
        println!("✔ rest token   already stored");
        return Ok(());
    }

    let mint = format!("{}/settings", core_url.trim_end_matches('/'));
    if !interactive {
        println!(
            "• rest token   none — pass `--pat <token>` (mint one at {mint} → Access tokens). \
             Without it the provisioned .mcp.json gets no `forge` entry and the `forge` CLI \
             cannot reach the tracker; jobs still run."
        );
        return Ok(());
    }
    println!("\nA personal access token lets `claude` and the `forge` CLI in your checkout reach");
    println!("Forge. Mint one at {mint} → Access tokens (Enter to skip).");
    let pat = ask("Paste the token:")?;
    if pat.is_empty() {
        println!(
            "• rest token   skipped — `forge-runner login --pat <token>` later, then re-run setup"
        );
        return Ok(());
    }
    cred_store::store_pat(&pat)?;
    println!("✔ rest token   stored ({})", cred_store::active_backend());
    Ok(())
}

/// Assignments are the server's answer, not a question for this box. When there
/// are none the operator has to make one in the web UI, so setup says where and
/// waits for it rather than binding nothing and reporting success.
async fn wait_for_assignments(
    client: &forge_runner_core::transport::CoreClient,
    core_url: &str,
    interactive: bool,
) -> anyhow::Result<Vec<MeRunner>> {
    let fetch = || forge_runner_core::transport::runners::list_me(client);
    let mut assignments = fetch()
        .await
        .map_err(|e| anyhow::anyhow!("could not read this device's assignments: {e}"))?;
    if !assignments.is_empty() {
        return Ok(assignments);
    }

    let url = format!("{}/runners", core_url.trim_end_matches('/'));
    println!("• projects     none assigned to this device yet");
    println!("  Assign one at {url} — then this setup continues on its own.");
    if !interactive {
        anyhow::bail!(
            "no project is assigned to this device; assign one in the web UI and run \
             `forge-runner setup` again"
        );
    }
    for _ in 0..60 {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        assignments = fetch().await.unwrap_or_default();
        if !assignments.is_empty() {
            return Ok(assignments);
        }
    }
    anyhow::bail!("gave up waiting for a project assignment after 5 minutes")
}

fn choose_projects(
    assignments: &[MeRunner],
    args: &Args,
    interactive: bool,
) -> anyhow::Result<Vec<String>> {
    let known: Vec<&str> = assignments.iter().map(|a| a.slug.as_str()).collect();
    if !args.project.is_empty() {
        for want in &args.project {
            if !known.contains(&want.as_str()) {
                anyhow::bail!(
                    "'{want}' is not assigned to this device; assigned: {}",
                    known.join(", ")
                );
            }
        }
        return Ok(args.project.clone());
    }
    if !interactive || assignments.len() == 1 {
        println!("✔ projects     {}", known.join(", "));
        return Ok(known.iter().map(|s| s.to_string()).collect());
    }

    println!("\nProjects assigned to this device:");
    for (i, slug) in known.iter().enumerate() {
        println!("  {}) {slug}", i + 1);
    }
    let answer = ask("Bind which? (numbers or names, comma-separated; Enter = all)")?;
    parse_selection(&answer, &known)
}

/// Read one answer to the project question. An answer naming something that is
/// not on the list is refused saying what is, rather than being dropped — a
/// silently ignored typo binds fewer projects than the operator asked for and
/// says nothing about it.
fn parse_selection(answer: &str, known: &[&str]) -> anyhow::Result<Vec<String>> {
    if answer.trim().is_empty() {
        return Ok(known.iter().map(|s| s.to_string()).collect());
    }
    answer
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|token| match token.parse::<usize>() {
            Ok(n) if n >= 1 && n <= known.len() => Ok(known[n - 1].to_string()),
            Ok(n) => Err(anyhow::anyhow!(
                "there is no project {n} in the list above (1-{})",
                known.len()
            )),
            Err(_) if known.contains(&token) => Ok(token.to_string()),
            Err(_) => Err(anyhow::anyhow!(
                "'{token}' is not one of: {}",
                known.join(", ")
            )),
        })
        .collect()
}

/// Provisioning resolves a checkout to the server's `repoPath`, else
/// `projects_root/<slug>`. With neither it resolves to nowhere and reports
/// `needs_manual_setup`, which is the most common way a fresh box ends up
/// online with jobs that never start — so setup settles it up front.
fn ensure_projects_root(args: &Args, chosen: &[String], interactive: bool) -> anyhow::Result<()> {
    let mut cfg = Config::load()?;
    if let Some(root) = args.projects_root.clone() {
        cfg.projects_root = Some(root);
        cfg.save()?;
    }
    if cfg.projects_root.is_some() || args.path.is_some() {
        if let Some(root) = cfg.projects_root.as_ref() {
            println!("✔ projects_root {}", root.display());
        }
        return Ok(());
    }

    let default = dirs_next::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("forge-projects");
    let root = if interactive {
        let answer = ask(&format!(
            "Where should checkouts live? [{}]",
            default.display()
        ))?;
        match answer.trim() {
            "" => default,
            other => PathBuf::from(shellexpand(other)),
        }
    } else {
        default
    };
    println!(
        "✔ projects_root {} ({} project(s))",
        root.display(),
        chosen.len()
    );
    cfg.projects_root = Some(root);
    cfg.save()?;
    Ok(())
}

async fn bind_one(
    client: &forge_runner_core::transport::CoreClient,
    slug: &str,
    path: Option<PathBuf>,
) -> anyhow::Result<()> {
    let assignment = super::bind::assignment_for(client, slug).await?;
    let path = match path {
        Some(p) => p.canonicalize().unwrap_or(p),
        None => super::bind::provision_checkout(client, &assignment).await?,
    };
    let bound = super::bind::write_binding(client, &assignment, slug, &path, None).await?;
    println!("✔ bound        {slug} → {}", bound.display());
    Ok(())
}

/// A box with systemd and no tty is a server: the service is what the operator
/// wants and asking would only stall an unattended install. At a terminal it is
/// a question, because a laptop running setup to try Forge is not a server.
fn ensure_service(args: &Args, interactive: bool) -> anyhow::Result<()> {
    if args.no_service {
        println!(
            "• service      skipped (--no-service) — run the daemon with `forge-runner start`"
        );
        return Ok(());
    }
    let wanted = args.service
        || if interactive {
            yes_no("Install the background service so it starts on boot?", true)?
        } else {
            true
        };
    if !wanted {
        println!("• service      skipped — run the daemon with `forge-runner start`");
        return Ok(());
    }
    super::service::install_now()?;
    println!("✔ service      installed and started");
    Ok(())
}

fn ask(prompt: &str) -> anyhow::Result<String> {
    print!("{prompt} ");
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    Ok(line.trim().to_string())
}

fn yes_no(prompt: &str, default_yes: bool) -> anyhow::Result<bool> {
    let hint = if default_yes { "[Y/n]" } else { "[y/N]" };
    let answer = ask(&format!("{prompt} {hint}"))?;
    Ok(match answer.to_ascii_lowercase().as_str() {
        "" => default_yes,
        "y" | "yes" => true,
        _ => false,
    })
}

/// `~` only — enough for a path typed at a prompt, and it does not pretend to
/// be a shell.
fn shellexpand(input: &str) -> String {
    match input.strip_prefix("~/") {
        Some(rest) => dirs_next::home_dir()
            .map(|h| h.join(rest).to_string_lossy().into_owned())
            .unwrap_or_else(|| input.to_string()),
        None => input.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOWN: [&str; 3] = ["forge-dev", "getcontent", "anhome"];

    #[test]
    fn an_empty_answer_takes_every_assignment() {
        assert_eq!(
            parse_selection("  ", &KNOWN).unwrap(),
            vec!["forge-dev", "getcontent", "anhome"]
        );
    }

    #[test]
    fn numbers_and_names_select_the_same_projects() {
        assert_eq!(
            parse_selection("1, 3", &KNOWN).unwrap(),
            vec!["forge-dev", "anhome"]
        );
        assert_eq!(
            parse_selection("anhome,forge-dev", &KNOWN).unwrap(),
            vec!["anhome", "forge-dev"]
        );
    }

    #[test]
    fn a_name_nobody_assigned_is_refused_naming_what_is() {
        let err = parse_selection("forge-dv", &KNOWN).unwrap_err().to_string();
        assert!(err.contains("forge-dv"), "{err}");
        assert!(err.contains("forge-dev, getcontent, anhome"), "{err}");
    }

    #[test]
    fn a_number_off_the_end_is_refused_rather_than_clamped() {
        let err = parse_selection("4", &KNOWN).unwrap_err().to_string();
        assert!(err.contains("no project 4"), "{err}");
    }

    #[test]
    fn a_tilde_path_expands_and_anything_else_is_left_alone() {
        let home = dirs_next::home_dir().unwrap();
        assert_eq!(
            shellexpand("~/code/forge"),
            home.join("code/forge").to_string_lossy()
        );
        assert_eq!(shellexpand("/srv/forge"), "/srv/forge");
        assert_eq!(shellexpand("$HOME/forge"), "$HOME/forge");
    }
}
