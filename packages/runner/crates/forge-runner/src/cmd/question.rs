//! `question` — what a master on this box calls to ask a person, and to read
//! the answer back.
//!
//! Core has owned the question entity, its two doors and the two screens that
//! read it since ISS-964, and `forge-runner-core`'s `transport::questions` has
//! implemented the device door since ISS-996. Measured at `710ab641`, nothing
//! called it: `transport::questions` appeared nowhere outside its own module,
//! and no verb asked. So the box holding the only credential that reaches
//! `POST /api/devices/me/questions` had no route to it, and the Agents screen's
//! Questions tab — built for the questions carrying no issue, which is what a
//! master asks — was fed by nothing (ISS-1210).
//!
//! Like `run` and unlike `hook`, this verb fails loudly. An ask that was refused
//! and reported success would leave a master believing a person had been asked
//! when nobody had, which is the silence this verb exists to end.
//!
//! What a question MEANS is core's, not this verb's. The only shape refused here
//! is `--option`'s own `id=label` syntax, which core never sees; every question
//! rule — a recommended option that is not an option, two options under one id,
//! a free-text round that states no need — is core's to refuse, so there is one
//! authority on it and its wording reaches the caller unaltered.

use clap::{Args as ClapArgs, Subcommand};
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::error::Error;
use forge_runner_core::transport::questions::{self, Answer, Ask};
use forge_runner_core::transport::CoreClient;

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    pub cmd: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Ask a person, on this box's device pairing.
    Ask(AskArgs),
    /// Read back the answer to a question this box asked.
    Answer(AnswerArgs),
}

#[derive(ClapArgs)]
pub struct AskArgs {
    /// The project to ask under: the slug `bind` knows, or the project's id.
    #[arg(long)]
    pub project: String,
    /// What is being asked, in the words the person will read.
    #[arg(long)]
    pub prompt: String,
    /// What would settle it. A question offering no options asks for this.
    #[arg(long)]
    pub needs: Option<String>,
    /// An option the person clicks instead of typing, `id=label`, repeatable.
    #[arg(long = "option", value_name = "ID=LABEL")]
    pub options: Vec<String>,
    /// Which option is recommended, by id.
    #[arg(long)]
    pub recommend: Option<String>,
    /// The issue this is about. Left out, the question is the box's own and is
    /// answered on the Agents screen's Questions tab rather than on an issue.
    #[arg(long)]
    pub issue: Option<String>,
    /// The run this question belongs to. Minted where absent, and printed
    /// either way, because the answer is served back only under it.
    #[arg(long)]
    pub run: Option<String>,
    /// Who is blocked on the answer: `human`, `machine` or `master_or_peer`.
    #[arg(long, default_value = "human")]
    pub blocker: String,
    /// The role an option needs to be chosen: `writer` or `admin`.
    #[arg(long, default_value = "writer")]
    pub authority: String,
    /// This round's material is private to whoever asked.
    #[arg(long)]
    pub sensitive: bool,
}

#[derive(ClapArgs)]
pub struct AnswerArgs {
    /// The question id `question ask` printed.
    pub question_id: String,
    /// The run identity `question ask` printed beside it.
    #[arg(long)]
    pub run: String,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    match args.cmd {
        Command::Ask(a) => ask(ctx, a).await,
        Command::Answer(a) => answer(ctx, a).await,
    }
}

/// The answer half of a question, as it goes on the wire.
///
/// `answer_shape` is `None` for a choice round, which is the wire default every
/// box asked for before ISS-996 and what core reads a missing field as.
#[derive(Debug)]
struct Shape {
    answer_shape: Option<&'static str>,
    options: serde_json::Value,
    recommended_option_id: String,
    needed: Option<String>,
}

fn shape_of(a: &AskArgs) -> anyhow::Result<Shape> {
    let needs = a.needs.as_deref().map(str::trim).filter(|s| !s.is_empty());
    match (needs, a.options.is_empty()) {
        (Some(_), false) => anyhow::bail!(
            "`--needs` and `--option` are the two shapes a round can have and this ask sent both. \
             `--needs` asks the person to type what would settle it; `--option id=label` asks them \
             to click one. Send one of them."
        ),
        (None, true) => anyhow::bail!(
            "this ask carries neither `--needs` nor `--option`, so the person is being asked to \
             guess what counts as an answer. Say what would settle it with `--needs \"<what you \
             need>\"`, or offer `--option id=label` and name one with `--recommend <id>`."
        ),
        (Some(need), true) => Ok(Shape {
            answer_shape: Some("free_text"),
            options: serde_json::json!([]),
            recommended_option_id: String::new(),
            needed: Some(need.to_string()),
        }),
        (None, false) => Ok(Shape {
            answer_shape: None,
            options: options_of(&a.options, &a.authority)?,
            recommended_option_id: a.recommend.clone().unwrap_or_default(),
            needed: None,
        }),
    }
}

/// `bindsTo` is `session` and `executedBy` is `agent` because this is a master
/// asking about the work it is doing: the answer governs that run and the
/// master is what acts on it. `this_call` is the one binding core refuses
/// without a fingerprint of the call it permits, which this verb has none of.
fn options_of(raw: &[String], authority: &str) -> anyhow::Result<serde_json::Value> {
    let mut out = Vec::with_capacity(raw.len());
    for o in raw {
        let Some((id, label)) = o.split_once('=') else {
            anyhow::bail!(
                "`--option {o}` is not `id=label`. An answer names an option by id and a person \
                 reads its label, so an option needs both: `--option keep=Keep the current name`."
            );
        };
        out.push(serde_json::json!({
            "id": id.trim(),
            "label": label.trim(),
            "authority": authority,
            "bindsTo": "session",
            "executedBy": "agent",
        }));
    }
    Ok(serde_json::Value::Array(out))
}

/// The project id to ask under: a slug this box has bound resolves to the id
/// core knows it by, and anything else is sent as given so core refuses the
/// value the caller actually typed rather than one this verb invented.
fn project_id_of(cfg: &Config, project: &str) -> String {
    cfg.bindings
        .get(project)
        .and_then(|b| b.project_id.clone())
        .unwrap_or_else(|| project.to_string())
}

fn client_for(ctx: &Ctx, cfg: &Config) -> anyhow::Result<CoreClient> {
    let Some(core_url) = ctx.resolve_core_url(cfg) else {
        anyhow::bail!(
            "no core url on this box, so there is nowhere to ask — set one with \
             `forge-runner config` or pass `--core-url <endpoint>`"
        );
    };
    let Some(token) = cred_store::load_device_token()? else {
        anyhow::bail!(
            "this box holds no device token, so it cannot ask on its own pairing — \
             `forge-runner login` pairs it"
        );
    };
    Ok(CoreClient::new(core_url, token))
}

async fn send_ask(
    client: &CoreClient,
    a: &AskArgs,
    project_id: &str,
    id: &str,
    run_id: &str,
) -> forge_runner_core::Result<String> {
    let shape = match shape_of(a) {
        Ok(s) => s,
        Err(e) => return Err(Error::Other(e.to_string())),
    };
    questions::ask(
        client,
        Ask {
            id,
            project_id,
            run_id,
            issue_id: a.issue.as_deref(),
            agent_session_id: None,
            prompt: &a.prompt,
            blocker_kind: &a.blocker,
            answer_shape: shape.answer_shape,
            options: shape.options,
            recommended_option_id: &shape.recommended_option_id,
            needed: shape.needed.as_deref(),
            assumed: None,
            cost: None,
            sensitive: Some(a.sensitive),
        },
    )
    .await
}

async fn ask(ctx: Ctx, a: AskArgs) -> anyhow::Result<()> {
    // Refused here rather than inside `send_ask` so a malformed `--option`
    // costs no round trip and reads as this verb's refusal, not core's.
    shape_of(&a)?;
    let cfg = Config::load()?;
    let client = client_for(&ctx, &cfg)?;
    let project_id = project_id_of(&cfg, &a.project);
    let id = uuid::Uuid::new_v4().to_string();
    let run_id = a
        .run
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    match send_ask(&client, &a, &project_id, &id, &run_id).await {
        Ok(question_id) => {
            print!("{}", asked(&question_id, &run_id, a.issue.as_deref()));
            Ok(())
        }
        Err(e) => Err(refused_ask(e)),
    }
}

async fn answer(ctx: Ctx, a: AnswerArgs) -> anyhow::Result<()> {
    let cfg = Config::load()?;
    let client = client_for(&ctx, &cfg)?;
    match questions::answer(&client, &a.question_id, &a.run).await {
        Ok(found) => {
            print!("{}", read_back(&a.question_id, found.as_ref()));
            Ok(())
        }
        Err(e) => Err(refused_answer(e, &a.question_id, &a.run)),
    }
}

/// What the caller is left holding: the id core minted, the run identity the
/// read-back is served under, and the command that reads it. An ask made with
/// no `--run` mints one, so a caller that ran only this command can still come
/// back for the answer.
fn asked(question_id: &str, run_id: &str, issue_id: Option<&str>) -> String {
    let where_answered = match issue_id {
        Some(issue) => format!("It is on issue {issue}, under Decisions.\n"),
        None => "It carries no issue, so it is on the Agents screen's Questions tab.\n".to_string(),
    };
    format!(
        "question {question_id}\nrun      {run_id}\n{where_answered}\
         Read the answer back with:\n  forge-runner question answer {question_id} --run {run_id}\n"
    )
}

fn read_back(question_id: &str, found: Option<&Answer>) -> String {
    let Some(a) = found else {
        return format!(
            "question {question_id}: unanswered.\n\
             It is still open and nobody has answered it yet — nothing here failed.\n"
        );
    };
    let round = a.round.unwrap_or(1);
    let by = a.answered_by.as_deref().unwrap_or("someone unrecorded");
    let at = a.answered_at.as_deref().unwrap_or("a time unrecorded");
    match (a.option_id.as_deref(), a.text.as_deref()) {
        (Some(option), _) => format!(
            "question {question_id}: answered on round {round} by {by} at {at}.\n\
             They chose option {option}.\n"
        ),
        (None, Some(text)) => format!(
            "question {question_id}: answered on round {round} by {by} at {at}.\n\
             They wrote: {text}\n"
        ),
        (None, None) => format!(
            "question {question_id}: core reports it answered on round {round} by {by} at {at}, \
             and the answer carries neither an option nor any words.\n\
             There is nothing here to act on — read the round on the screen before doing anything \
             with it.\n"
        ),
    }
}

fn refused_ask(err: Error) -> anyhow::Error {
    match err {
        Error::Unauthorized => anyhow::anyhow!(
            "core did not accept this box's device credential, so no question was written and \
             nobody has been asked anything. This is the credential and not the question: pair \
             the box again with `forge-runner login`, then repeat the command."
        ),
        other => anyhow::anyhow!("{other}"),
    }
}

fn refused_answer(err: Error, question_id: &str, run_id: &str) -> anyhow::Error {
    match err {
        Error::Unauthorized => anyhow::anyhow!(
            "core did not accept this box's device credential, so no answer was read. This is \
             the credential and not the question: pair the box again with `forge-runner login`."
        ),
        Error::Other(m) if m.contains("not registered") => anyhow::anyhow!(
            "this box registered no waiter for question {question_id} under run {run_id}, so core \
             serves it no answer. A read-back goes only to the box that asked, under the run \
             identity that ask carried — `question ask` prints that identity, and it is the one to \
             pass here. The answer itself is on the screen either way."
        ),
        other => anyhow::anyhow!("{other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> AskArgs {
        AskArgs {
            project: "forge-dev".into(),
            prompt: "which name should the column keep?".into(),
            needs: None,
            options: vec![],
            recommend: None,
            issue: None,
            run: None,
            blocker: "human".into(),
            authority: "writer".into(),
            sensitive: false,
        }
    }

    #[test]
    fn a_round_that_is_both_shapes_at_once_is_refused_naming_both_flags() {
        let mut a = args();
        a.needs = Some("the column name".into());
        a.options = vec!["keep=Keep it".into()];
        let err = shape_of(&a).expect_err("two shapes in one round must not be sent");
        let text = format!("{err}");
        assert!(
            text.contains("--needs") && text.contains("--option"),
            "{text}"
        );
    }

    #[test]
    fn a_round_with_no_shape_at_all_is_refused_naming_both_ways_out() {
        let err = shape_of(&args()).expect_err("a round asking for nothing must not be sent");
        let text = format!("{err}");
        assert!(
            text.contains("--needs") && text.contains("--option"),
            "{text}"
        );
    }

    /// Blank is the same as absent: a `--needs ""` that went up as a free-text
    /// round would ask the person to guess, which is what core refuses on
    /// arrival — and refusing it here says so without the round trip.
    #[test]
    fn a_blank_need_is_no_shape() {
        let mut a = args();
        a.needs = Some("   ".into());
        assert!(shape_of(&a).is_err());
    }

    #[test]
    fn a_need_becomes_a_free_text_round_carrying_it() {
        let mut a = args();
        a.needs = Some("  the column name  ".into());
        let s = shape_of(&a).unwrap();
        assert_eq!(s.answer_shape, Some("free_text"));
        assert_eq!(s.needed.as_deref(), Some("the column name"));
        assert_eq!(s.options, serde_json::json!([]));
    }

    #[test]
    fn options_become_a_choice_round_core_reads_as_one() {
        let mut a = args();
        a.options = vec!["keep=Keep it".into(), "rename=Rename it".into()];
        a.recommend = Some("keep".into());
        let s = shape_of(&a).unwrap();
        assert_eq!(s.answer_shape, None, "a choice round sends no answerShape");
        assert_eq!(s.recommended_option_id, "keep");
        let opts = s.options.as_array().expect("options are an array");
        assert_eq!(opts.len(), 2);
        assert_eq!(opts[0]["id"], "keep");
        assert_eq!(opts[0]["label"], "Keep it");
        assert_eq!(opts[0]["authority"], "writer");
        assert_eq!(
            opts[0]["bindsTo"], "session",
            "`this_call` is refused by core without a fingerprint this verb has none of"
        );
    }

    #[test]
    fn an_option_that_is_not_id_equals_label_is_refused_naming_the_one_that_is_wrong() {
        let mut a = args();
        a.options = vec!["keep=Keep it".into(), "rename".into()];
        let err = shape_of(&a).expect_err("an option with no id must not be sent");
        let text = format!("{err}");
        assert!(
            text.contains("rename") && text.contains("id=label"),
            "{text}"
        );
    }

    #[test]
    fn a_bound_slug_resolves_to_the_id_core_knows_the_project_by() {
        let mut cfg = Config::default();
        cfg.bindings.insert(
            "forge-dev".into(),
            forge_runner_core::config::Binding {
                repo_path: std::path::PathBuf::from("/tmp/forge-dev"),
                branch: None,
                project_id: Some("p-uuid".into()),
            },
        );
        assert_eq!(project_id_of(&cfg, "forge-dev"), "p-uuid");
    }

    #[test]
    fn an_unbound_project_is_sent_exactly_as_it_was_typed() {
        let cfg = Config::default();
        assert_eq!(project_id_of(&cfg, "typo-dev"), "typo-dev");
    }

    #[test]
    fn what_the_ask_prints_carries_the_command_that_reads_the_answer() {
        let out = asked("q-1", "run-7", None);
        assert!(out.contains("q-1") && out.contains("run-7"), "{out}");
        assert!(
            out.contains("forge-runner question answer q-1 --run run-7"),
            "a caller that ran only `ask` must be able to copy the read-back: {out}"
        );
        assert!(
            out.contains("Questions tab"),
            "a question carrying no issue is answered there: {out}"
        );
    }

    #[test]
    fn an_ask_about_an_issue_says_the_answer_is_on_that_issue() {
        let out = asked("q-1", "run-7", Some("iss-uuid"));
        assert!(
            out.contains("iss-uuid") && out.contains("Decisions"),
            "{out}"
        );
    }

    #[test]
    fn an_unanswered_question_reads_as_unanswered_and_not_as_a_failure() {
        let out = read_back("q-1", None);
        assert!(out.contains("unanswered"), "{out}");
        assert!(out.contains("nothing here failed"), "{out}");
    }

    #[test]
    fn a_chosen_option_is_printed_with_who_chose_it_and_when() {
        let out = read_back(
            "q-1",
            Some(&Answer {
                question_id: "q-1".into(),
                answer_shape: None,
                option_id: Some("keep".into()),
                text: None,
                answered_at: Some("2026-09-23T10:00:00.000Z".into()),
                answered_by: Some("u-1".into()),
                round: Some(2),
            }),
        );
        assert!(out.contains("option keep"), "{out}");
        assert!(out.contains("round 2") && out.contains("u-1"), "{out}");
    }

    #[test]
    fn words_are_printed_as_words() {
        let out = read_back(
            "q-1",
            Some(&Answer {
                question_id: "q-1".into(),
                answer_shape: Some("free_text".into()),
                option_id: None,
                text: Some("the second reading".into()),
                answered_at: None,
                answered_by: None,
                round: None,
            }),
        );
        assert!(out.contains("the second reading"), "{out}");
    }

    /// Core answers `answered` with neither an option nor words nowhere in its
    /// own code — so if one ever arrives, saying so beats printing an empty
    /// line that reads as an answer somebody gave.
    #[test]
    fn an_answer_carrying_nothing_says_there_is_nothing_to_act_on() {
        let out = read_back(
            "q-1",
            Some(&Answer {
                question_id: "q-1".into(),
                answer_shape: None,
                option_id: None,
                text: None,
                answered_at: None,
                answered_by: None,
                round: Some(1),
            }),
        );
        assert!(out.contains("neither an option nor any words"), "{out}");
        assert!(out.contains("nothing here to act on"), "{out}");
    }

    #[test]
    fn a_credential_core_will_not_take_is_reported_as_the_credential() {
        let text = format!("{}", refused_ask(Error::Unauthorized));
        assert!(text.contains("credential"), "{text}");
        assert!(
            text.contains("nobody has been asked anything"),
            "an ask core never took must not read as a question that was asked: {text}"
        );
        assert!(text.contains("forge-runner login"), "{text}");
    }

    #[test]
    fn a_refusal_core_made_reaches_the_caller_in_cores_own_words() {
        let text = format!(
            "{}",
            refused_ask(Error::Other(
                "question ask: 400 Bad Request: {\"error\":\"prompt required\"}".into()
            ))
        );
        assert!(
            text.contains("400") && text.contains("prompt required"),
            "{text}"
        );
    }

    #[test]
    fn a_question_this_box_is_not_the_waiter_for_names_the_waiter_it_never_registered() {
        let text = format!(
            "{}",
            refused_answer(
                Error::Other("question read: q-1 is not registered to this box for run r-9".into()),
                "q-1",
                "r-9",
            )
        );
        assert!(text.contains("registered no waiter"), "{text}");
        assert!(text.contains("q-1") && text.contains("r-9"), "{text}");
    }

    /// One request, one canned response, and the request text back — enough to
    /// hold a claim about what goes ON THE WIRE, which no shape test reaches.
    async fn one_shot(
        status: &str,
        body: &str,
    ) -> (String, tokio::sync::oneshot::Receiver<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let resp = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = vec![0u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.flush().await;
            }
        });
        (format!("http://{addr}"), rx)
    }

    #[tokio::test]
    async fn an_ask_reaches_the_device_door_carrying_what_the_caller_typed() {
        let (base, request) = one_shot("200 OK", r#"{"questionId":"q-9"}"#).await;
        let client = CoreClient::new(base, "tok");
        let mut a = args();
        a.needs = Some("the column name".into());
        let id = send_ask(&client, &a, "p-1", "q-local", "run-7")
            .await
            .expect("core took the question");
        assert_eq!(
            id, "q-9",
            "the id core answers is the id the caller is given"
        );

        let sent = request.await.expect("the request reached the door");
        assert!(
            sent.contains("POST /api/devices/me/questions"),
            "the device door is the one a box may open: {sent}"
        );
        assert!(sent.contains("Bearer tok"), "{sent}");
        assert!(sent.contains("\"projectId\":\"p-1\""), "{sent}");
        assert!(sent.contains("\"runId\":\"run-7\""), "{sent}");
        assert!(sent.contains("\"answerShape\":\"free_text\""), "{sent}");
        assert!(sent.contains("the column name"), "{sent}");
        assert!(
            !sent.contains("\"issueId\""),
            "an ask with no --issue must carry none, or it never reaches the Questions tab: {sent}"
        );
    }

    #[tokio::test]
    async fn an_ask_about_an_issue_carries_that_issue_to_the_door() {
        let (base, request) = one_shot("200 OK", r#"{"questionId":"q-9"}"#).await;
        let client = CoreClient::new(base, "tok");
        let mut a = args();
        a.needs = Some("the column name".into());
        a.issue = Some("iss-uuid".into());
        send_ask(&client, &a, "p-1", "q-local", "run-7")
            .await
            .unwrap();
        let sent = request.await.unwrap();
        assert!(sent.contains("\"issueId\":\"iss-uuid\""), "{sent}");
    }

    /// The body this verb puts on the wire, pinned as a file because the two
    /// packages do not import each other and core's own suite reads the same
    /// file back through the door. A field renamed on one side and not the
    /// other fails here and in `pool-routes-questions.test.ts`, rather than on
    /// a box where the question simply never appears.
    const WIRE: &str = include_str!("../../../forge-runner-core/assets/question-ask-wire.jsonl");

    fn wire_line(n: usize) -> serde_json::Value {
        serde_json::from_str(WIRE.lines().nth(n).expect("the fixture carries this line"))
            .expect("the fixture is json")
    }

    fn body_of(request: &str) -> serde_json::Value {
        let body = request
            .split_once("\r\n\r\n")
            .expect("a request has a body")
            .1;
        serde_json::from_str(body).expect("the body is json")
    }

    #[tokio::test]
    async fn a_free_text_ask_puts_exactly_the_pinned_body_on_the_wire() {
        let (base, request) = one_shot("200 OK", r#"{"questionId":"q-9"}"#).await;
        let client = CoreClient::new(base, "tok");
        let mut a = args();
        a.needs = Some("the column name".into());
        a.issue = Some("iss-uuid".into());
        send_ask(&client, &a, "p-1", "q-local", "run-7")
            .await
            .unwrap();
        assert_eq!(body_of(&request.await.unwrap()), wire_line(0));
    }

    #[tokio::test]
    async fn a_choice_ask_puts_exactly_the_pinned_body_on_the_wire() {
        let (base, request) = one_shot("200 OK", r#"{"questionId":"q-9"}"#).await;
        let client = CoreClient::new(base, "tok");
        let mut a = args();
        a.options = vec!["keep=Keep it".into(), "rename=Rename it".into()];
        a.recommend = Some("keep".into());
        a.sensitive = true;
        send_ask(&client, &a, "p-1", "q-local-2", "run-8")
            .await
            .unwrap();
        assert_eq!(body_of(&request.await.unwrap()), wire_line(1));
    }

    #[tokio::test]
    async fn a_door_that_refuses_leaves_the_caller_holding_cores_status_and_body() {
        let (base, _request) = one_shot("400 Bad Request", r#"{"error":"prompt required"}"#).await;
        let client = CoreClient::new(base, "tok");
        let mut a = args();
        a.needs = Some("the column name".into());
        let err = send_ask(&client, &a, "p-1", "q-local", "run-7")
            .await
            .expect_err("a refusal must not read as an asked question");
        let text = format!("{}", refused_ask(err));
        assert!(
            text.contains("400") && text.contains("prompt required"),
            "{text}"
        );
    }
}
