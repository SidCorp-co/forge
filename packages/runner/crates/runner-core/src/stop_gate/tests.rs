use super::*;
use std::path::PathBuf;

fn row(action: &str, at_ms: i64, to: Option<&str>) -> Activity {
    Activity {
        action: action.into(),
        at_ms,
        to: to.map(str::to_string),
    }
}

fn take(at_ms: i64) -> Activity {
    row("issue.statusChanged", at_ms, Some("in_progress"))
}

#[test]
fn a_write_after_the_take_and_the_declaration_is_written() {
    let rows = [
        row("comment.created", 300, None),
        take(200),
        row("record.wave", 150, None),
    ];
    assert_eq!(written_since(&rows, 100), Since::Written);
    let rows = [row("issue.updated", 300, None), take(200)];
    assert_eq!(
        written_since(&rows, 100),
        Since::Written,
        "a workState write counts"
    );
}

#[test]
fn nothing_but_the_take_and_the_masters_wave_record_is_unwritten() {
    let rows = [
        row("record.wave", 300, None),
        take(200),
        row("comment.created", 50, None),
    ];
    assert_eq!(written_since(&rows, 100), Since::Unwritten);
}

#[test]
fn a_write_before_the_declaration_does_not_speak_for_a_run_dispatched_later() {
    // An earlier run took it at 200 and wrote at 300; this run was declared at 400.
    let rows = [row("comment.created", 300, None), take(200)];
    assert_eq!(written_since(&rows, 400), Since::Unwritten);
}

#[test]
fn a_write_between_the_declaration_and_the_take_does_not_speak_for_the_take() {
    // Declared at 100; the master wrote on the issue at 150; the run took it at
    // 200 and has written nothing since. The take is the later of the two, so
    // the write at 150 is before it and does not count.
    let rows = [take(200), row("comment.created", 150, None)];
    assert_eq!(written_since(&rows, 100), Since::Unwritten);
    let rows = [
        take(200),
        row("record.decision", 180, None),
        row("record.wave", 120, None),
    ];
    assert_eq!(written_since(&rows, 100), Since::Unwritten);
    // The same write after the take counts.
    let rows = [row("comment.created", 250, None), take(200)];
    assert_eq!(written_since(&rows, 100), Since::Written);
}

#[test]
fn a_status_move_is_not_a_write_and_a_page_without_a_decision_reads_further() {
    let rows = [
        row("issue.statusChanged", 300, Some("open")),
        row("record.wave", 250, None),
    ];
    assert_eq!(written_since(&rows, 100), Since::ReadFurther);
    assert_eq!(written_since(&[], 100), Since::ReadFurther);
}

fn standing(pid: u32, command: &str) -> Standing {
    Standing {
        pid,
        command: command.into(),
        started_at: 0,
    }
}

fn facts<'a>(tree: &'a Path, issues: Vec<(String, Issue)>) -> Facts<'a> {
    Facts {
        run_id: "296f5496-870e-428f-b386-d1c6007bfd9c",
        tree,
        runner: "/opt/forge runner/bin/forge-runner",
        issues,
        dirty: Ok(vec![]),
        standing: Ok(vec![]),
        refused_in_a_row: 0,
    }
}

fn refused(v: &Verdict) -> &str {
    match &v.outcome {
        Outcome::Refused(r) => r,
        other => panic!("not refused: {other:?}"),
    }
}

#[test]
fn a_held_issue_with_nothing_written_refuses_naming_its_condition_and_the_issue() {
    let tree = PathBuf::from("/r/.claude/worktrees/ISS-297");
    let v = decide(&facts(
        &tree,
        vec![
            (
                "ISS-297".into(),
                Issue::HeldUnwritten {
                    id: "0d9e6010".into(),
                },
            ),
            ("ISS-298".into(), Issue::HeldWritten),
        ],
    ));
    let r = refused(&v);
    assert_eq!(v.conditions, vec![Condition::HeldUnwritten]);
    assert!(
        r.contains("STOP_HELD_UNWRITTEN: ISS-297 is in_progress"),
        "{r}"
    );
    assert!(r.contains("issues/0d9e6010/comments"), "{r}");
    assert!(!r.contains("ISS-298"), "{r}");
    assert!(r.contains("run 296f5496 "), "{r}");
}

#[test]
fn a_dirty_tree_refuses_naming_the_tree_and_its_paths() {
    let tree = PathBuf::from("/r/wt");
    let mut f = facts(&tree, vec![]);
    let paths: Vec<String> = (0..12).map(|i| format!("f{i}.rs")).collect();
    f.dirty = Ok(paths);
    let v = decide(&f);
    let r = refused(&v);
    assert_eq!(v.conditions, vec![Condition::WorktreeDirty]);
    assert!(
        r.contains("STOP_WORKTREE_DIRTY: /r/wt has uncommitted changes: f0.rs, f1.rs"),
        "{r}"
    );
    assert!(r.contains("f9.rs, and 2 more."), "{r}");
    let sentence = r
        .lines()
        .find(|l| l.contains("STOP_WORKTREE_DIRTY"))
        .unwrap();
    assert!(!sentence.contains("f10.rs"), "{sentence}");
    // The sentence shows ten; the command stages every path the gate saw.
    let staged = r.lines().find(|l| l.starts_with("git -C")).unwrap();
    assert!(staged.contains(" f9.rs f10.rs f11.rs && "), "{staged}");
}

#[test]
fn a_process_standing_refuses_naming_its_pid_and_command() {
    let tree = PathBuf::from("/r/wt");
    let mut f = facts(&tree, vec![]);
    f.standing = Ok(vec![standing(4242, "node server.js")]);
    let v = decide(&f);
    let r = refused(&v);
    assert_eq!(v.conditions, vec![Condition::ProcessRunning]);
    assert!(
        r.contains("STOP_PROCESS_RUNNING: A process started since this run was declared still stands in /r/wt: pid 4242 (node server.js)."),
        "{r}"
    );
    assert!(r.contains("`kill 4242`"), "{r}");
}

#[test]
fn every_condition_standing_is_named_in_one_refusal() {
    let tree = PathBuf::from("/r/wt");
    let mut f = facts(
        &tree,
        vec![("ISS-1".into(), Issue::HeldUnwritten { id: "u".into() })],
    );
    f.dirty = Ok(vec!["a".into()]);
    f.standing = Ok(vec![standing(1, "a"), standing(2, "b")]);
    let v = decide(&f);
    assert_eq!(
        v.conditions,
        vec![
            Condition::HeldUnwritten,
            Condition::WorktreeDirty,
            Condition::ProcessRunning
        ]
    );
    assert!(refused(&v).contains("2 processes started since this run was declared still stand"));
}

#[test]
fn a_clear_run_passes_and_what_could_not_be_read_refuses_nothing() {
    let tree = PathBuf::from("/r/wt");
    assert_eq!(
        decide(&facts(&tree, vec![("ISS-1".into(), Issue::NotHeld)])).outcome,
        Outcome::Passed
    );
    let mut f = facts(
        &tree,
        vec![("ISS-1".into(), Issue::Unread("core: 502".into()))],
    );
    f.dirty = Err("git did not answer".into());
    f.standing = Err("no /proc".into());
    let v = decide(&f);
    assert_eq!(v.outcome, Outcome::Passed);
    assert_eq!(
        v.unread,
        vec![
            "ISS-1: core: 502".to_string(),
            "the worktree: git did not answer".to_string(),
            "the process table: no /proc".to_string()
        ]
    );
}

#[test]
fn the_bound_lets_the_stop_after_the_last_refusal_through_and_says_so() {
    let tree = PathBuf::from("/r/wt");
    let mut f = facts(&tree, vec![]);
    f.dirty = Ok(vec!["a".into()]);
    f.refused_in_a_row = STOP_BOUND - 1;
    assert!(refused(&decide(&f)).contains(&format!("refusal {STOP_BOUND} of {STOP_BOUND}")));
    f.refused_in_a_row = STOP_BOUND;
    let v = decide(&f);
    assert_eq!(v.outcome, Outcome::LetGo);
    assert_eq!(v.conditions, vec![Condition::WorktreeDirty]);
    let line = journal_line(7, "r1", &v);
    assert!(line.contains(r#""outcome":"let_go""#), "{line}");
    assert!(line.contains("STOP_WORKTREE_DIRTY"), "{line}");
}

#[test]
fn refusals_in_a_row_count_one_run_and_reset_on_any_other_outcome() {
    let v = |o: Outcome| Verdict {
        outcome: o,
        conditions: vec![],
        unread: vec![],
    };
    let refused = journal_line(1, "r1", &v(Outcome::Refused("x".into())));
    let other = journal_line(2, "r2", &v(Outcome::Refused("x".into())));
    let passed = journal_line(3, "r1", &v(Outcome::Passed));
    let journal = [
        refused.as_str(),
        refused.as_str(),
        passed.as_str(),
        refused.as_str(),
        other.as_str(),
        "not json",
        refused.as_str(),
    ]
    .join("\n");
    assert_eq!(refused_in_a_row(&journal, "r1"), 2);
    assert_eq!(refused_in_a_row(&journal, "r2"), 1);
    assert_eq!(refused_in_a_row("", "r1"), 0);
}

#[test]
fn porcelain_names_each_changed_path_once() {
    let z = " M src/a.rs\0?? new.txt\0R  b.rs\0old-b.rs\0D  gone.rs\0";
    assert_eq!(
        porcelain_paths(z),
        vec!["src/a.rs", "new.txt", "b.rs", "gone.rs"]
    );
    assert!(porcelain_paths("").is_empty());
}

/// The lines of a refusal from the one starting `starts` through the heredoc
/// terminator: the command a run is told to run, as it reads.
fn heredoc<'r>(r: &'r str, starts: &str) -> Vec<&'r str> {
    let lines: Vec<&str> = r.lines().skip_while(|l| !l.starts_with(starts)).collect();
    let end = lines
        .iter()
        .position(|l| *l == TEXT_END)
        .unwrap_or_else(|| panic!("no `{starts}` heredoc closed by {TEXT_END} in:\n{r}"));
    lines[..=end].to_vec()
}

/// The text a run puts in a hint travels in a quoted heredoc, so nothing in it
/// is the run's to quote; `stop_hints_through_sh.rs` runs both through `sh`.
#[test]
fn the_held_hint_reads_the_comment_from_a_quoted_heredoc_through_the_judging_binary() {
    let tree = PathBuf::from("/r/wt");
    let v = decide(&facts(
        &tree,
        vec![(
            "ISS-297".into(),
            Issue::HeldUnwritten {
                id: "0d9e6010-b39a-41c3-8702-1d1eab933311".into(),
            },
        )],
    ));
    let r = refused(&v);
    assert_eq!(
        heredoc(r, "'/opt/forge runner/bin/forge-runner' api"),
        vec![
            "'/opt/forge runner/bin/forge-runner' api issues/0d9e6010-b39a-41c3-8702-1d1eab933311/comments -f body=@- <<'FORGE_TEXT'",
            HELD_TEXT,
            TEXT_END,
        ]
    );
    assert!(
        r.contains("apostrophes, quotes and line breaks need no escaping"),
        "{r}"
    );
    assert!(
        !r.contains(" -d "),
        "the hint still asks for hand-quoted JSON:\n{r}"
    );
}

#[test]
fn the_dirty_hint_names_removing_scratch_first_and_quotes_the_tree_as_one_word() {
    let tree = PathBuf::from("/r/a tree/it's");
    let mut f = facts(&tree, vec![]);
    f.dirty = Ok(vec!["notes.tmp".into(), "src/it's.rs".into()]);
    let v = decide(&f);
    let r = refused(&v);
    assert!(
        r.contains(
            "first delete what the run made and no longer needs (scratch files, logs, \
                    output) and take those paths out of the `git add` line"
        ),
        "{r}"
    );
    assert_eq!(
        heredoc(r, "git -C"),
        vec![
            r#"git -C '/r/a tree/it'\''s' add -A -- notes.tmp 'src/it'\''s.rs' && git -C '/r/a tree/it'\''s' commit -F - <<'FORGE_TEXT'"#,
            COMMIT_TEXT,
            TEXT_END,
        ]
    );
}

#[test]
fn a_plain_path_is_left_bare_and_any_other_is_one_shell_word() {
    assert_eq!(
        sh_quote("/r/.claude/worktrees/ISS-297"),
        "/r/.claude/worktrees/ISS-297"
    );
    assert_eq!(sh_quote("/r/a b"), "'/r/a b'");
    assert_eq!(sh_quote("it's"), r#"'it'\''s'"#);
    assert_eq!(sh_quote(""), "''");
}
