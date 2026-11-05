//! `run declare` over a tree that stands, and with `--cut`, against a real repository and the
//! daemon's own declaration path (ISS-1016).

use super::super::*;
use super::Cut;
use runner_core::ledger::TreeOrigin;
use runner_platform::subagent_host::{Host, HostRead, Hosts, Running};

const MASTER: &str = "sess-a";
const PROJECT: &str = "proj-1";
/// The pid of the process that declares, as the control socket reads its peer.
const PEER: u32 = 4242;

/// A process table whose every Claude Code process works in one checkout: the master's.
struct MasterIn(PathBuf);
impl Hosts for MasterIn {
    fn read(&self, _pid: u32, _start: &str) -> HostRead {
        HostRead::Alive
    }
    fn above(&self, peer: u32) -> Option<Host> {
        Some(Host {
            pid: peer,
            start: "1".into(),
        })
    }
    fn running(&self, _conversation: &str) -> Running {
        Running::Unreadable
    }
    fn beneath(&self, _pid: u32, _start: &str, _ancestor: u32) -> HostRead {
        HostRead::Alive
    }
    fn cwd(&self, _pid: u32) -> Option<PathBuf> {
        Some(self.0.clone())
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A scratch directory holding a repository with one commit and the master's own batch tree at
/// `<repo>/.claude/worktrees/batch-iss-82`, removed when the test ends.
struct Box_ {
    dir: PathBuf,
    repo: PathBuf,
    batch: PathBuf,
}
impl Box_ {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("forge-declare-cut-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(
            &repo,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "one",
            ],
        );
        let batch = repo.join(".claude/worktrees/batch-iss-82");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "batch",
                batch.to_str().unwrap(),
            ],
        );
        Self { dir, repo, batch }
    }

    fn ctl(&self, hosts: Arc<dyn Hosts>) -> Arc<Control> {
        let masters = Arc::new(crate::master::Masters::default());
        masters.remember(
            PROJECT,
            crate::master::MasterState {
                session_id: MASTER.into(),
                name: "forge-master-proj".into(),
                last_work: std::time::Instant::now(),
                last_nudge: None,
                mcp_stale_reported: false,
            },
        );
        Arc::new(Control {
            tokens: crate::session_tokens::SessionTokens::at(self.dir.join("tokens.json")),
            activity: Arc::new(runner_core::agent_activity::Activities::new()),
            masters,
            ledger: Arc::new(std::sync::Mutex::new(Some(
                runner_core::ledger::Ledger::open(&self.dir.join("ledger.db")).unwrap(),
            ))),
            boot_id: "boot-1".into(),
            config_dir: Some(self.dir.clone()),
            promises: std::sync::Mutex::new(GateMemory::default()),
            drain: Arc::new(crate::drain::Drain::new(None)),
            hosts,
            core: None,
        })
    }

    /// The control as the box runs it for a master pane working in this repository.
    fn master_ctl(&self) -> Arc<Control> {
        self.ctl(Arc::new(MasterIn(self.repo.clone())))
    }
}
impl Drop for Box_ {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn declare(
    ctl: &Arc<Control>,
    key: &str,
    tree: &Path,
    cut: Option<Cut<'_>>,
    peer: Option<u32>,
) -> ClaimReply {
    run_declare_as(
        ctl,
        &Holder::Legacy {
            session: MASTER.into(),
        },
        Declaration {
            project_id: PROJECT,
            issue_keys: &[key.to_string()],
            worktree_path: &tree.to_string_lossy(),
            role: None,
            requirement: None,
            cut,
        },
        MASTER,
        peer,
    )
    .await
}

fn origin_of(ctl: &Arc<Control>, run_id: &str) -> TreeOrigin {
    let held = ctl.ledger.lock().unwrap();
    held.as_ref()
        .unwrap()
        .run(run_id)
        .unwrap()
        .unwrap()
        .worktree_origin
}

fn runs(ctl: &Arc<Control>) -> usize {
    let held = ctl.ledger.lock().unwrap();
    held.as_ref()
        .unwrap()
        .runs_for_master(MASTER)
        .unwrap()
        .len()
}

/// FB-522: the master's own batch tree, declared over to read one secret, is recorded as adopted
/// — which is what every release and the reaper then leave in place.
#[tokio::test]
async fn a_tree_that_already_stands_is_declared_adopted() {
    let b = Box_::new();
    let ctl = b.master_ctl();
    let reply = declare(&ctl, "ISS-74", &b.batch, None, Some(PEER)).await;
    assert!(reply.ok, "{reply:?}");
    assert_eq!(
        origin_of(&ctl, &reply.job_id.unwrap()),
        TreeOrigin::Adopted,
        "a tree that stood before the declaration was recorded as cut for the run"
    );
}

/// `--cut` has the box cut the tree from the master's checkout on a new branch, and the run is
/// recorded as having created it.
#[tokio::test]
async fn a_tree_cut_by_the_declaration_is_recorded_created() {
    let b = Box_::new();
    let ctl = b.master_ctl();
    let tree = b.repo.join(".claude/worktrees/iss-75");
    let cut = Cut {
        branch: "fix/iss-75",
        from: Some("main"),
    };
    let reply = declare(&ctl, "ISS-75", &tree, Some(cut), Some(PEER)).await;
    assert!(reply.ok, "{reply:?}");
    assert_eq!(
        git(&tree, &["symbolic-ref", "--short", "HEAD"]),
        "fix/iss-75"
    );
    assert_eq!(
        git(&tree, &["rev-parse", "HEAD"]),
        git(&b.repo, &["rev-parse", "main"])
    );
    assert_eq!(origin_of(&ctl, &reply.job_id.unwrap()), TreeOrigin::Created);
}

/// A cut over a path that stands is refused by name, cuts nothing and records nothing: the tree is
/// somebody's, and the way to work in it is to adopt it.
#[tokio::test]
async fn a_cut_over_a_tree_that_stands_is_refused_and_records_nothing() {
    let b = Box_::new();
    let ctl = b.master_ctl();
    let cut = Cut {
        branch: "other",
        from: None,
    };
    let reply = declare(&ctl, "ISS-76", &b.batch, Some(cut), Some(PEER)).await;
    assert!(!reply.ok, "{reply:?}");
    let why = reply.reason.unwrap_or_default();
    assert!(
        why.contains("already exists") && why.contains("without `--cut`"),
        "{why}"
    );
    assert!(why.contains("Nothing was recorded"), "{why}");
    assert_eq!(runs(&ctl), 0);
    assert_eq!(git(&b.batch, &["symbolic-ref", "--short", "HEAD"]), "batch");
}

/// Where the master's checkout cannot be read there is no repository to cut from: refused, and
/// nothing is cut.
#[tokio::test]
async fn a_cut_with_no_checkout_to_cut_from_is_refused() {
    let b = Box_::new();
    let ctl = b.ctl(Arc::new(runner_platform::subagent_host::ProcHosts::system()));
    let tree = b.repo.join(".claude/worktrees/iss-77");
    let cut = Cut {
        branch: "iss-77",
        from: None,
    };
    let reply = declare(&ctl, "ISS-77", &tree, Some(cut), None).await;
    assert!(!reply.ok, "{reply:?}");
    assert!(
        reply
            .reason
            .unwrap_or_default()
            .contains("no repository to cut"),
        "refused for another reason"
    );
    assert!(!tree.exists());
    assert_eq!(runs(&ctl), 0);
}

/// A tree cut for a declaration the ledger then refuses is taken back with its branch, so a refused
/// declaration leaves the repository as it found it.
#[tokio::test]
async fn a_cut_the_ledger_refuses_is_taken_back() {
    let b = Box_::new();
    let ctl = b.master_ctl();
    // An unbound run of this master's: the ledger refuses the next declaration until it binds.
    assert!(declare(&ctl, "ISS-78", &b.batch, None, Some(PEER)).await.ok);
    let tree = b.repo.join(".claude/worktrees/iss-79");
    let cut = Cut {
        branch: "iss-79",
        from: None,
    };
    let reply = declare(&ctl, "ISS-79", &tree, Some(cut), Some(PEER)).await;
    assert!(!reply.ok, "{reply:?}");
    assert!(
        reply
            .reason
            .unwrap_or_default()
            .contains("no subagent has bound it"),
        "refused for another reason"
    );
    assert!(
        !tree.exists(),
        "the refused declaration's tree is still on disk"
    );
    assert_eq!(git(&b.repo, &["branch", "--list", "iss-79"]), "");
    assert_eq!(runs(&ctl), 1);
}
