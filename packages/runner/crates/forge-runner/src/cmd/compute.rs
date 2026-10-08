use std::path::PathBuf;

use clap::Args as ClapArgs;

/// Run one computation in this box's sandbox, exactly as a `compute.run` from core would, and
/// print what it answered. The request file holds `{ language, script, inputs, limits }`; core is
/// not reached.
#[derive(ClapArgs)]
pub struct Args {
    /// A JSON request: `{ "language": "python" | "bash", "script", "inputs": [frames],
    /// "limits": { "wallMs", "cpu", "memoryMb", "outputBytes" } }`.
    #[arg(long)]
    request: PathBuf,
}

pub async fn run(args: Args) -> anyhow::Result<()> {
    let text = std::fs::read_to_string(&args.request)
        .map_err(|e| anyhow::anyhow!("{} could not be read: {e}", args.request.display()))?;
    let request: runner_platform::confine::compute::Request = serde_json::from_str(&text)
        .map_err(|e| anyhow::anyhow!("{} is not a compute request: {e}", args.request.display()))?;
    match runner_platform::confine::compute::run(&request).await {
        Ok(answer) => {
            println!("{}", serde_json::to_string_pretty(&answer)?);
            Ok(())
        }
        Err(why) => anyhow::bail!("the computation could not run on this box: {why}"),
    }
}
