//! `hook --event PermissionRequest --relay`: a resident session's permission prompt asked of a
//! person on Forge, and their answer printed as Claude Code's decision (ISS-1268 B3).
//!
//! The order is the point. The question is asked first, so a person is told before anything waits;
//! the answer is read back every [`POLL`] for at most [`RELAY_WAIT`]; past it the call is denied by
//! name and the question ended, which rings the project's admins. Every path prints a decision: a
//! prompt that could not even be asked is denied, naming why, never left to a dialog nobody sees.
//! Each outcome is a line in the box's dialog record, under the session's project.

use std::time::{Duration, Instant};

use runner_core::dialog_answer;
use runner_core::permission_relay::{self, Decision, Prompt, POLL, RELAY_WAIT};
use runner_platform::config::{config_dir, Config};
use runner_transport::questions::{self, Ask};
use runner_transport::CoreClient;

use crate::cmd::Ctx;

/// What the relay needs of core: ask, read the answer back, end a question nobody answered.
pub trait Core {
    async fn ask(&self, ask: Ask<'_>) -> Result<String, String>;
    /// The chosen option, who chose it, and their note; `None` while unanswered.
    async fn answer(
        &self,
        question_id: &str,
        waiter: &str,
    ) -> Result<Option<(Option<String>, Option<String>, Option<String>)>, String>;
    async fn expire(
        &self,
        question_id: &str,
        waiter: &str,
        project_id: &str,
        waited: Duration,
    ) -> Result<(), String>;
}

/// Core over this box's own device pairing.
pub struct Device(pub CoreClient);

impl Core for Device {
    async fn ask(&self, ask: Ask<'_>) -> Result<String, String> {
        questions::ask(&self.0, ask)
            .await
            .map_err(|e| e.to_string())
    }

    async fn answer(
        &self,
        question_id: &str,
        waiter: &str,
    ) -> Result<Option<(Option<String>, Option<String>, Option<String>)>, String> {
        let a = questions::answer(&self.0, question_id, waiter)
            .await
            .map_err(|e| e.to_string())?;
        Ok(a.map(|a| (a.option_id, a.answered_by, a.note)))
    }

    async fn expire(
        &self,
        question_id: &str,
        waiter: &str,
        project_id: &str,
        waited: Duration,
    ) -> Result<(), String> {
        questions::expire(&self.0, question_id, waiter, project_id, waited.as_secs())
            .await
            .map_err(|e| e.to_string())
    }
}

/// The canary's core (ISS-1268 C1 checks 4 and 5): files in a directory the canary answers,
/// `permission_relay::CANARY_DIR_ENV`.
pub struct CanaryDir(pub std::path::PathBuf);

impl Core for CanaryDir {
    async fn ask(&self, ask: Ask<'_>) -> Result<String, String> {
        let body = serde_json::json!({
            "id": ask.id,
            "prompt": ask.prompt,
            "runId": ask.run_id,
            "options": ask.options,
            "permissionPrompt": ask.permission_prompt,
        });
        let path = self.0.join(format!("req-{}.json", ask.id));
        std::fs::write(&path, body.to_string()).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(ask.id.to_string())
    }

    async fn answer(
        &self,
        question_id: &str,
        _: &str,
    ) -> Result<Option<(Option<String>, Option<String>, Option<String>)>, String> {
        let Ok(text) = std::fs::read_to_string(self.0.join(format!("dec-{question_id}.json")))
        else {
            return Ok(None);
        };
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let s = |k: &str| {
            v.get(k)
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        };
        Ok(Some((s("option"), Some("canary".into()), s("note"))))
    }

    async fn expire(
        &self,
        question_id: &str,
        _: &str,
        _: &str,
        waited: Duration,
    ) -> Result<(), String> {
        let path = self.0.join(format!("expired-{question_id}.json"));
        std::fs::write(
            &path,
            serde_json::json!({ "waited": waited.as_secs() }).to_string(),
        )
        .map_err(|e| format!("{}: {e}", path.display()))
    }
}

/// Ask `p` of a person on `project_id` for `session`, and wait at most `wait` for the answer.
pub async fn relay(
    core: &impl Core,
    project_id: &str,
    session: &str,
    p: &Prompt,
    wait: Duration,
    poll: Duration,
    mark: Option<&std::path::Path>,
) -> Decision {
    let id = uuid::Uuid::new_v4().to_string();
    let waiter = permission_relay::waiter(p, &id);
    let prompt = permission_relay::question_text(session, p);
    let plain = format!("{prompt}\n\nThe call's input:\n{}", p.input);
    let ask = Ask {
        id: &id,
        project_id,
        run_id: &waiter,
        issue_id: None,
        agent_session_id: None,
        prompt: &prompt,
        blocker_kind: "human",
        answer_shape: None,
        options: permission_relay::options(p),
        recommended_option_id: permission_relay::DENY,
        needed: None,
        recommended: None,
        assumed: None,
        cost: None,
        sensitive: None,
        about: None,
        permission_prompt: Some(permission_relay::origin(session, p)),
        plain: Some(&plain),
    };
    let question = match core.ask(ask).await {
        Ok(q) => q,
        Err(why) => return Decision::Unasked { why },
    };
    let held = mark.zip(p.session_id.as_deref());
    if let Some((dir, sid)) = &held {
        permission_relay::mark_inflight(dir, sid, &question);
    }
    let decided = wait_for(core, project_id, &question, &waiter, wait, poll).await;
    if let Some((dir, sid)) = &held {
        permission_relay::clear_inflight(dir, sid);
    }
    decided
}

async fn wait_for(
    core: &impl Core,
    project_id: &str,
    question: &str,
    waiter: &str,
    wait: Duration,
    poll: Duration,
) -> Decision {
    let (question, waiter) = (question.to_string(), waiter.to_string());
    let started = Instant::now();
    loop {
        if let Ok(Some((option, by, note))) = core.answer(&question, &waiter).await {
            if let Some(d) = Decision::of_answer(option.as_deref(), by, note) {
                return d;
            }
        }
        if started.elapsed() + poll > wait {
            break;
        }
        tokio::time::sleep(poll).await;
    }
    // a last read: an answer given in the final poll still counts as given
    if let Ok(Some((option, by, note))) = core.answer(&question, &waiter).await {
        if let Some(d) = Decision::of_answer(option.as_deref(), by, note) {
            return d;
        }
    }
    if let Err(e) = core.expire(&question, &waiter, project_id, wait).await {
        eprintln!(
            "forge-runner hook --relay: question {question} was denied at the timeout and core \
             was not told: {e}"
        );
    }
    Decision::TimedOut { waited: wait }
}

/// The session's name as the roster lists it, else its conversation id.
async fn session_name(p: &Prompt) -> String {
    let id = p.session_id.as_deref().unwrap_or("an unnamed session");
    match runner_workspace::bg_session::list().await {
        Ok(all) => all
            .into_iter()
            .find(|s| s.session_id == id)
            .and_then(|s| s.name)
            .unwrap_or_else(|| format!("session {id}")),
        Err(_) => format!("session {id}"),
    }
}

/// The hook's whole run: read, relay, record, print.
pub async fn run(ctx: &Ctx, payload: &[u8]) -> String {
    let p = permission_relay::prompt_in(payload);
    let project = std::env::var("FORGE_PROJECT_ID")
        .ok()
        .filter(|p| !p.is_empty());
    let session = session_name(&p).await;
    if let Some(dir) = std::env::var_os(permission_relay::CANARY_DIR_ENV) {
        let wait = std::env::var(permission_relay::CANARY_WAIT_ENV)
            .ok()
            .and_then(|w| w.parse().ok())
            .map_or(RELAY_WAIT, Duration::from_secs);
        let dir = std::path::PathBuf::from(dir);
        let core = CanaryDir(dir.clone());
        let d = relay(&core, "canary", &session, &p, wait, POLL, Some(&dir)).await;
        return permission_relay::output(&d);
    }
    let decision = match (&project, client(ctx)) {
        (None, _) => Decision::Unasked {
            why: "the session names no FORGE_PROJECT_ID to ask on".into(),
        },
        (_, Err(why)) => Decision::Unasked { why },
        (Some(project), Ok(core)) => {
            let mark = config_dir();
            relay(
                &core,
                project,
                &session,
                &p,
                RELAY_WAIT,
                POLL,
                mark.as_deref(),
            )
            .await
        }
    };
    if let Some(dir) = config_dir() {
        dialog_answer::record_line(
            &dir,
            runner_core::agent_activity::now_ms(),
            project.as_deref(),
            &p.asked,
            &decision.record_line(&p.asked),
            dialog_answer::Via::Relay,
        );
    }
    permission_relay::output(&decision)
}

fn client(ctx: &Ctx) -> Result<Device, String> {
    let cfg = Config::load().map_err(|e| format!("this box's config could not be read: {e}"))?;
    crate::cmd::question::client_for(ctx, &cfg)
        .map(Device)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    /// Core as the test plants it: what each ask carried, the answer read on the nth read.
    #[derive(Default)]
    struct Planted {
        asked: RefCell<Vec<serde_json::Value>>,
        answer_on_read: Option<(usize, &'static str, Option<&'static str>)>,
        reads: RefCell<usize>,
        expired: RefCell<Vec<(String, String, u64)>>,
        refuse_ask: bool,
    }

    impl Core for Planted {
        async fn ask(&self, ask: Ask<'_>) -> Result<String, String> {
            if self.refuse_ask {
                return Err("core answered 503".into());
            }
            self.asked.borrow_mut().push(serde_json::json!({
                "projectId": ask.project_id,
                "runId": ask.run_id,
                "prompt": ask.prompt,
                "blockerKind": ask.blocker_kind,
                "options": ask.options,
                "recommended": ask.recommended_option_id,
                "issueId": ask.issue_id,
                "permissionPrompt": ask.permission_prompt,
            }));
            Ok("q-1".into())
        }

        async fn answer(
            &self,
            _: &str,
            _: &str,
        ) -> Result<Option<(Option<String>, Option<String>, Option<String>)>, String> {
            *self.reads.borrow_mut() += 1;
            Ok(match self.answer_on_read {
                Some((n, option, note)) if *self.reads.borrow() >= n => Some((
                    Some(option.into()),
                    Some("owner".into()),
                    note.map(str::to_string),
                )),
                _ => None,
            })
        }

        async fn expire(
            &self,
            question_id: &str,
            waiter: &str,
            project_id: &str,
            waited: Duration,
        ) -> Result<(), String> {
            self.expired.borrow_mut().push((
                question_id.into(),
                format!("{waiter}|{project_id}"),
                waited.as_secs(),
            ));
            Ok(())
        }
    }

    const RM: &[u8] =
        br#"{"session_id":"s-1","prompt_id":"p-9","hook_event_name":"PermissionRequest",
        "tool_name":"Bash","tool_input":{"command":"rm -rf $D/nodes"}}"#;

    #[tokio::test]
    async fn a_hook_call_becomes_an_approval_and_its_answer_is_printed_as_the_decision() {
        let core = Planted {
            answer_on_read: Some((2, permission_relay::ALLOW, None)),
            ..Planted::default()
        };
        let p = permission_relay::prompt_in(RM);
        let d = relay(
            &core,
            "proj",
            "forge-master-x",
            &p,
            Duration::from_secs(5),
            Duration::ZERO,
            None,
        )
        .await;
        assert_eq!(
            d,
            Decision::Allowed {
                by: Some("owner".into())
            }
        );
        let asked = core.asked.borrow()[0].clone();
        assert_eq!(asked["projectId"], "proj");
        assert_eq!(asked["blockerKind"], "human");
        assert_eq!(asked["recommended"], "deny");
        assert!(
            asked["issueId"].is_null(),
            "a relayed prompt was asked on an issue"
        );
        assert_eq!(asked["permissionPrompt"]["session"], "forge-master-x");
        assert_eq!(asked["permissionPrompt"]["tool"], "Bash");
        assert_eq!(asked["options"][0]["id"], "allow");
        assert_eq!(asked["options"][0]["authority"], "admin");
        let out: serde_json::Value = serde_json::from_str(&permission_relay::output(&d)).unwrap();
        assert_eq!(out["hookSpecificOutput"]["decision"]["behavior"], "allow");
        assert!(
            core.expired.borrow().is_empty(),
            "an answered prompt was expired"
        );

        let core = Planted {
            answer_on_read: Some((1, permission_relay::DENY, Some("not on main"))),
            ..Planted::default()
        };
        let d = relay(
            &core,
            "proj",
            "forge-master-x",
            &p,
            Duration::from_secs(5),
            Duration::ZERO,
            None,
        )
        .await;
        let out: serde_json::Value = serde_json::from_str(&permission_relay::output(&d)).unwrap();
        assert_eq!(out["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert!(out["hookSpecificOutput"]["decision"]["message"]
            .as_str()
            .unwrap()
            .contains("not on main"));
    }

    #[tokio::test]
    async fn an_unanswered_prompt_is_denied_at_the_timeout_by_name_and_core_told() {
        let core = Planted::default();
        let p = permission_relay::prompt_in(RM);
        let wait = Duration::from_millis(30);
        let d = relay(
            &core,
            "proj",
            "forge-chat-y",
            &p,
            wait,
            Duration::from_millis(10),
            None,
        )
        .await;
        assert_eq!(d, Decision::TimedOut { waited: wait });
        let out: serde_json::Value = serde_json::from_str(&permission_relay::output(&d)).unwrap();
        assert_eq!(out["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert!(out["hookSpecificOutput"]["decision"]["message"]
            .as_str()
            .unwrap()
            .starts_with("[PERMISSION_RELAY_TIMEOUT]"));
        let expired = core.expired.borrow();
        assert_eq!(
            expired.len(),
            1,
            "the timeout did not end the question on core"
        );
        assert_eq!(expired[0].0, "q-1");
        assert!(expired[0].1.ends_with("|proj"));
    }

    #[tokio::test]
    async fn a_prompt_core_would_not_take_is_denied_naming_why_never_left_waiting() {
        let core = Planted {
            refuse_ask: true,
            ..Planted::default()
        };
        let p = permission_relay::prompt_in(RM);
        let d = relay(
            &core,
            "proj",
            "forge-master-x",
            &p,
            Duration::from_secs(60),
            Duration::ZERO,
            None,
        )
        .await;
        let m = d.message().unwrap();
        assert!(
            m.starts_with("[PERMISSION_RELAY_UNASKED]") && m.contains("503"),
            "{m}"
        );
        assert_eq!(*core.reads.borrow(), 0);
    }
}
