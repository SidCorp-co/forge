use super::*;

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS runs (
  run_id              TEXT PRIMARY KEY,
  project_id          TEXT,
  master_session_id   TEXT NOT NULL,
  session_id          TEXT,
  worktree_path       TEXT NOT NULL,
  pid                 INTEGER,
  boot_id             TEXT NOT NULL,
  incarnation         TEXT NOT NULL,
  work                TEXT NOT NULL,
  blocker_kind        TEXT,
  waiting_on          TEXT,
  resume_id           TEXT,
  park_deadline_at    INTEGER,
  session_terminal_at INTEGER,
  worktree_gone_at    INTEGER,
  released_as         TEXT,
  claim_owner         TEXT,
  claim_generation    INTEGER NOT NULL DEFAULT 0,
  claim_expires_at    INTEGER,
  revival_token       TEXT,
  revival_deadline_at INTEGER,
  ended_by            TEXT,
  ended_reason        TEXT,
  created_at          INTEGER NOT NULL,
  agent_id            TEXT,
  resume_choice       TEXT,
  resume_choice_why   TEXT,
  resume_owed_at      INTEGER,
  release_refused_at  INTEGER,
  release_refusal     TEXT,
  release_terminal_at INTEGER,
  release_attempts    INTEGER NOT NULL DEFAULT 0,
  turn_ended_at_ms    INTEGER,
  agent_transcript    TEXT,
  kept_notice         TEXT,
  host_ended_at_ms    INTEGER,
  host_ended_by       TEXT,
  host_pid            INTEGER,
  host_start          TEXT,
  refusal_wrote_ending INTEGER
);
CREATE TABLE IF NOT EXISTS run_issues (
  run_id            TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  issue_key         TEXT NOT NULL,
  lease_returned_at INTEGER,
  PRIMARY KEY (run_id, issue_key)
);
CREATE TABLE IF NOT EXISTS questions (
  question_id TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  round       INTEGER NOT NULL,
  asked_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  verb        TEXT NOT NULL,
  decided_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS masters (
  project_id      TEXT PRIMARY KEY,
  pane_name       TEXT NOT NULL,
  conversation_id TEXT,
  session_id      TEXT,
  boot_id         TEXT NOT NULL,
  cold_started_at INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS master_standing (
  episode       INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL,
  slug          TEXT NOT NULL,
  stood_down_at INTEGER NOT NULL,
  stood_down_by TEXT NOT NULL,
  why           TEXT,
  stood_up_at   INTEGER,
  stood_up_by   TEXT,
  stood_up_why  TEXT,
  told_at       INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS master_standing_open
  ON master_standing (project_id) WHERE stood_up_at IS NULL;
CREATE TABLE IF NOT EXISTS master_passes (
  project_id       TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  pass_id          TEXT NOT NULL,
  verb             TEXT NOT NULL,
  issue_key        TEXT,
  opened_at        INTEGER NOT NULL,
  opened_by        TEXT NOT NULL,
  prompts_at_nudge INTEGER
);
CREATE TABLE IF NOT EXISTS master_authority (
  project_id      TEXT PRIMARY KEY,
  slug            TEXT NOT NULL,
  pane_name       TEXT NOT NULL,
  pane_incarnation TEXT,
  verdict         TEXT NOT NULL,
  detail          TEXT,
  since           INTEGER NOT NULL,
  seen_at         INTEGER NOT NULL
);
";

/// Columns a build added after the table shipped, by table. A ledger written by
/// an older binary gains them on open, so an upgraded box reads rather than
/// fails.
pub(crate) const ADDED_COLUMNS: &[(&str, &str, &str)] = &[
    ("runs", "project_id", "TEXT"),
    ("runs", "claim_owner", "TEXT"),
    ("runs", "claim_generation", "INTEGER NOT NULL DEFAULT 0"),
    ("runs", "claim_expires_at", "INTEGER"),
    ("runs", "revival_token", "TEXT"),
    ("runs", "revival_deadline_at", "INTEGER"),
    ("runs", "ended_by", "TEXT"),
    ("runs", "ended_reason", "TEXT"),
    ("runs", "agent_id", "TEXT"),
    ("runs", "resume_choice", "TEXT"),
    ("runs", "resume_choice_why", "TEXT"),
    ("runs", "resume_owed_at", "INTEGER"),
    ("runs", "release_refused_at", "INTEGER"),
    ("runs", "release_refusal", "TEXT"),
    ("runs", "release_terminal_at", "INTEGER"),
    ("runs", "release_attempts", "INTEGER NOT NULL DEFAULT 0"),
    ("runs", "released_as", "TEXT"),
    ("runs", "turn_ended_at_ms", "INTEGER"),
    ("runs", "agent_transcript", "TEXT"),
    ("runs", "kept_notice", "TEXT"),
    ("runs", "host_ended_at_ms", "INTEGER"),
    ("runs", "host_ended_by", "TEXT"),
    ("runs", "host_pid", "INTEGER"),
    ("runs", "host_start", "TEXT"),
    ("runs", "refusal_wrote_ending", "INTEGER"),
    ("masters", "session_id", "TEXT"),
    ("masters", "placed_build", "TEXT"),
    ("masters", "placed_plugins", "TEXT"),
    ("masters", "placed_at", "INTEGER"),
    ("masters", "outdated", "TEXT"),
    ("masters", "unattributed", "TEXT"),
];

impl Ledger {
    /// Open (and migrate) the ledger at `path`, creating its directory.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path).map_err(sql_err)?;
        Self::from_conn(conn)
    }

    /// `~/.local/share/forge-runner/ledger.sqlite` for the box's own daemon; `ledger.sqlite` in
    /// the config dir for a daemon run under a config dir of its own.
    pub fn default_path() -> Result<PathBuf> {
        let base = runner_platform::config::base_dir()?;
        // cm:guard the OS data dir is per user, not per daemon: a second daemon reading it sweeps
        // the first one's runs and stamps them closed at its own core (ISS-10)
        if !runner_platform::config::is_the_boxs_own_config_dir(&base) {
            return Ok(base.join("ledger.sqlite"));
        }
        let dir = dirs_next::data_dir()
            .ok_or_else(|| Error::Other("ledger: cannot resolve OS data dir".into()))?;
        Ok(dir.join("forge-runner").join("ledger.sqlite"))
    }

    /// Open the ledger at `path` for reading only: no migration, no directory
    /// created, and any write through it refused by SQLite. For a command an
    /// operator types, which must leave a live box's ledger as it found it.
    pub fn open_read_only(path: &Path) -> Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(sql_err)?;
        conn.busy_timeout(Duration::from_secs(2)).map_err(sql_err)?;
        Ok(Self { conn })
    }

    pub(crate) fn from_conn(mut conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
            .map_err(sql_err)?;
        Self::migrate(&mut conn)?;
        Ok(Self { conn })
    }

    /// Bring the ledger to this build's shape, under one write lock.
    ///
    /// The lock is the subject. Deciding which columns are missing and adding
    /// them are two statements, and one box has many openers of this one file:
    /// the daemon's start, its reaper tick, its control socket, its
    /// session-ledger tick, and every CLI call. On the first start after an
    /// upgrade they all migrate at once, and with no lock between the two
    /// statements each reads the old shape before any `ALTER` has landed — the
    /// winner adds the column and every other opener is refused `duplicate
    /// column name`, which is `Ledger::open` returning an error to callers that
    /// then do nothing for the life of the process (ISS-1201). `IMMEDIATE`
    /// takes the write lock before the first read, so a second opener waits the
    /// first out on the `busy_timeout` set above and then reads a table already
    /// at this build's shape, with nothing left to alter.
    ///
    /// One transaction over all three steps for the same reason the lock is
    /// taken at all: a migration that fails part-way leaves the shape its
    /// opener found, rather than one no build has a name for.
    pub(crate) fn migrate(conn: &mut Connection) -> Result<()> {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_err)?;
        let carried = Self::set_aside_the_one_row_standing(&tx)?;
        tx.execute_batch(SCHEMA).map_err(sql_err)?;
        Self::add_missing_columns(&tx)?;
        Self::carry_the_old_mark_forward(&tx)?;
        Self::carry_the_refusal_ending_forward(&tx)?;
        Self::carry_the_standing_forward(&tx, carried)?;
        tx.commit().map_err(sql_err)
    }

    /// Move a pre-ISS-1238 `master_standing` out of the way, so `SCHEMA`'s
    /// `CREATE TABLE IF NOT EXISTS` builds the episode table rather than
    /// finding the old one and leaving it alone.
    ///
    /// Answers whether anything was parked, because the copy back has to know
    /// and `PRAGMA table_info` on a table that is not there is not an error.
    pub(crate) fn set_aside_the_one_row_standing(conn: &Connection) -> Result<bool> {
        let have = Self::column_names(conn, "master_standing")?;
        if have.is_empty() || have.iter().any(|c| c == "episode") {
            return Ok(false);
        }
        conn.execute_batch(&format!(
            "ALTER TABLE master_standing RENAME TO {};",
            Self::STANDING_BEFORE_EPISODES
        ))
        .map_err(|e| {
            Error::Other(format!(
                "ledger: the standing table could not be set aside for the episode log ({e})"
            ))
        })?;
        Ok(true)
    }

    /// Copy every parked row into the episode table and drop the parked table.
    ///
    /// Column for column, with no value invented and none dropped: an episode
    /// whose `why` is NULL keeps its NULL, because that emptiness is the only
    /// evidence that a stand-down could once be taken in silence, and one that
    /// was already lifted arrives with `told_at` NULL — under the old code a
    /// row that survived to be read here had not yet been told to a pane, since
    /// being told is what deleted it.
    pub(crate) fn carry_the_standing_forward(conn: &Connection, carried: bool) -> Result<()> {
        if !carried {
            return Ok(());
        }
        conn.execute_batch(&format!(
            "INSERT INTO master_standing
                (project_id, slug, stood_down_at, stood_down_by, why, stood_up_at)
             SELECT project_id, slug, stood_down_at, stood_down_by, why, stood_up_at
               FROM {parked};
             DROP TABLE {parked};",
            parked = Self::STANDING_BEFORE_EPISODES
        ))
        .map_err(|e| {
            // What the operator is told has to be the state they will actually
            // find. The whole migration runs in one immediate transaction, so
            // this failure rolls the rename back with it: the table is under
            // its own name again and `master_standing_one_row_per_project` is
            // not there to look in. Saying otherwise sends them hunting for a
            // table that never survived the error (F2 of the whole-set read).
            Error::Other(format!(
                "ledger: the standing rows this box already held could not be carried into the episode log ({e}). The whole migration is one transaction and it has rolled back, so `master_standing` is exactly as it was and no row was lost — this box is running a binary its ledger cannot be brought up to, and the ledger is safe to open with the older one"
            ))
        })?;
        Ok(())
    }

    pub(crate) fn column_names(conn: &Connection, table: &str) -> Result<Vec<String>> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(sql_err)?;
        let mut have = Vec::new();
        for r in rows {
            have.push(r.map_err(sql_err)?);
        }
        Ok(have)
    }

    /// Bring a ledger written by an earlier build up to this build's shape.
    ///
    /// Named by table rather than assuming `runs`: `masters` gained a column
    /// too, and a migration that can only reach one table would have left an
    /// upgraded box unable to say which runs its resident master holds.
    pub(crate) fn add_missing_columns(conn: &Connection) -> Result<()> {
        let mut known: Vec<(&str, Vec<String>)> = Vec::new();
        for (table, name, ty) in ADDED_COLUMNS {
            if !known.iter().any(|(t, _)| t == table) {
                known.push((table, Self::column_names(conn, table)?));
            }
            let have = known
                .iter_mut()
                .find(|(t, _)| t == table)
                .map(|(_, c)| c)
                .expect("the table's columns were just read");
            if !have.iter().any(|c| c == name) {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {name} {ty};"))
                    .map_err(|e| {
                        Error::Other(format!(
                            "ledger: {table}.{name} is missing and could not be added ({e})"
                        ))
                    })?;
                have.push((*name).to_string());
            }
        }
        Ok(())
    }

    /// Give every row an earlier build closed the new fact's value.
    ///
    /// `released_as` is what the close loop now reads for its third mark, and
    /// a ledger upgraded in place holds runs whose only record of that mark is
    /// the old timestamp. Left alone they would read as still holding a
    /// checkout and go back in front of the sweep — a fix that reopens every
    /// run it inherits is a worse defect than the one it closes.
    ///
    /// `gone` is what those rows said and all they said. The one case that
    /// deserves `main_working_tree_kept` is indistinguishable here, because
    /// the build that wrote them could not tell the two apart — that being
    /// this issue. It is not guessed at; a row wrongly reading `gone` over a
    /// main checkout is the state the upgrade found, carried across unchanged
    /// rather than invented, and the next release of that run writes the fact
    /// it reads off git.
    pub(crate) fn carry_the_old_mark_forward(conn: &Connection) -> Result<()> {
        conn.execute(
            "UPDATE runs SET released_as = 'gone'
              WHERE released_as IS NULL AND worktree_gone_at IS NOT NULL",
            [],
        )
        .map_err(sql_err)?;
        Ok(())
    }

    /// Say which decided refusals wrote their run's ending, on rows a build
    /// before `refusal_wrote_ending` decided. That build's
    /// `conclude_release_refusal` always wrote the ending, from the same text
    /// it kept as the refusal, and `settle_release_refusal` wrote none, so a
    /// decided row whose reason is its refusal is exactly one it ended. Only
    /// rows the column has never been written on are read: every decision this
    /// build takes writes it.
    pub(crate) fn carry_the_refusal_ending_forward(conn: &Connection) -> Result<()> {
        conn.execute(
            "UPDATE runs SET refusal_wrote_ending = 1
              WHERE refusal_wrote_ending IS NULL
                AND release_terminal_at IS NOT NULL
                AND ended_by IS NOT NULL
                AND ended_reason IS release_refusal",
            [],
        )
        .map_err(sql_err)?;
        Ok(())
    }
}
