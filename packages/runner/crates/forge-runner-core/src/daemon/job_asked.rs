//! What a job pane that was ended `Blocked` was stopped on, as core's blocked
//! door takes it.
//!
//! The pane's own transcript holds the call it is waiting on, so that is read
//! rather than the screen. Whatever it holds, the answer is never empty: a
//! question this box could not read is sent as `Unread` with the reason, since
//! core must still hold the work for a person and say why it could not say more.

use std::path::Path;

use serde_json::{json, Value};

use crate::daemon::transcript_age::{self, Unanswered};

/// The dialog tool whose input carries a question and its options.
pub const DIALOG_TOOL: &str = "AskUserQuestion";

/// How much of a non-dialog call's input travels.
const INPUT_CUT: usize = 2000;

/// The bounds core's blocked door validates a report against, counted the way it counts them (UTF-16
/// code units). A report outside them is refused whole with a 400 that no retry changes, so a dialog
/// outside them is sent as `Unread` naming the bound instead. `blocked-wire.test.ts` in core reads
/// this block and holds the two sides to the same numbers.
const WIRE_QUESTIONS_MAX: usize = 10;
const WIRE_QUESTION_MAX: usize = 4000;
const WIRE_HEADER_MAX: usize = 200;
const WIRE_OPTIONS_MAX: usize = 10;
const WIRE_LABEL_MAX: usize = 500;
const WIRE_DESCRIPTION_MAX: usize = 2000;
const WIRE_TOOL_MAX: usize = 200;
const WIRE_WHY_MAX: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogOption {
    pub label: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogQuestion {
    pub question: String,
    pub header: Option<String>,
    pub multi_select: bool,
    pub options: Vec<DialogOption>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Asked {
    Dialog(Vec<DialogQuestion>),
    Permission { tool: String, input: String },
    Unread(String),
}

impl Asked {
    /// The wire shape core's blocked door validates strictly.
    pub fn to_json(&self) -> Value {
        match self {
            Asked::Dialog(questions) => json!({
                "kind": "dialog",
                "questions": questions.iter().map(question_json).collect::<Vec<_>>(),
            }),
            Asked::Permission { tool, input } => {
                json!({ "kind": "permission", "tool": tool, "input": input })
            }
            Asked::Unread(why) => json!({ "kind": "unread", "why": why }),
        }
    }
}

fn question_json(q: &DialogQuestion) -> Value {
    let mut out = json!({
        "question": q.question,
        "multiSelect": q.multi_select,
        "options": q.options.iter().map(option_json).collect::<Vec<_>>(),
    });
    if let Some(header) = &q.header {
        out["header"] = Value::String(header.clone());
    }
    out
}

fn option_json(o: &DialogOption) -> Value {
    let mut out = json!({ "label": o.label });
    if let Some(description) = &o.description {
        out["description"] = Value::String(description.clone());
    }
    out
}

/// What the pane whose conversation is written at `transcript` is stopped on.
pub fn asked_by(transcript: Option<&str>) -> Asked {
    match read_asked(transcript) {
        Asked::Unread(why) => Asked::Unread(units(&why, WIRE_WHY_MAX)),
        Asked::Permission { tool, .. } if tool.is_empty() || len(&tool) > WIRE_TOOL_MAX => {
            Asked::Unread(format!(
                "the pane's pending call names a tool of {} characters, outside the 1 to {WIRE_TOOL_MAX} core takes",
                len(&tool)
            ))
        }
        other => other,
    }
}

fn read_asked(transcript: Option<&str>) -> Asked {
    let Some(path) = transcript else {
        return Asked::Unread(
            "this box knows no transcript for the pane, so what it asked could not be read".into(),
        );
    };
    match transcript_age::unanswered_call(Path::new(path)) {
        None => Asked::Unread(format!(
            "the pane's transcript at {path} could not be opened or read"
        )),
        Some(Unanswered::Nothing) => Asked::Unread(
            "the newest entry of the pane's transcript is not a tool call awaiting an answer"
                .into(),
        ),
        Some(Unanswered::Call(call)) if call.name == DIALOG_TOOL => dialog_of(&call.input),
        Some(Unanswered::Call(call)) => Asked::Permission {
            tool: call.name,
            input: cut(&call.input.to_string(), INPUT_CUT),
        },
    }
}

fn cut(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}

/// UTF-16 code units, which is what core's string bounds count.
fn len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text` shortened to at most `max` UTF-16 code units, never through a character.
fn units(text: &str, max: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in text.chars() {
        used += c.len_utf16();
        if used > max {
            break;
        }
        out.push(c);
    }
    out
}

/// The first bound a dialog breaks, said by name, or `None` where core will take it as it is.
fn outside_the_wire(questions: &[DialogQuestion]) -> Option<String> {
    if questions.len() > WIRE_QUESTIONS_MAX {
        return Some(format!(
            "the dialog asks {} questions and core takes {WIRE_QUESTIONS_MAX}",
            questions.len()
        ));
    }
    for (i, q) in questions.iter().enumerate() {
        let n = i + 1;
        let breaks = |what: &str, got: usize, max: usize, min: usize| {
            (got < min || got > max).then(|| {
                format!("question {n} of the dialog has a {what} of {got} characters, outside the {min} to {max} core takes")
            })
        };
        if let Some(said) = breaks("text", len(&q.question), WIRE_QUESTION_MAX, 1) {
            return Some(said);
        }
        if let Some(header) = &q.header {
            if let Some(said) = breaks("header", len(header), WIRE_HEADER_MAX, 0) {
                return Some(said);
            }
        }
        if q.options.len() > WIRE_OPTIONS_MAX {
            return Some(format!(
                "question {n} of the dialog offers {} options and core takes {WIRE_OPTIONS_MAX}",
                q.options.len()
            ));
        }
        for o in &q.options {
            if let Some(said) = breaks("option label", len(&o.label), WIRE_LABEL_MAX, 1) {
                return Some(said);
            }
            if let Some(d) = &o.description {
                if let Some(said) = breaks("option description", len(d), WIRE_DESCRIPTION_MAX, 0) {
                    return Some(said);
                }
            }
        }
    }
    None
}

fn dialog_of(input: &Value) -> Asked {
    let Some(asked) = input["questions"].as_array().filter(|q| !q.is_empty()) else {
        return Asked::Unread(format!(
            "the pane's {DIALOG_TOOL} call carries no `questions` list this box could read"
        ));
    };
    let mut questions = Vec::with_capacity(asked.len());
    for q in asked {
        let Some(question) = q["question"].as_str() else {
            return Asked::Unread(format!(
                "a question in the pane's {DIALOG_TOOL} call carries no text this box could read"
            ));
        };
        let options = q["options"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|o| {
                Some(DialogOption {
                    label: o["label"].as_str()?.to_string(),
                    description: o["description"].as_str().map(str::to_string),
                })
            })
            .collect();
        questions.push(DialogQuestion {
            question: question.to_string(),
            header: q["header"].as_str().map(str::to_string),
            multi_select: q["multiSelect"].as_bool().unwrap_or(false),
            options,
        });
    }
    match outside_the_wire(&questions) {
        Some(said) => Asked::Unread(format!(
            "{said}, so the dialog could not be carried whole and is not carried cut"
        )),
        None => Asked::Dialog(questions),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_scratch::Scratch;

    const ASK_LINE: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"AskUserQuestion","input":{"questions":[{"question":"Push and finish unverified?","header":"Release","multiSelect":false,"options":[{"label":"Push + finish unverified","description":"ships now"},{"label":"Abort to gate"}]}]}}]}}"#;
    const HOOK_LINE: &str = r#"{"type":"attachment","attachment":{"type":"hook_success","hookName":"PreToolUse:AskUserQuestion","hookEvent":"PreToolUse","toolUseID":"toolu_1"}}"#;

    fn transcript(lines: &[&str]) -> (Scratch, String) {
        let dir = Scratch::new("job-asked");
        let path = dir.path().join("conv.jsonl");
        std::fs::write(&path, format!("{}\n", lines.join("\n"))).expect("write");
        let text = path.to_string_lossy().into_owned();
        (dir, text)
    }

    #[test]
    fn a_pending_dialog_is_read_whole_through_the_hook_records_after_it() {
        let (_d, path) = transcript(&[ASK_LINE, HOOK_LINE, HOOK_LINE]);
        assert_eq!(
            asked_by(Some(&path)),
            Asked::Dialog(vec![DialogQuestion {
                question: "Push and finish unverified?".into(),
                header: Some("Release".into()),
                multi_select: false,
                options: vec![
                    DialogOption {
                        label: "Push + finish unverified".into(),
                        description: Some("ships now".into()),
                    },
                    DialogOption {
                        label: "Abort to gate".into(),
                        description: None,
                    },
                ],
            }])
        );
    }

    #[test]
    fn the_dialog_wire_shape_omits_what_was_not_given() {
        let (_d, path) = transcript(&[ASK_LINE]);
        assert_eq!(
            asked_by(Some(&path)).to_json(),
            json!({"kind":"dialog","questions":[{
                "question":"Push and finish unverified?","header":"Release","multiSelect":false,
                "options":[{"label":"Push + finish unverified","description":"ships now"},{"label":"Abort to gate"}]
            }]})
        );
    }

    fn dialog_line(question: &str, label: &str) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"t1","name":"AskUserQuestion","input":{{"questions":[{{"question":"{question}","options":[{{"label":"{label}"}},{{"label":"No"}}]}}]}}}}]}}}}"#
        )
    }

    #[test]
    fn a_dialog_core_would_refuse_whole_is_sent_as_unread_naming_the_bound_it_broke() {
        let over = dialog_line(&"q".repeat(WIRE_QUESTION_MAX + 1), "Yes");
        let blank = dialog_line("Ship it?", "");
        let wide = dialog_line("Ship it?", &"l".repeat(WIRE_LABEL_MAX + 1));
        for (line, said) in [
            (
                over,
                "question 1 of the dialog has a text of 4001 characters",
            ),
            (blank, "option label of 0 characters"),
            (wide, "option label of 501 characters"),
        ] {
            let (_d, path) = transcript(&[&line]);
            let Asked::Unread(why) = asked_by(Some(&path)) else {
                panic!("a dialog outside core's bounds is never sent as it is");
            };
            assert!(why.contains(said), "{why}");
            assert!(why.contains("not carried cut"), "{why}");
            assert!(len(&why) <= WIRE_WHY_MAX, "{why}");
        }
    }

    #[test]
    fn a_dialog_at_core_s_bounds_is_carried_whole() {
        let line = dialog_line(&"q".repeat(WIRE_QUESTION_MAX), &"l".repeat(WIRE_LABEL_MAX));
        let (_d, path) = transcript(&[&line]);
        assert!(matches!(asked_by(Some(&path)), Asked::Dialog(_)));
    }

    #[test]
    fn bounds_are_counted_in_utf16_units_as_core_counts_them() {
        let wide = "😀".repeat(WIRE_QUESTION_MAX / 2 + 1);
        assert_eq!(wide.chars().count(), WIRE_QUESTION_MAX / 2 + 1);
        let line = dialog_line(&wide, "Yes");
        let (_d, path) = transcript(&[&line]);
        assert!(matches!(asked_by(Some(&path)), Asked::Unread(_)));
        assert_eq!(units("a😀b", 2), "a");
        assert_eq!(units("a😀b", 3), "a😀");
    }

    #[test]
    fn an_unread_reason_naming_a_long_path_still_fits_core() {
        let path = format!("/{}/conv.jsonl", "d".repeat(2000));
        let Asked::Unread(why) = asked_by(Some(&path)) else {
            panic!("a transcript that is not there is unread");
        };
        assert!(len(&why) <= WIRE_WHY_MAX);
        assert!(!why.is_empty());
    }

    #[test]
    fn a_pending_permission_prompt_carries_the_tool_and_a_cut_input() {
        let long = "x".repeat(5000);
        let line = format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"t9","name":"Bash","input":{{"command":"{long}"}}}}]}}}}"#
        );
        let (_d, path) = transcript(&[&line]);
        let json = asked_by(Some(&path)).to_json();
        assert_eq!(json["kind"], "permission");
        assert_eq!(json["tool"], "Bash");
        assert_eq!(json["input"].as_str().unwrap().chars().count(), INPUT_CUT);
    }

    #[test]
    fn what_could_not_be_read_is_unread_with_the_reason() {
        let none = asked_by(None).to_json();
        assert_eq!(none["kind"], "unread");
        assert!(none["why"].as_str().unwrap().contains("no transcript"));

        let missing = asked_by(Some("/no/such/forge-job-asked/conv.jsonl")).to_json();
        assert_eq!(missing["kind"], "unread");
        assert!(missing["why"]
            .as_str()
            .unwrap()
            .contains("could not be opened"));

        let answered = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}}"#;
        let (_d, path) = transcript(&[ASK_LINE, answered]);
        let json = asked_by(Some(&path)).to_json();
        assert_eq!(json["kind"], "unread");
        assert!(json["why"]
            .as_str()
            .unwrap()
            .contains("not a tool call awaiting"));
    }

    #[test]
    fn a_malformed_dialog_input_is_unread_naming_why() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"AskUserQuestion","input":{"questions":[{"options":[]}]}}]}}"#;
        let (_d, path) = transcript(&[line]);
        let json = asked_by(Some(&path)).to_json();
        assert_eq!(json["kind"], "unread");
        assert!(json["why"].as_str().unwrap().contains("no text"));
        let empty = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"AskUserQuestion","input":{}}]}}"#;
        let (_d2, path2) = transcript(&[empty]);
        assert_eq!(asked_by(Some(&path2)).to_json()["kind"], "unread");
    }

    #[test]
    fn a_dialog_with_no_optional_fields_reads_with_defaults() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"AskUserQuestion","input":{"questions":[{"question":"Which?","options":[{"label":"a"}]}]}}]}}"#;
        let (_d, path) = transcript(&[line]);
        assert_eq!(
            asked_by(Some(&path)).to_json(),
            json!({"kind":"dialog","questions":[{"question":"Which?","multiSelect":false,"options":[{"label":"a"}]}]})
        );
    }
}
