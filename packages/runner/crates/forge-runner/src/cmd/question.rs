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
use runner_platform::config::Config;
use runner_platform::cred_store;
use runner_platform::error::Error;
use runner_transport::questions::{self, Answer, Ask};
use runner_transport::CoreClient;

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    pub cmd: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Ask a person, on this box's device pairing.
    Ask(Box<AskArgs>),
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
    /// Which option is recommended, by id; with `--needs`, the answer you
    /// recommend, in the words the person may send as it stands. Core refuses a
    /// free-text ask of a person without one (REQ-41 BC-2).
    #[arg(long)]
    pub recommend: Option<String>,
    /// The issue this is about. Left out, the question is the box's own and is
    /// answered on the Agents screen's Questions tab rather than on an issue.
    #[arg(long)]
    pub issue: Option<String>,
    /// The requirement a business question is about, by key (REQ-n) or id. With
    /// no `--issue` the question stands on it: it is listed on that requirement
    /// and its answer is recorded there as a decision.
    #[arg(long, value_name = "REQ-N", conflicts_with = "contract")]
    pub requirement: Option<String>,
    /// The contract a business question is about, `<project>/<contract>`.
    #[arg(long, value_name = "PROJECT/CONTRACT")]
    pub contract: Option<String>,
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
        Command::Ask(a) => ask(ctx, *a).await,
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
    /// A free-text round's recommended answer, sent as written.
    recommended: Option<String>,
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
            recommended: a
                .recommend
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        }),
        (None, false) => Ok(Shape {
            answer_shape: None,
            options: options_of(&a.options, &a.authority)?,
            recommended_option_id: a.recommend.clone().unwrap_or_default(),
            needed: None,
            recommended: None,
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

/// The identity this ask is registered under.
///
/// An absent `--run` is minted, because a master asking from its pane may hold
/// no run id and would otherwise be unable to read its own answer back. An
/// EMPTY one is a caller that meant to pass an identity and passed nothing, and
/// it is refused rather than treated as absent: core registers a waiter only
/// for a truthy `runId`, so an empty string is accepted by the door, no waiter
/// is written, and the read-back this verb prints refuses forever. A run is
/// kernel input, where a representable-looking wrong value is how state starts
/// lying, so it is refused by name.
fn run_identity(run: Option<&str>) -> anyhow::Result<String> {
    match run {
        None => Ok(uuid::Uuid::new_v4().to_string()),
        Some(r) if r.trim().is_empty() => anyhow::bail!(
            "`--run` was given with nothing in it. An empty run identity registers this box as \
             the waiter for nothing, so the question would be created and its answer never \
             readable from here. Pass the run this question belongs to, or leave `--run` off \
             and one is minted for you."
        ),
        Some(r) => Ok(r.trim().to_string()),
    }
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
) -> runner_platform::Result<String> {
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
            recommended: shape.recommended.as_deref(),
            assumed: None,
            cost: None,
            sensitive: Some(a.sensitive),
            about: about_of(a),
        },
    )
    .await
}

/// `about` in core's one shape, sent as typed: core resolves the key and
/// refuses one naming nothing (`QUESTION_ABOUT_UNKNOWN`), so that rule has one
/// authority and its wording reaches the caller unaltered.
fn about_of(a: &AskArgs) -> Option<serde_json::Value> {
    match (a.requirement.as_deref(), a.contract.as_deref()) {
        (Some(r), _) => Some(serde_json::json!({ "requirement": r })),
        (None, Some(c)) => Some(serde_json::json!({ "contract": c })),
        (None, None) => None,
    }
}

async fn ask(ctx: Ctx, a: AskArgs) -> anyhow::Result<()> {
    // Refused here rather than inside `send_ask` so a malformed `--option`
    // costs no round trip and reads as this verb's refusal, not core's.
    shape_of(&a)?;
    run_identity(a.run.as_deref())?;
    let cfg = Config::load()?;
    let client = client_for(&ctx, &cfg)?;
    let project_id = project_id_of(&cfg, &a.project);
    let id = uuid::Uuid::new_v4().to_string();
    let run_id = run_identity(a.run.as_deref())?;
    match send_ask(&client, &a, &project_id, &id, &run_id).await {
        Ok(question_id) => {
            print!(
                "{}",
                asked(
                    &question_id,
                    &run_id,
                    a.issue.as_deref(),
                    subject_of(&a),
                    ctx.core_url_override.as_deref(),
                )
            );
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

/// Single-quoted for a POSIX shell where it needs to be.
///
/// The line below is printed to be pasted, and a run identity is free text: one
/// carrying a space or an `&` pasted unquoted is a different command — two
/// arguments, or half of it backgrounded — and one carrying `$(…)` is a
/// substitution this verb printed and the shell then ran. Anything outside the
/// unreserved set is quoted, and an embedded quote is closed and reopened the
/// way a shell takes it.
fn shell_quoted(value: &str) -> String {
    let plain = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:@".contains(c));
    if plain {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// What the caller is left holding: the id core minted, the run identity the
/// read-back is served under, and the command that reads it. An ask made with
/// no `--run` mints one, so a caller that ran only this command can still come
/// back for the answer.
fn asked(
    question_id: &str,
    run_id: &str,
    issue_id: Option<&str>,
    subject: Option<String>,
    core_url_override: Option<&str>,
) -> String {
    let where_answered = match (issue_id, subject) {
        (Some(issue), _) => format!("It is on issue {issue}, under Decisions.\n"),
        (None, Some(subject)) => {
            format!(
                "It carries no issue and is about {subject}, so it is answered from Needs you.\n"
            )
        }
        (None, None) => {
            "It carries no issue, so it is on the Agents screen's Questions tab.\n".to_string()
        }
    };
    // The override travels with the invocation or the paste asks a different
    // core, which has neither the question nor the waiter and refuses.
    let endpoint = match core_url_override {
        Some(url) => format!(" --core-url {}", shell_quoted(url)),
        None => String::new(),
    };
    let (q, r) = (shell_quoted(question_id), shell_quoted(run_id));
    format!(
        "question {question_id}\nrun      {run_id}\n{where_answered}\
         Read the answer back with:\n  forge-runner{endpoint} question answer {q} --run {r}\n"
    )
}

/// What the question is about, as the line after an ask names it.
fn subject_of(a: &AskArgs) -> Option<String> {
    match (a.requirement.as_deref(), a.contract.as_deref()) {
        (Some(r), _) => Some(format!("requirement {}", r.trim())),
        (None, Some(c)) => Some(format!("contract {}", c.trim())),
        (None, None) => None,
    }
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

    fn args(needs: Option<&str>, recommend: Option<&str>, options: &[&str]) -> AskArgs {
        AskArgs {
            project: "forge-dev".into(),
            prompt: "Which region does the backup go to?".into(),
            needs: needs.map(str::to_string),
            options: options.iter().map(|o| o.to_string()).collect(),
            recommend: recommend.map(str::to_string),
            issue: None,
            requirement: None,
            contract: None,
            run: None,
            blocker: "human".into(),
            authority: "writer".into(),
            sensitive: false,
        }
    }

    #[test]
    fn a_free_text_ask_carries_the_answer_it_recommends() {
        let shape = shape_of(&args(Some("a region name"), Some(" eu-west-1 "), &[])).unwrap();
        assert_eq!(shape.answer_shape, Some("free_text"));
        assert_eq!(shape.recommended.as_deref(), Some("eu-west-1"));
        assert_eq!(shape.recommended_option_id, "");
    }

    #[test]
    fn a_blank_recommendation_is_sent_as_none_for_core_to_refuse_by_name() {
        let shape = shape_of(&args(Some("a region name"), Some("  "), &[])).unwrap();
        assert_eq!(shape.recommended, None);
    }

    #[test]
    fn a_choice_ask_names_its_recommended_option_by_id_and_sends_no_text() {
        let shape = shape_of(&args(None, Some("keep"), &["keep=Keep it", "move=Move it"])).unwrap();
        assert_eq!(shape.recommended_option_id, "keep");
        assert_eq!(shape.recommended, None);
    }

    fn ask_line(argv: &[&str]) -> Result<AskArgs, clap::Error> {
        #[derive(clap::Parser)]
        struct Cli {
            #[command(subcommand)]
            cmd: Command,
        }
        let mut full = vec![
            "forge-runner",
            "ask",
            "--project",
            "forge",
            "--prompt",
            "May they?",
        ];
        full.extend_from_slice(argv);
        match <Cli as clap::Parser>::try_parse_from(full)?.cmd {
            Command::Ask(a) => Ok(*a),
            Command::Answer(_) => unreachable!("the line names ask"),
        }
    }

    #[test]
    fn a_requirement_only_ask_sends_the_requirement_as_its_about_and_no_issue() {
        let a = ask_line(&[
            "--requirement",
            "REQ-74",
            "--needs",
            "yes or no",
            "--recommend",
            "no",
        ])
        .unwrap();
        assert_eq!(a.issue, None);
        assert_eq!(
            about_of(&a),
            Some(serde_json::json!({ "requirement": "REQ-74" }))
        );
        let line = asked("q1", "r1", None, subject_of(&a), None);
        assert!(line.contains("about requirement REQ-74"), "{line}");
        assert!(line.contains("Needs you"), "{line}");
    }

    #[test]
    fn a_contract_ask_sends_the_contract_as_its_about() {
        let a = ask_line(&["--contract", "forge/forge-api", "--needs", "which"]).unwrap();
        assert_eq!(
            about_of(&a),
            Some(serde_json::json!({ "contract": "forge/forge-api" }))
        );
    }

    #[test]
    fn a_requirement_and_a_contract_together_are_refused_by_name() {
        let err = ask_line(&[
            "--requirement",
            "REQ-74",
            "--contract",
            "forge/forge-api",
            "--needs",
            "x",
        ])
        .err()
        .expect("both subjects at once must be refused");
        assert_eq!(err.kind(), clap::error::ErrorKind::ArgumentConflict);
        assert!(err.to_string().contains("--contract"), "{err}");
    }

    #[test]
    fn an_ask_naming_neither_sends_no_about_and_stays_the_boxs_own() {
        let a = ask_line(&["--needs", "a region name"]).unwrap();
        assert_eq!(about_of(&a), None);
        let line = asked("q1", "r1", None, subject_of(&a), None);
        assert!(line.contains("Agents screen's Questions tab"), "{line}");
    }

    #[test]
    fn an_issue_ask_keeps_its_issue_and_carries_the_requirement_beside_it() {
        let a = ask_line(&[
            "--issue",
            "ISS-678",
            "--requirement",
            "REQ-74",
            "--needs",
            "x",
        ])
        .unwrap();
        assert_eq!(a.issue.as_deref(), Some("ISS-678"));
        assert_eq!(
            about_of(&a),
            Some(serde_json::json!({ "requirement": "REQ-74" }))
        );
        let line = asked("q1", "r1", a.issue.as_deref(), subject_of(&a), None);
        assert!(line.contains("on issue ISS-678"), "{line}");
    }
}
