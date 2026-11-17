//! A device's setup for Forge Boxes (ISS-1276): the root parts asked once, at a terminal, by
//! `forge-runner setup`; this user's parts installed by the runner; a pinned tool installed beside
//! its pin and moved only by a passing canary. This file is the only place a box part runs under
//! sudo, and it does so only for a person who said yes at a terminal: the daemon never sudoes.

use std::path::{Path, PathBuf};

use runner_box::setup::{self, RootPlan};
use runner_platform::config::Config;

/// Asks a person; answers no where there is nobody to ask.
pub trait Ask {
    fn yes(&mut self, prompt: &str) -> bool;
}

/// Runs one root command.
pub trait Exec {
    fn run(&mut self, argv: &[String]) -> Result<(), String>;
}

/// The commands that install `plan`, each a sudo argv; `rule_file` holds the udev rule to install.
pub fn root_commands(plan: &RootPlan, user: &str, rule_file: &Path) -> Vec<Vec<String>> {
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let mut out = Vec::new();
    if !plan.apt.is_empty() {
        let mut apt = v(&["sudo", "apt-get", "install", "-y"]);
        apt.extend(plan.apt.iter().cloned());
        out.push(apt);
    }
    if plan.kvm_group {
        out.push(v(&["sudo", "usermod", "-aG", "kvm", user]));
    }
    if plan.udev_rule {
        let rule = rule_file.to_string_lossy();
        out.push(v(&[
            "sudo",
            "install",
            "-m",
            "0644",
            &rule,
            setup::UDEV_RULE_PATH,
        ]));
        out.push(v(&["sudo", "udevadm", "control", "--reload-rules"]));
        out.push(v(&["sudo", "udevadm", "trigger", "--name-match=kvm"]));
    }
    out
}

/// What the root step did.
#[derive(Debug, PartialEq)]
pub enum Root {
    NothingMissing,
    Declined,
    Ran(usize),
}

/// Ask once, then run the root commands. Without a terminal nothing runs, and the refusal names
/// the commands for a person to run.
pub fn apply_root(
    commands: &[Vec<String>],
    interactive: bool,
    ask: &mut dyn Ask,
    exec: &mut dyn Exec,
) -> Result<Root, String> {
    if commands.is_empty() {
        return Ok(Root::NothingMissing);
    }
    let listed: Vec<String> = commands
        .iter()
        .map(|c| format!("  {}", c.join(" ")))
        .collect();
    if !interactive {
        return Err(format!(
            "BOX_SETUP_NEEDS_TERMINAL: boxes need root parts this device lacks, and only a person at a terminal is asked for sudo. Run `forge-runner setup` there, or these yourself:\n{}",
            listed.join("\n")
        ));
    }
    println!("Forge Boxes need these root parts:\n{}", listed.join("\n"));
    if !ask.yes("Run them now with sudo? [y/N] ") {
        return Ok(Root::Declined);
    }
    for c in commands {
        exec.run(c)?;
    }
    Ok(Root::Ran(commands.len()))
}

struct Terminal;

impl Ask for Terminal {
    fn yes(&mut self, prompt: &str) -> bool {
        use std::io::Write;
        print!("{prompt}");
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).is_ok() && matches!(line.trim(), "y" | "Y" | "yes")
    }
}

struct Sudo;

impl Exec for Sudo {
    fn run(&mut self, argv: &[String]) -> Result<(), String> {
        let status = std::process::Command::new(&argv[0])
            .args(&argv[1..])
            .status()
            .map_err(|e| format!("{}: {e}", argv.join(" ")))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("`{}` exited {status}", argv.join(" ")))
        }
    }
}

fn env_of(cfg: &Config) -> (runner_box::modes::Env, PathBuf) {
    let data = cfg.boxes.data_dir().unwrap_or_default();
    (runner_box::modes::Env::of_host(&cfg.boxes, &data), data)
}

/// `forge-runner setup`'s box step: the root parts asked once, then this user's parts.
pub async fn for_setup(cfg: &Config, interactive: bool) -> anyhow::Result<()> {
    println!("\nForge Boxes…");
    let (env, data) = env_of(cfg);
    let plan = setup::root_plan(&env, &setup::my_groups(), Path::new(setup::UDEV_RULE_PATH));
    std::fs::create_dir_all(&data)?;
    let rule_file = data.join("99-forge-kvm.rules");
    std::fs::write(&rule_file, setup::UDEV_RULE)?;
    let user = std::env::var("USER").unwrap_or_else(|_| "dev".into());
    match apply_root(
        &root_commands(&plan, &user, &rule_file),
        interactive,
        &mut Terminal,
        &mut Sudo,
    ) {
        Ok(Root::NothingMissing) => println!("  root parts: all present"),
        Ok(Root::Declined) => {
            println!("  root parts: declined; boxes that need them stay unserved")
        }
        Ok(Root::Ran(n)) => println!(
            "  root parts: {n} command(s) ran (a new kvm group takes effect at the next login)"
        ),
        Err(why) => println!("  {why}"),
    }
    user_space(cfg).await
}

/// This user's parts, adopting what stands; then what doctor says.
pub async fn user_space(cfg: &Config) -> anyhow::Result<()> {
    let (env, _) = env_of(cfg);
    for step in setup::user_space(&env, &cfg.boxes).await {
        match step.done {
            Ok(said) => println!("  [ok] {}: {said}", step.what),
            Err(why) => println!("  [--] {}: {why}", step.what),
        }
    }
    super::forge_box::doctor_rows(cfg);
    Ok(())
}

pub async fn install(tool: &str, version: &str) -> anyhow::Result<()> {
    let cfg = Config::load()?;
    anyhow::ensure!(
        matches!(tool, "agent-browser" | "agent-desktop" | "agent-device"),
        "`{tool}` is not an npm box tool: agent-browser, agent-desktop or agent-device"
    );
    let (env, _) = env_of(&cfg);
    let bin = setup::install_npm(&env, tool, version)
        .await
        .map_err(anyhow::Error::msg)?;
    println!("{tool} {version} installed at {}; the pin stays {} until `forge-runner box canary {tool} {version}` passes",
        bin.display(), cfg.boxes.pin(tool).unwrap_or("unset"));
    Ok(())
}

pub async fn canary(tool: &str, version: &str, dry_run: bool) -> anyhow::Result<()> {
    let mut cfg = Config::load()?;
    let scratch = cfg
        .boxes
        .data_dir()
        .unwrap_or_default()
        .join("canary")
        .join(format!("{tool}-{version}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&scratch)?;
    let checks = runner_box::canary::run(&cfg.boxes, tool, version, &scratch).await;
    for c in &checks {
        println!(
            "{} {:<10} {}",
            if c.passed { "pass" } else { "FAIL" },
            c.name,
            c.detail
        );
    }
    if let Some(failed) = checks.iter().find(|c| !c.passed) {
        anyhow::bail!(
            "BOX_CANARY_FAILED: {}; the pin stays {:?}",
            failed.name,
            cfg.boxes.pin(tool)
        );
    }
    if dry_run {
        println!("passed; --dry-run: the pin is left as it is");
        return Ok(());
    }
    cfg.boxes.set_pin(tool, version);
    cfg.save()?;
    println!("passed; the {tool} pin is now {version}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Answer(bool, usize);
    impl Ask for Answer {
        fn yes(&mut self, _: &str) -> bool {
            self.1 += 1;
            self.0
        }
    }
    #[derive(Default)]
    struct Ran(Vec<Vec<String>>);
    impl Exec for Ran {
        fn run(&mut self, argv: &[String]) -> Result<(), String> {
            self.0.push(argv.to_vec());
            Ok(())
        }
    }

    fn plan() -> RootPlan {
        RootPlan {
            apt: vec!["scrcpy".into(), "ffmpeg".into()],
            kvm_group: true,
            udev_rule: true,
        }
    }

    #[test]
    fn without_a_terminal_setup_runs_no_sudo_and_names_the_commands() {
        let cmds = root_commands(&plan(), "dev", Path::new("/tmp/rule"));
        let (mut ask, mut ran) = (Answer(true, 0), Ran::default());
        let err = apply_root(&cmds, false, &mut ask, &mut ran).unwrap_err();
        assert!(err.starts_with("BOX_SETUP_NEEDS_TERMINAL"), "{err}");
        assert!(
            err.contains("sudo apt-get install -y scrcpy ffmpeg"),
            "{err}"
        );
        assert_eq!((ask.1, ran.0.len()), (0, 0), "nobody asked, nothing ran");
    }

    #[test]
    fn at_a_terminal_a_person_is_asked_once_and_a_no_runs_nothing() {
        let cmds = root_commands(&plan(), "dev", Path::new("/tmp/rule"));
        let (mut ask, mut ran) = (Answer(false, 0), Ran::default());
        assert_eq!(
            apply_root(&cmds, true, &mut ask, &mut ran),
            Ok(Root::Declined)
        );
        assert_eq!((ask.1, ran.0.len()), (1, 0));
        let (mut ask, mut ran) = (Answer(true, 0), Ran::default());
        assert_eq!(
            apply_root(&cmds, true, &mut ask, &mut ran),
            Ok(Root::Ran(5))
        );
        assert_eq!(ask.1, 1, "asked once for every command");
        assert_eq!(ran.0[1], vec!["sudo", "usermod", "-aG", "kvm", "dev"]);
        assert_eq!(ran.0[2][..4], ["sudo", "install", "-m", "0644"]);
        assert!(apply_root(&[], false, &mut ask, &mut ran) == Ok(Root::NothingMissing));
    }
}
