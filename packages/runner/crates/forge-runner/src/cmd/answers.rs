//! What a session is told of the answers to feedback its own account filed to Forge (REQ-47 BC-11).
//!
//! `hook --event UserPromptSubmit` and `gate --event PreToolUse` ask core here, as the account the
//! session's checkout speaks to Forge as, for the answers none of that account's sessions has been
//! told, and put them in front of the session as `additionalContext`. Core records each answer as
//! told by the same call that hands it out, so a session is told it once and nothing polls: the ask
//! rides a prompt, or a tool call once [`TOOL_CALL_GAP`] has passed since this checkout last asked.
//!
//! The account is the checkout's: the credential a pane this box placed borrows
//! (`$FORGE_BORROW_FROM`), else the `forge` server the checkout's own `.mcp.json` declares — the one
//! its `forge_feedback` filed with. Another project's checkout carries another account's, so its
//! sessions are told nothing of this one's answers.
//!
//! Like everything a hook runs, this has no failure path: no credential, no core, a refusal or a
//! timeout each leave the session told nothing and its prompt or tool call untouched.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use runner_transport::feedback_answers::{self, Answered};
use runner_transport::CoreClient;
use runner_workspace::mcp::config::{borrowed_credential, Borrowed};
use serde_json::Value;

/// The line every answer told to a session ends with (owner ruling 2026-10-29): an answer is the
/// reporter's, never its project channel's.
pub const CHANNEL_LINE: &str = "Do not post this in the project channel.";

/// The longest a prompt or tool call waits on core for its answers.
pub const ASK_WITHIN: Duration = Duration::from_secs(3);

/// How long after a checkout last asked a tool call asks again. A prompt always asks.
pub const TOOL_CALL_GAP: Duration = Duration::from_secs(30);

/// The account a session speaks to Forge as, and where that was read, which keys the gap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub credential: Borrowed,
    pub from: PathBuf,
}

/// The `forge` server a checkout's `.mcp.json` declares, as a credential: the core it is served by
/// (its url less `/mcp`) and the bearer it sends. `None` where it declares none with a fixed bearer.
pub fn declared_in(mcp_json: &str) -> Option<Borrowed> {
    let doc: Value = serde_json::from_str(mcp_json).ok()?;
    let forge = doc.get("mcpServers")?.get("forge")?;
    let url = forge.get("url")?.as_str()?.trim().trim_end_matches('/');
    let url = url.strip_suffix("/mcp").unwrap_or(url).to_string();
    let bearer = forge
        .get("headers")?
        .get("Authorization")?
        .as_str()?
        .trim()
        .strip_prefix("Bearer ")?
        .trim()
        .to_string();
    (!url.is_empty() && !bearer.is_empty()).then_some(Borrowed { url, token: bearer })
}

/// The nearest `.mcp.json` at or above `cwd` that declares a `forge` server.
fn checkout_account(cwd: &Path) -> Option<Account> {
    cwd.ancestors().find_map(|dir| {
        let file = dir.join(".mcp.json");
        let credential = declared_in(&std::fs::read_to_string(&file).ok()?)?;
        Some(Account {
            credential,
            from: file,
        })
    })
}

/// The account a session standing in `cwd` speaks to Forge as: the pane's borrowed checkout
/// credential where it has one, else its checkout's `.mcp.json`.
pub fn account(borrowed: Option<(Borrowed, PathBuf)>, cwd: &Path) -> Option<Account> {
    match borrowed {
        Some((credential, from)) => Some(Account { credential, from }),
        None => checkout_account(cwd),
    }
}

/// What a session is told of `answers`: one line each, then [`CHANNEL_LINE`]; `None` for none.
pub fn context_of(answers: &[Answered]) -> Option<String> {
    if answers.is_empty() {
        return None;
    }
    let mut lines: Vec<String> = answers
        .iter()
        .map(|a| format!("{} answered: {}", a.key, a.answer.trim()))
        .collect();
    lines.push(CHANNEL_LINE.to_string());
    Some(lines.join("\n"))
}

/// The hook output carrying `context` into the session, for `event`.
pub fn output(event: &str, context: &str) -> String {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": context,
        }
    })
    .to_string()
}

/// Whether the hook payload is a subagent's: its tool calls are not the session's turn, and an
/// answer told there would reach the subagent and never the session.
fn from_subagent(payload: &Value) -> bool {
    payload
        .get("agent_id")
        .and_then(Value::as_str)
        .is_some_and(|a| !a.is_empty())
}

/// The file whose age says when the checkout `from` last asked.
fn stamp_of(dir: &Path, from: &Path) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    from.hash(&mut h);
    dir.join(format!("{:016x}", h.finish()))
}

/// Whether a tool call asks now: the checkout last asked [`TOOL_CALL_GAP`] ago or more, or never.
/// Asking or not, a call that asks stamps the time first, so a slow core is not asked twice at once.
pub fn due(stamp: &Path, prompt: bool, now: SystemTime) -> bool {
    let last = std::fs::metadata(stamp).and_then(|m| m.modified()).ok();
    let recent = last.is_some_and(|t| now.duration_since(t).unwrap_or_default() < TOOL_CALL_GAP);
    if recent && !prompt {
        return false;
    }
    if let Some(dir) = stamp.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(stamp, b"");
    true
}

fn stamps_dir() -> PathBuf {
    dirs_next::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("forge-runner")
        .join("answers-asked")
}

/// What `account` is told now, or `None`: a claim of its untold answers within [`ASK_WITHIN`].
pub async fn claimed_for(account: &Account) -> Option<String> {
    let client = CoreClient::with_deadline(
        account.credential.url.clone(),
        account.credential.token.clone(),
        ASK_WITHIN,
    );
    let asked =
        tokio::time::timeout(ASK_WITHIN, feedback_answers::claim(&client, ASK_WITHIN)).await;
    match asked {
        Ok(Ok(answers)) => context_of(&answers),
        _ => None,
    }
}

/// The output a hook prints for `event` to tell its session of answers, or `None` for nothing.
pub async fn told(event: &str, payload: &[u8]) -> Option<String> {
    let prompt = event == "UserPromptSubmit";
    if !prompt && event != "PreToolUse" {
        return None;
    }
    let payload: Value = serde_json::from_slice(payload).unwrap_or(Value::Null);
    if from_subagent(&payload) {
        return None;
    }
    let cwd = payload
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())?;
    let borrowed = borrowed_credential().ok().flatten().and_then(|b| {
        let from = std::env::var_os(runner_workspace::mcp::config::CLI_BORROW_VAR)?;
        Some((b, PathBuf::from(from)))
    });
    let account = account(borrowed, &cwd)?;
    if !due(
        &stamp_of(&stamps_dir(), &account.from),
        prompt,
        SystemTime::now(),
    ) {
        return None;
    }
    let context = claimed_for(&account).await?;
    Some(output(event, &context))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn answered(key: &str, answer: &str) -> Answered {
        Answered {
            key: key.into(),
            answer: answer.into(),
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "forge-answers-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A stub of core's claim route: hands `answers` to the first claim and none to any after, as
    /// core does, and counts the claims and the bearers they came with.
    async fn stub_core(
        answers: Vec<(&'static str, &'static str)>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            let mut owed = answers;
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = vec![0u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let line = req.lines().next().unwrap_or("").to_string();
                let bearer = req
                    .lines()
                    .find_map(|l| l.strip_prefix("authorization: Bearer "))
                    .unwrap_or("")
                    .trim()
                    .to_string();
                log.lock().unwrap().push(format!("{line} as {bearer}"));
                let body = if bearer == "reporter-token"
                    && line.starts_with(&format!("POST {}", feedback_answers::CLAIM_PATH))
                {
                    let list: Vec<_> = owed
                        .drain(..)
                        .map(|(k, a)| serde_json::json!({"key": k, "answer": a, "answeredAt": "2026-10-29T07:00:00Z"}))
                        .collect();
                    serde_json::json!({"answers": list, "returned": list.len()}).to_string()
                } else {
                    serde_json::json!({"answers": [], "returned": 0}).to_string()
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });
        (format!("http://{addr}"), seen)
    }

    fn account_at(url: &str, token: &str, from: &Path) -> Account {
        Account {
            credential: Borrowed {
                url: url.into(),
                token: token.into(),
            },
            from: from.to_path_buf(),
        }
    }

    #[test]
    fn an_answer_is_told_as_its_key_and_text_then_the_channel_line() {
        let told = context_of(&[
            answered("FB-12", "By design: rank, not age.\n"),
            answered("FB-14", "Fixed in 0.4.0-dev.340."),
        ])
        .expect("two answers told nothing");
        assert_eq!(
            told,
            "FB-12 answered: By design: rank, not age.\n\
             FB-14 answered: Fixed in 0.4.0-dev.340.\n\
             Do not post this in the project channel."
        );
        assert_eq!(
            context_of(&[]),
            None,
            "no answer still told the session something"
        );
        let out: Value = serde_json::from_str(&output("UserPromptSubmit", &told)).unwrap();
        assert_eq!(
            out["hookSpecificOutput"]["hookEventName"],
            "UserPromptSubmit"
        );
        assert_eq!(out["hookSpecificOutput"]["additionalContext"], told);
    }

    #[test]
    fn the_account_is_the_forge_server_the_checkout_declares() {
        let doc = r#"{"mcpServers":{"forge":{"type":"http","url":"https://core.example/mcp",
            "headers":{"Authorization":"Bearer abc","X-Forge-Project-Slug":"mail"}},
            "other":{"url":"https://x"}}}"#;
        assert_eq!(
            declared_in(doc),
            Some(Borrowed {
                url: "https://core.example".into(),
                token: "abc".into()
            })
        );
        for none in [
            r#"{"mcpServers":{"other":{"url":"https://x"}}}"#,
            r#"{"mcpServers":{"forge":{"url":"https://core.example/mcp","headersHelper":"cat f"}}}"#,
            r#"{"mcpServers":{"forge":{"url":"https://core.example/mcp","headers":{"Authorization":"Basic x"}}}}"#,
            "not json",
        ] {
            assert_eq!(declared_in(none), None, "{none} read as a credential");
        }
    }

    #[test]
    fn a_session_below_the_checkout_finds_it_and_a_borrowed_credential_comes_first() {
        let root = scratch("checkout");
        std::fs::write(
            root.join(".mcp.json"),
            r#"{"mcpServers":{"forge":{"url":"https://a.example/mcp","headers":{"Authorization":"Bearer mine"}}}}"#,
        )
        .unwrap();
        let deep = root.join("src").join("lib");
        std::fs::create_dir_all(&deep).unwrap();
        let found = account(None, &deep).expect("the checkout's .mcp.json was not found");
        assert_eq!(found.credential.token, "mine");
        assert_eq!(found.from, root.join(".mcp.json"));
        let borrowed = Borrowed {
            url: "https://b.example".into(),
            token: "borrowed".into(),
        };
        let pane = account(
            Some((borrowed.clone(), PathBuf::from("/b/forge-cli.json"))),
            &deep,
        )
        .expect("a borrowed credential was dropped");
        assert_eq!(pane.credential, borrowed);
        let bare = scratch("bare");
        assert_eq!(
            account(None, &bare),
            None,
            "a folder with no forge server found one"
        );
    }

    #[test]
    fn a_prompt_always_asks_and_a_tool_call_waits_out_the_gap() {
        let dir = scratch("stamps");
        let stamp = stamp_of(&dir, Path::new("/repo/.mcp.json"));
        let now = SystemTime::now();
        assert!(
            due(&stamp, false, now),
            "a checkout that never asked did not ask"
        );
        assert!(
            !due(&stamp, false, now),
            "a tool call asked again inside the gap"
        );
        assert!(due(&stamp, true, now), "a prompt waited out the gap");
        assert!(
            due(&stamp, false, now + TOOL_CALL_GAP + Duration::from_secs(1)),
            "a tool call past the gap did not ask"
        );
        assert_ne!(stamp, stamp_of(&dir, Path::new("/other/.mcp.json")));
    }

    #[test]
    fn a_subagent_s_tool_call_is_never_told() {
        let sub: Value = serde_json::json!({"agent_id": "a1", "cwd": "/r"});
        let lead: Value = serde_json::json!({"cwd": "/r"});
        assert!(from_subagent(&sub));
        assert!(!from_subagent(&lead));
    }

    #[tokio::test]
    async fn the_reporter_is_told_once_and_another_account_never() {
        let (url, seen) = stub_core(vec![("FB-7", "It is by design.")]).await;
        let from = Path::new("/mail/.mcp.json");
        let stranger = account_at(&url, "stranger-token", Path::new("/other/.mcp.json"));
        assert_eq!(
            claimed_for(&stranger).await,
            None,
            "another account was told"
        );
        let reporter = account_at(&url, "reporter-token", from);
        assert_eq!(
            claimed_for(&reporter).await.as_deref(),
            Some("FB-7 answered: It is by design.\nDo not post this in the project channel.")
        );
        assert_eq!(
            claimed_for(&reporter).await,
            None,
            "a told answer was told again"
        );
        let asked = seen.lock().unwrap().clone();
        assert_eq!(asked.len(), 3);
        assert!(asked
            .iter()
            .all(|a| a.starts_with("POST /api/forge/feedback/answers/claim")));
    }

    #[tokio::test]
    async fn a_core_that_cannot_be_reached_or_refuses_tells_nothing_within_the_bound() {
        let refused = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = refused.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = refused.accept().await {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let body = r#"{"code":"FORGE_FEEDBACK_HOME_NOT_SET"}"#;
                let resp = format!(
                    "HTTP/1.1 409 Conflict\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });
        let at = account_at(&format!("http://{addr}"), "reporter-token", Path::new("/r"));
        assert_eq!(
            claimed_for(&at).await,
            None,
            "a refusal told the session something"
        );

        let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = silent.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((sock, _)) = silent.accept().await {
                held.push(sock);
            }
        });
        let hung = account_at(&format!("http://{addr}"), "reporter-token", Path::new("/r"));
        let started = std::time::Instant::now();
        assert_eq!(claimed_for(&hung).await, None);
        assert!(
            started.elapsed() < ASK_WITHIN + Duration::from_secs(2),
            "a core that never answered held the prompt {:?}",
            started.elapsed()
        );

        let gone = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = gone.local_addr().unwrap();
        drop(gone);
        let down = account_at(&format!("http://{addr}"), "reporter-token", Path::new("/r"));
        assert_eq!(
            claimed_for(&down).await,
            None,
            "a core that is down told something"
        );
    }
}
