//! What stands on a pane, read off captures of real Claude Code panes.
//!
//! The 2.1.292 captures were taken on 2026-10-06 (ISS-280) from a pane raised on
//! a Bash `rm` and then an overwrite, in a private tmux server, before and
//! after Tab and the reason were typed on `No`; the work directory's path is
//! shortened to `/home/u/work`. The rest are ISS-1266's captures of 2.1.283.

use super::*;

const BASH: &str = include_str!("../../assets/composer/permission-bash-2.1.292.txt");
const OVERWRITE: &str = include_str!("../../assets/composer/permission-overwrite-2.1.292.txt");
const AMEND_TYPED: &str = include_str!("../../assets/composer/permission-amend-typed-2.1.292.txt");
const CREATE: &str = include_str!("../../assets/composer/permission-create-2.1.283.txt");
const TRUST: &str = include_str!("../../assets/composer/trust-dialog.txt");
const MODEL: &str = include_str!("../../assets/composer/model-menu.txt");
const REWIND: &str = include_str!("../../assets/composer/rewind-picker.txt");

fn permission(capture: &str) -> Permission {
    match standing(capture) {
        Standing::Permission(p) => p,
        other => panic!("not read as a permission dialog: {other:?}"),
    }
}

#[test]
fn a_bash_permission_dialog_is_read_with_its_head_options_and_no() {
    let p = permission(BASH);
    assert_eq!(
        p.head,
        vec!["Bash command", "Delete victim.txt", "rm -f victim.txt"]
    );
    assert_eq!(p.question, "Do you want to proceed?");
    assert_eq!(
        p.options,
        vec![
            "Yes",
            "Yes, and always allow access to /home/u/work from this project",
            "No"
        ]
    );
    assert_eq!((p.highlighted, p.no, p.amending), (0, 2, false));
    assert_eq!(p.amended_with(), None);
}

#[test]
fn an_overwrite_and_a_create_dialog_are_read_as_permission_dialogs() {
    let o = permission(OVERWRITE);
    assert_eq!(o.question, "Do you want to overwrite victim.txt?");
    assert_eq!(o.head[..2], ["Overwrite file", "victim.txt"]);
    assert_eq!((o.highlighted, o.no, o.options.len()), (0, 2, 3));
    let c = permission(CREATE);
    assert_eq!(c.question, "Do you want to create hello.txt?");
    assert_eq!((c.highlighted, c.no, c.amending), (0, 2, false));
}

#[test]
fn an_open_amend_row_reads_back_the_reason_typed_into_it() {
    let p = permission(AMEND_TYPED);
    assert!(p.amending, "the No row is open");
    assert_eq!((p.highlighted, p.no), (2, 2));
    assert!(p.is_same_dialog(&permission(OVERWRITE)));
    let typed: String = REPHRASE_AS_TYPED
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    assert_eq!(p.amended_with(), Some(typed));
}

/// The reason exactly as it was typed into the amend row the capture shows.
const REPHRASE_AS_TYPED: &str = "The Forge runner answered this permission dialog for you: \
denied. Nobody watches this pane, so a dialog would hold it, and every run working in it, until a \
person came by. Do not repeat the same call. Rephrase it so it needs no permission: run plain \
commands one at a time with literal absolute paths; no `bash -c` or `sh -c` wrapper, no \
multi-line script, no loop around `rm`; to empty or replace a file, write it with `>` instead of \
deleting it; never delete anything outside your worktree or scratchpad. If the step cannot be \
done without a person, stop it and say so in your report.";

#[test]
fn a_menu_that_is_not_a_permission_dialog_is_named_with_why() {
    for (capture, highlighted, why) in [
        (TRUST, "No, exit", "not numbered"),
        (REWIND, "(current)", "not numbered"),
        (MODEL, "2. Opus", "no single No"),
    ] {
        match standing(capture) {
            Standing::Other {
                highlighted: h,
                why: w,
            } => {
                assert!(h.starts_with(highlighted), "{h:?} for {highlighted:?}");
                assert!(w.contains(why), "{w:?} for {highlighted:?}");
            }
            other => panic!("{highlighted:?} read as {other:?}"),
        }
    }
}

#[test]
fn a_dialog_without_tab_to_amend_is_not_one_the_box_refuses() {
    let older = BASH.replace(" \u{b7} Tab to amend", "");
    match standing(&older) {
        Standing::Other { why, .. } => assert!(why.contains("Tab to amend"), "{why}"),
        other => panic!("read as {other:?}"),
    }
}

#[test]
fn a_composer_with_nothing_standing_reads_nothing() {
    let pane = "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n\
\u{276f} \n\
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n";
    assert_eq!(standing(pane), Standing::Nothing);
    assert_eq!(standing(""), Standing::Nothing);
}

const USAGE_LIMIT: &str = concat!(
    "\n",
    " You've hit your usage limit\n",
    "\n",
    " What do you want to do?\n",
    "\n",
    " \u{276f} 1. Stop and wait for limit to reset\n",
    "   2. Wait here, then continue automatically at 3:40pm (Asia/Saigon)\n",
    "   3. Ask your admin\n",
    "\n",
    " Enter to confirm \u{b7} Esc to cancel\n",
);

#[test]
fn the_usage_limit_choice_list_is_read_with_its_printed_reset() {
    match standing(USAGE_LIMIT) {
        Standing::UsageLimit { highlighted, reset } => {
            assert!(
                highlighted.starts_with("1. Stop and wait")
                    || highlighted.starts_with("Stop and wait"),
                "{highlighted}"
            );
            assert_eq!(reset.as_deref(), Some("3:40pm (Asia/Saigon)"));
        }
        other => panic!("read as {other:?}"),
    }
}

#[test]
fn a_usage_limit_list_that_prints_no_reset_still_reads_as_one() {
    let bare = USAGE_LIMIT.replace(" at 3:40pm (Asia/Saigon)", "");
    assert!(matches!(
        standing(&bare),
        Standing::UsageLimit { reset: None, .. }
    ));
}

#[test]
fn a_list_naming_only_one_of_the_two_rows_is_not_the_usage_limit() {
    let only = USAGE_LIMIT.replace("Stop and wait for limit to reset", "Stop here");
    assert!(!matches!(standing(&only), Standing::UsageLimit { .. }));
    assert!(!matches!(standing(BASH), Standing::UsageLimit { .. }));
}
