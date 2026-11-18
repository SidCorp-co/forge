//! A fake `claude` for this module's tests: a script over a state directory, answering the verbs
//! the box runs (`agents --json`, `stop`, `--bg`) from files the test writes, and recording each
//! call. Set as this thread's `claude` ([`super::FAKE_CLAUDE`]) while it lives, so a test never
//! reaches this box's own background service.

use std::path::{Path, PathBuf};

pub(crate) struct FakeClaude {
    pub(crate) dir: PathBuf,
}

const SCRIPT: &str = r#"#!/bin/sh
state='STATE'
case "$1" in
  agents)
    if [ -f "$state/holder" ] && ! kill -0 "$(cat "$state/holder")" 2>/dev/null; then
      cat "$state/freed.json"
    else
      cat "$state/roster.json"
    fi ;;
  stop)
    echo "$2" >> "$state/stops"
    if [ -f "$state/on-stop.json" ]; then cp "$state/on-stop.json" "$state/roster.json"; fi ;;
  --bg)
    echo "$*" >> "$state/launches"
    if [ -f "$state/on-bg.json" ]; then
      cp "$state/on-bg.json" "$state/roster.json"
      cp "$state/on-bg.json" "$state/freed.json"
    fi
    cat "$state/bg-said" ;;
  *) echo "fake claude: no answer for $*" >&2; exit 2 ;;
esac
"#;

impl FakeClaude {
    /// A fake whose roster is `roster` (the JSON `claude agents --json` prints).
    pub(crate) fn new(tag: &str, roster: &str) -> Self {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!(
            "forge-fake-claude-{}-{tag}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("claude");
        let body = SCRIPT.replace("STATE", &dir.to_string_lossy());
        let staged = dir.join("claude.staged");
        std::fs::write(&staged, body).unwrap();
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::rename(&staged, &script).unwrap();
        let fake = Self { dir };
        fake.write("roster.json", roster);
        super::FAKE_CLAUDE.with(|f| *f.borrow_mut() = Some(script));
        fake
    }

    /// What `claude --bg` prints, and the roster it leaves (`None`: unchanged).
    pub(crate) fn on_bg(&self, said: &str, roster_after: Option<&str>) {
        self.write("bg-said", said);
        if let Some(r) = roster_after {
            self.write("on-bg.json", r);
        }
    }

    /// The roster a `claude stop` leaves; without one, a stop takes nothing.
    pub(crate) fn on_stop(&self, roster_after: &str) {
        self.write("on-stop.json", roster_after);
    }

    /// Replace the roster `claude agents --json` prints.
    pub(crate) fn roster(&self, roster: &str) {
        self.write("roster.json", roster);
    }

    /// The roster printed once the process `pid` has exited, as a session's leaves the roster
    /// with its process.
    pub(crate) fn freed_when_gone(&self, pid: u32, roster_after: &str) {
        self.write("freed.json", roster_after);
        self.write("holder", &pid.to_string());
    }

    /// The calls recorded under `what` (`stops`, `launches`), one a line.
    pub(crate) fn calls(&self, what: &str) -> String {
        std::fs::read_to_string(self.dir.join(what)).unwrap_or_default()
    }

    fn write(&self, name: &str, body: &str) {
        std::fs::write(self.at(name), body).unwrap();
    }

    fn at(&self, name: &str) -> PathBuf {
        Path::new(&self.dir).join(name)
    }
}

impl Drop for FakeClaude {
    fn drop(&mut self) {
        super::FAKE_CLAUDE.with(|f| *f.borrow_mut() = None);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
