//! `forge-runner master status`, run as the binary an operator runs, for a
//! project whose master the daemon refused to place (ISS-1390 criterion 6).
//!
//! The daemon's sweep keeps why it placed no pane beside the project's
//! transcript; this command runs in a process of its own and asks the daemon
//! nothing, so that record is the only way the refusal reaches it.
//!
//! Every call runs with a PATH holding one empty directory, so no `tmux` is
//! found: the box `master status` has to answer on is one without it, which
//! is where the daemon keeps its "tmux is not installed" refusal, and which
//! is the macOS and Windows legs' box whatever the host running the test has.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use forge_runner_core::daemon::pane_path::Unresolved;
use forge_runner_core::daemon::unplaced_record::{self, Record};
use forge_runner_core::test_scratch::Scratch;

/// The variables the child's temp dir is read from, on every platform.
///
/// A test build honours `XDG_CONFIG_HOME` only where it is under the temp dir
/// the binary itself resolves. `env_clear` leaves Windows no `TMP` or `TEMP`,
/// so the child's temp dir fell back to another directory, the scratch read as
/// the box's own and every record was refused there: the Windows leg's red.
const TEMP_VARS: [&str; 3] = ["TMPDIR", "TMP", "TEMP"];

fn master(home: &Scratch, args: &[&str]) -> Output {
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_forge-runner"));
    cmd.env_clear();
    for var in TEMP_VARS {
        if let Some(value) = std::env::var_os(var) {
            cmd.env(var, value);
        }
    }
    cmd.arg("master")
        .args(args)
        .env("PATH", &bin)
        .env("HOME", home.join("h"))
        .env("XDG_CONFIG_HOME", home.join("c"))
        .env("XDG_DATA_HOME", home.join("d"))
        .env("FORGE_RUNNER_CRED_STORE", "file")
        .output()
        .expect("the binary runs")
}

fn status(home: &Scratch, slug: &str) -> Output {
    master(home, &["status", slug])
}

/// Every `ledger.sqlite` under `dir`, at any depth.
fn ledgers_under(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            found.extend(ledgers_under(&path));
        } else if path.file_name().is_some_and(|n| n == "ledger.sqlite") {
            found.push(path);
        }
    }
    found
}

#[test]
fn a_master_refused_for_its_path_is_said_on_status_naming_each_binary_and_the_path() {
    let home = Scratch::short("mst-refused");
    let dir = home
        .join("c")
        .join("forge-runner")
        .join("master")
        .join("plantslug");
    let before = status(&home, "plantslug");
    let said = String::from_utf8_lossy(&before.stdout);
    assert!(
        before.status.success(),
        "{said}{}",
        String::from_utf8_lossy(&before.stderr)
    );
    assert!(
        !said.contains(" unplaced  "),
        "nothing recorded, nothing said: {said}"
    );
    assert!(
        said.contains("tmux is not on this command's PATH"),
        "a status that could ask no tmux says so: {said}"
    );
    let pane = said
        .lines()
        .find(|l| l.contains(" pane  "))
        .unwrap_or_else(|| panic!("status prints the pane line: {said}"));
    assert!(
        pane.contains(" unknown "),
        "a pane no tmux was asked about is unknown, never gone: {pane}"
    );

    let detail = Unresolved {
        missing: vec!["forge-runner".into(), "node".into()],
        path: "/usr/local/bin:/usr/bin".into(),
        claude: Some("/usr/local/bin/claude".into()),
    }
    .to_string();
    unplaced_record::write(
        &dir,
        &Record {
            since: 0,
            pid: 4242,
            lead: "no master pane placed".into(),
            why: detail,
        },
    )
    .unwrap();
    let out = status(&home, "plantslug");
    let said = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{said}");
    let line = said
        .lines()
        .find(|l| l.contains(" unplaced  "))
        .unwrap_or_else(|| panic!("master status says why no pane was placed: {said}"));
    for named in [
        "no master pane placed",
        "`forge-runner`, `node`",
        "(/usr/local/bin:/usr/bin)",
        "pid 4242",
    ] {
        assert!(line.contains(named), "the line names {named}: {line}");
    }

    unplaced_record::clear(&dir).unwrap();
    let after = status(&home, "plantslug");
    assert!(
        after.status.success(),
        "{}",
        String::from_utf8_lossy(&after.stderr)
    );
    assert!(
        !String::from_utf8_lossy(&after.stdout).contains(" unplaced  "),
        "a placement that cleared the record leaves nothing said"
    );
    assert_eq!(
        ledgers_under(home.path()),
        Vec::<PathBuf>::new(),
        "status reads the box's ledger and creates none where there was none"
    );
}

#[test]
fn a_box_without_tmux_still_reads_a_masters_transcript() {
    let home = Scratch::short("mst-log");
    let dir = home
        .join("c")
        .join("forge-runner")
        .join("master")
        .join("plantslug");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("transcript.log"), "first\nsecond\nthird\n").unwrap();
    let out = master(&home, &["log", "plantslug", "--lines", "2"]);
    let said = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "{said}{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        said.contains("second\nthird") && !said.contains("first"),
        "the last two lines, and only those: {said}"
    );
}

#[test]
fn a_verb_that_drives_a_pane_is_still_refused_without_tmux() {
    let home = Scratch::short("mst-say");
    let out = master(&home, &["say", "plantslug", "hello"]);
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "say ran with no tmux: {err}");
    assert!(
        err.contains("tmux is not installed on this box"),
        "the refusal names tmux: {err}"
    );
}

/// The read-only open still reads what a daemon wrote. That it writes nothing
/// is the first test's: a migrated ledger reopened read-write changes no byte,
/// so only a ledger that was not there can show a write.
///
/// On every platform: a test build resolves the ledger's data dir from a
/// scratch `XDG_DATA_HOME` wherever `dirs_next` ignores it (ISS-1344).
#[test]
fn status_reads_a_stand_down_through_a_read_only_ledger() {
    use forge_runner_core::runner::ledger::Ledger;

    let home = Scratch::short("mst-ledger");
    let path = home.join("d").join("forge-runner").join("ledger.sqlite");
    Ledger::open(&path)
        .unwrap()
        .stand_down_master("p-1", "plantslug", "owner", "waiting on the planted wait")
        .unwrap();

    let out = status(&home, "plantslug");
    let said = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "{said}{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let standing = said
        .lines()
        .find(|l| l.contains(" standing  "))
        .unwrap_or_else(|| panic!("status prints the standing line: {said}"));
    assert!(
        standing.contains("STOOD DOWN by owner")
            && standing.contains("waiting on the planted wait"),
        "the stand-down is read through the read-only ledger: {standing}"
    );
}
