use std::cell::RefCell;

use super::*;

/// One notice as core took it: session, text, needs, by, answer.
type Raised = (String, String, Option<String>, String, String);

/// Core as the test plants it: what each notice carried, and whether a limit report is refused.
#[derive(Default)]
struct Told {
    raised: RefCell<Vec<Raised>>,
    limits: RefCell<Vec<Option<u64>>>,
    refuse_limit: bool,
}

impl LimitReporter for Told {
    async fn usage_limit(
        &self,
        resets: Option<u64>,
        _: &str,
    ) -> runner_platform::error::Result<()> {
        if self.refuse_limit {
            return Err(runner_platform::error::Error::Other("core is down".into()));
        }
        self.limits.borrow_mut().push(resets);
        Ok(())
    }
}

impl Core for Told {
    async fn raised(&self, p: &SessionPrompt<'_>) -> Result<(), String> {
        self.raised.borrow_mut().push((
            p.session.into(),
            p.text.into(),
            p.needs.map(str::to_string),
            p.by.into(),
            p.answer.into(),
        ));
        Ok(())
    }
}

/// Screens as the test draws them: what `read` shows, and what stands after each key.
#[derive(Default)]
struct Drawn {
    before: HashMap<String, String>,
    after: String,
    pressed: Vec<(String, Keys)>,
    unreadable: bool,
}

impl Screens for Drawn {
    async fn read(&mut self, id: &str) -> Result<String, String> {
        if self.unreadable {
            return Err("attach refused".into());
        }
        Ok(self.before.get(id).cloned().unwrap_or_default())
    }

    async fn press(&mut self, id: &str, keys: Keys) -> Result<String, String> {
        self.pressed.push((id.to_string(), keys));
        Ok(self.after.clone())
    }

    fn done(&mut self, _: &str) {}
}

const RM: &str = "────────────────────────────────────────\n Bash command\n   X=$PWD/a; rm -rf \"$X/sub\"\n   Dangerous rm operation on possibly-empty variable path\n Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)\n";
const UNKNOWN: &str = "────────────────────────────────────────\n A brand new dialog nobody has met\n ❯ 1. Accept everything\n   2. Decline\n";

fn session(id: &str, name: &str, waiting_for: Option<&str>) -> BgSession {
    serde_json::from_value(serde_json::json!({
        "id": id, "sessionId": format!("{id}-full"), "kind": "background", "name": name,
        "pid": 7, "status": if waiting_for.is_some() { "waiting" } else { "busy" },
        "waitingFor": waiting_for,
    }))
    .unwrap()
}

fn needs(_: &str) -> JobState {
    JobState {
        detail: None,
        needs: Some("approve Bash: rm -rf $X/sub".into()),
    }
}

fn placed(name: &str) -> Option<String> {
    (name == "forge-master-p").then(|| "proj-1".to_string())
}

fn on(config_dir: Option<&Path>) -> Box_<'_> {
    Box_ {
        version: "2.1.322",
        config_dir,
        job: &needs,
        project: &placed,
    }
}

#[tokio::test]
async fn a_pending_waiting_for_is_answered_from_the_catalog_and_raised_naming_the_session() {
    let roster = [
        session("aaaa1111", "forge-master-p", Some("permission prompt")),
        session("bbbb2222", "forge-master-q", None),
        session("cccc3333", "forge-chat-r", Some("permission prompt")),
    ];
    let mut screens = Drawn {
        before: HashMap::from([("aaaa1111".into(), RM.into())]),
        after: "❯ ".into(),
        ..Drawn::default()
    };
    let core = Told::default();
    let mut w = PromptWatch::default();
    let out = w.over(&roster, &on(None), &mut screens, &core).await;
    assert_eq!(out.len(), 1, "only the waiting master is answered: {out:?}");
    assert_eq!(
        screens.pressed,
        vec![("aaaa1111".to_string(), Keys::Escape)]
    );
    let raised = core.raised.borrow().clone();
    assert_eq!(raised.len(), 1, "the prompt was not raised on Forge");
    let (session, text, needs, by, answer) = &raised[0];
    assert_eq!(session, "forge-master-p");
    assert!(text.contains("Dangerous rm operation"), "{text}");
    assert_eq!(needs.as_deref(), Some("approve Bash: rm -rf $X/sub"));
    assert_eq!((by.as_str(), answer.as_str()), ("catalog", "Escape"));
    let again = w.over(&roster, &on(None), &mut screens, &core).await;
    assert_eq!(again.len(), 1);
    assert_eq!(
        core.raised.borrow().len(),
        1,
        "one standing prompt was told twice"
    );
    match &out[0] {
        Outcome::Answered {
            session,
            by,
            cleared,
            text,
            ..
        } => {
            assert_eq!(session, "forge-master-p");
            assert_eq!(*by, "catalog");
            assert!(cleared);
            assert!(text.contains("Dangerous rm operation"), "{text}");
        }
        o => panic!("{o:?}"),
    }
}

#[tokio::test]
async fn an_unknown_dialog_gets_escape_never_enter_and_a_screen_unread_gets_no_key() {
    let roster = [session(
        "aaaa1111",
        "forge-master-p",
        Some("permission prompt"),
    )];
    let mut screens = Drawn {
        before: HashMap::from([("aaaa1111".into(), UNKNOWN.into())]),
        after: "❯ ".into(),
        ..Drawn::default()
    };
    let core = Told::default();
    let out = PromptWatch::default()
        .over(&roster, &on(None), &mut screens, &core)
        .await;
    assert!(
        matches!(
            &out[0],
            Outcome::Answered {
                by: "safe",
                keys: Keys::Escape,
                ..
            }
        ),
        "{out:?}"
    );

    let mut screens = Drawn {
        unreadable: true,
        ..Drawn::default()
    };
    let out = PromptWatch::default()
        .over(&roster, &on(None), &mut screens, &core)
        .await;
    assert!(matches!(&out[0], Outcome::Unread { .. }), "{out:?}");
    assert!(
        screens.pressed.is_empty(),
        "a key was pressed on a screen nobody read"
    );
}

#[tokio::test]
async fn a_prompt_the_relay_holds_is_left_to_the_relay() {
    let dir = std::env::temp_dir().join(format!("forge-prompt-watch-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let roster = [session(
        "aaaa1111",
        "forge-master-p",
        Some("permission prompt"),
    )];
    permission_relay::mark_inflight(&dir, "aaaa1111-full", "q-1");
    let mut screens = Drawn {
        before: HashMap::from([("aaaa1111".into(), RM.into())]),
        ..Drawn::default()
    };
    let core = Told::default();
    let out = PromptWatch::default()
        .over(&roster, &on(Some(&dir)), &mut screens, &core)
        .await;
    assert!(out.is_empty() && screens.pressed.is_empty(), "{out:?}");
    permission_relay::clear_inflight(&dir, "aaaa1111-full");
    let out = PromptWatch::default()
        .over(&roster, &on(Some(&dir)), &mut screens, &core)
        .await;
    assert_eq!(
        out.len(),
        1,
        "a prompt with no relay holding it was left standing"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_usage_limit_list_is_core_s_before_any_key() {
    let screen = "────────────────────────────────────────\n You've hit your limit\n ❯ 1. Stop and wait for limit to reset\n   2. Wait here, then continue automatically at 3:40pm (Asia/Saigon)\n   3. Ask your admin\n";
    assert!(
        matches!(plan("2.1.322", screen), Plan::Limit { .. }),
        "{:?}",
        plan("2.1.322", screen)
    );
    assert_eq!(plan("2.1.322", "\n\n"), Plan::Unread);
}
