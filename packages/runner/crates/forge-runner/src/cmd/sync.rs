//! `forge-runner sync` — on-demand skill pull (ISS-740) and orientation write
//! (ISS-1066).
//!
//! Independent one-shot: runs the exact pull path behind the ISS-736
//! background poller (`sync_bound_projects`), reads the same config dir the
//! daemon uses (`FORGE_RUNNER_CONFIG_DIR`, else `XDG_CONFIG_HOME`), and never
//! reads/writes `auto_pull` —
//! it can run alongside a running `forge-runner start` with no coordination.
//! It then writes the orientation core serves now into each checkout
//! (`checkout_passes::sync_orientations`), under the checkout's provision lock
//! a running daemon takes too, whatever revision that daemon last wrote.

use clap::Args as ClapArgs;
use runner_daemon::{checkout_passes, skill_pull};
use runner_platform::config::Config;
use runner_platform::cred_store;
use runner_transport::CoreClient;

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    /// Sync only this bound project (slug): its skills and its checkout's
    /// orientation. Default = every bound project with a local repo path.
    #[arg(long)]
    project: Option<String>,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let cfg = Config::load()?;

    let (core_url, token) = match (ctx.resolve_core_url(&cfg), cred_store::load_device_token()?) {
        (Some(u), Some(t)) => (u, t),
        _ => anyhow::bail!("not logged in — run `forge-runner login` first"),
    };
    let client = CoreClient::new(core_url, token);
    let results = skill_pull::sync_bound_projects(&client, &cfg, args.project.as_deref()).await?;
    let oriented =
        checkout_passes::sync_orientations(&client, &cfg, args.project.as_deref()).await?;

    if results.is_empty() && oriented.is_empty() {
        println!("No bound projects with a local repo path to sync.");
        return Ok(());
    }

    let mut had_error = false;
    for r in &results {
        match &r.outcome {
            Ok(n) => println!(
                "  {:<24} synced {n} skill(s) into {}",
                r.slug,
                r.repo_path.join(".claude/skills").display()
            ),
            Err(msg) => {
                had_error = true;
                eprintln!("  {:<24} ERROR: {msg}", r.slug);
            }
        }
    }
    for line in orientation_lines(&oriented, args.project.as_deref()) {
        match line {
            Ok(said) => println!("{said}"),
            Err(said) => {
                had_error = true;
                eprintln!("{said}");
            }
        }
    }

    if had_error {
        std::process::exit(1);
    }
    Ok(())
}

/// One line per checkout the orientation write covered, an error where it did
/// not orient it, and an error naming `only` where no checkout here is bound to it.
fn orientation_lines(
    oriented: &[runner_workspace::orientation_record::Entry],
    only: Option<&str>,
) -> Vec<Result<String, String>> {
    let mut lines: Vec<Result<String, String>> = oriented
        .iter()
        .map(|e| {
            let said = format!(
                "  {:<24} orientation {}",
                e.slug,
                e.outcome.says(&e.path, &e.build)
            );
            if e.outcome.oriented() {
                Ok(said)
            } else {
                Err(said)
            }
        })
        .collect();
    if let (Some(slug), true) = (only, oriented.is_empty()) {
        lines.push(Err(format!(
            "  {slug:<24} ERROR: no checkout on this box is bound to '{slug}', so no orientation was written"
        )));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use runner_workspace::orientation_record::{Entry, Outcome, Point};
    use std::path::Path;

    #[test]
    fn each_checkout_the_sync_covered_gets_a_line_and_a_slug_bound_nowhere_is_an_error() {
        let written = Entry::now(
            "forge",
            Path::new("/w/forge"),
            Point::Sync,
            Outcome::Written,
        );
        let refused = Entry::now(
            "epod",
            Path::new("/w/epod"),
            Point::Sync,
            Outcome::Refused {
                detail: "PROVISION_WOULD_REWRITE_TRACKED: x".into(),
            },
        );
        let lines = orientation_lines(&[written, refused], None);
        assert!(
            matches!(&lines[0], Ok(l) if l.contains("forge") && l.contains("orientation written by") && l.contains("/w/forge")),
            "{lines:?}"
        );
        assert!(
            matches!(&lines[1], Err(l) if l.contains("PROVISION_WOULD_REWRITE_TRACKED")),
            "{lines:?}"
        );
        let nowhere = orientation_lines(&[], Some("nope"));
        assert!(
            matches!(&nowhere[..], [Err(l)] if l.contains("no checkout on this box is bound to 'nope'")),
            "{nowhere:?}"
        );
        assert!(orientation_lines(&[], None).is_empty());
    }
}
