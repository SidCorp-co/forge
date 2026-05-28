use std::path::PathBuf;

use clap::Args as ClapArgs;
use forge_runner_core::config::{Binding, Config};

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    /// Project slug (as shown in Forge).
    pub slug: String,
    /// Path to an EXISTING local checkout (preferred — no re-clone).
    #[arg(long)]
    pub path: Option<PathBuf>,
    /// Core project id (uuid) — required for jobs to route to this binding.
    #[arg(long)]
    pub project_id: Option<String>,
    /// Default branch for this binding.
    #[arg(long)]
    pub branch: Option<String>,
    /// (planned M4) auto-clone under projects_root if no local repo exists.
    #[arg(long)]
    pub clone: bool,
}

pub async fn run(_ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let Some(path) = args.path else {
        return super::stub(
            "bind (auto-detect/clone)",
            "M4 — hiện hãy trỏ repo có sẵn bằng `--path <dir>`",
        );
    };

    let path = path.canonicalize().unwrap_or(path);
    if !path.join(".git").exists() {
        eprintln!(
            "⚠ {} không có `.git` — vẫn lưu binding, nhưng kiểm tra lại path.",
            path.display()
        );
    }
    if args.project_id.is_none() {
        eprintln!(
            "⚠ chưa có --project-id: job sẽ KHÔNG route được tới binding này cho đến khi set."
        );
    }

    let mut cfg = Config::load()?;
    cfg.bindings.insert(
        args.slug.clone(),
        Binding {
            repo_path: path.clone(),
            branch: args.branch,
            project_id: args.project_id,
        },
    );
    cfg.save()?;

    println!("✔ bound {} → {}", args.slug, path.display());
    Ok(())
}
