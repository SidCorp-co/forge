//! A copy Claude Code starts instead of continuing a held conversation never survives
//! (ISS-1304 c2), on a fake `claude` ([`super::super::fake_claude`]).

use super::*;
use crate::bg_session::fake_claude::FakeClaude;

/// The tmux master holding the conversation, as 2.1.322 lists an interactive session.
const HELD: &str = r#"[
  {"pid":4100,"cwd":"/p","kind":"interactive","startedAt":1,"sessionId":"conv-1","name":"forge-master-p","status":"busy"}
]"#;

/// The same, with the copy `claude --bg --resume` started beside it.
const HELD_AND_COPY: &str = r#"[
  {"pid":4100,"cwd":"/p","kind":"interactive","startedAt":1,"sessionId":"conv-1","name":"forge-master-p","status":"busy"},
  {"pid":4242,"id":"c0ffee01","cwd":"/p","kind":"background","startedAt":9,"sessionId":"copy-1","name":"forge-master-p","status":"busy"}
]"#;

/// What Claude Code printed on sid-xeon-1 (ISS-1304 evidence), its ids replaced.
const COPY_SAID: &str = "note: session conv-1 is open in another Claude Code process, so this started a copy as c0ffee01.\nbackgrounded \u{b7} c0ffee01 \u{b7} forge-master-p\n";

fn launch(cwd: &Path) -> BgLaunch {
    BgLaunch {
        name: "forge-master-p".into(),
        cwd: cwd.to_path_buf(),
        settings: cwd.join("s.json"),
        permission_mode: "bypassPermissions".into(),
        resume: Some("conv-1".into()),
        prompt: Some("brief".into()),
        ..BgLaunch::default()
    }
}

async fn masters_left() -> Vec<String> {
    roster::list()
        .await
        .unwrap()
        .into_iter()
        .filter(|s| s.is_background() && s.is_live())
        .filter_map(|s| s.name)
        .filter(|n| n.starts_with("forge-master-"))
        .collect()
}

/// A held session planted: `claude --bg` answers with a copy, which is stopped at once, and no
/// `forge-master-*` background session is left. Planted back (the answer refused without the
/// stop, as dev.723 did), the copy is still listed and this goes red.
#[tokio::test]
async fn a_copy_of_a_held_session_is_stopped_at_once_and_no_master_session_is_left() {
    let fake = FakeClaude::new("copy", HELD);
    fake.on_bg(COPY_SAID, Some(HELD_AND_COPY));
    fake.on_stop(HELD);

    let e = launch(&fake.dir).start().await.unwrap_err();
    assert_eq!(
        masters_left().await,
        Vec::<String>::new(),
        "a copy survived beside the held master: {e}"
    );
    assert_eq!(fake.calls("stops").trim(), "c0ffee01");
    assert!(
        e.starts_with("[BG_RESUME_COPIED]") && e.contains("the copy c0ffee01 was stopped"),
        "{e}"
    );

    // the wake path answers the same way
    fake.roster(HELD);
    let e = resume("conv-1", "forge-master-p", &fake.dir)
        .await
        .unwrap_err();
    assert!(e.starts_with("[BG_RESUME_COPIED]"), "{e}");
    assert_eq!(fake.calls("stops").lines().count(), 2);
    assert!(masters_left().await.is_empty());
}

/// A stop that did not take is said by name, never read as taken: two sessions hold one
/// conversation, and the refusal says which and how to end it.
#[tokio::test]
async fn a_copy_whose_stop_does_not_take_is_refused_as_left_running() {
    let fake = FakeClaude::new("copy-stuck", HELD);
    fake.on_bg(COPY_SAID, Some(HELD_AND_COPY));
    let e = launch(&fake.dir).start().await.unwrap_err();
    assert!(
        e.starts_with("[BG_COPY_LEFT_RUNNING]")
            && e.contains("still runs after `claude stop c0ffee01`")
            && e.contains("`claude stop c0ffee01` ends the copy"),
        "{e}"
    );
}

#[test]
fn the_copy_is_named_by_the_id_claude_code_printed() {
    assert_eq!(copy_in(COPY_SAID), Some(Some("c0ffee01".to_string())));
    let only_line = "started a copy\nbackgrounded \u{b7} 0eb283e6 \u{b7} forge-master-p\n";
    assert_eq!(copy_in(only_line), Some(Some("0eb283e6".to_string())));
    assert_eq!(copy_in("Claude Code started a copy."), Some(None));
    assert_eq!(
        copy_in("backgrounded \u{b7} a1 \u{b7} forge-master-p"),
        None
    );
}
