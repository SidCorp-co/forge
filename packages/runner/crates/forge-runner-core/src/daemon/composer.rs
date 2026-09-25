//! What a Claude Code pane's composer holds, read off `tmux capture-pane -e`.
//!
//! `terminal::send_line` types by pasting and then pressing Enter, and Enter
//! submits the whole composer — not only what was pasted. Whatever already sat
//! there unsent went out glued to the front of the caller's message, and
//! neither author could tell (ISS-1224). No keystroke clears that composer
//! safely: Ctrl-U clears only the cursor's line of a multi-line draft, and
//! Esc or Ctrl-C interrupt a turn that is working. So the pane is read first,
//! and a composer holding text is refused rather than cleared.
//!
//! The composer is drawn as a full-width `─` rule, a line opening with `❯`,
//! any continuation lines, and a closing rule, with only the footer below it.
//! An empty one shows a placeholder hint in dim (SGR 2), which is not text
//! anybody typed. A menu such as the folder-trust dialog also marks its
//! choice with `❯`, but never on the line straight under a rule.

/// How a capture reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Composer {
    /// A composer with nothing typed in it.
    Empty,
    /// A composer holding this unsent text.
    Holds(String),
    /// No composer in the shape above: a dialog, a menu, a pane still
    /// starting, or not Claude Code at all.
    Unrecognised,
}

const PROMPT: char = '\u{276f}';
const RULE: char = '\u{2500}';
const SHORTEST_RULE: usize = 8;

/// Read the last composer in `capture`, which is `capture-pane -p -e` output.
pub fn read(capture: &str) -> Composer {
    let lines = rendered(capture);
    let rules: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| is_rule(&l.all))
        .map(|(i, _)| i)
        .collect();
    let [.., open, close] = rules[..] else {
        return Composer::Unrecognised;
    };
    let body = &lines[open + 1..close];
    let Some(first) = body.first() else {
        return Composer::Unrecognised;
    };
    if !opens_with_prompt(&first.all) {
        return Composer::Unrecognised;
    }
    let mut typed: Vec<String> = Vec::with_capacity(body.len());
    typed.push(after_prompt(&first.visible).trim().to_string());
    typed.extend(body[1..].iter().map(|l| l.visible.trim().to_string()));
    let text = typed.join("\n").trim().to_string();
    if text.is_empty() {
        Composer::Empty
    } else {
        Composer::Holds(text)
    }
}

/// `text` on one line and at most `max` characters, for quoting in a refusal.
pub fn excerpt(text: &str, max: usize) -> String {
    let flat = text.lines().collect::<Vec<_>>().join(" \u{23ce} ");
    if flat.chars().count() <= max {
        return flat;
    }
    let cut: String = flat.chars().take(max).collect();
    format!("{cut}\u{2026}")
}

struct Line {
    /// Every character on the line, escapes removed.
    all: String,
    /// The characters not drawn dim.
    visible: String,
}

/// A rule starts at the left edge. Text typed into the composer never does:
/// its continuation lines are indented, so a line of `─` somebody typed is a
/// line of the draft and not a boundary.
fn is_rule(line: &str) -> bool {
    let t = line.trim_end();
    t.chars().count() >= SHORTEST_RULE && t.chars().all(|c| c == RULE)
}

fn opens_with_prompt(line: &str) -> bool {
    let mut chars = line.chars();
    chars.next() == Some(PROMPT) && matches!(chars.next(), None | Some(' ') | Some('\u{a0}'))
}

fn after_prompt(visible: &str) -> &str {
    let rest = visible.trim_start();
    let rest = rest.strip_prefix(PROMPT).unwrap_or(rest);
    rest.strip_prefix(['\u{a0}', ' ']).unwrap_or(rest)
}

/// Split a `-e` capture into lines, dropping escapes and tracking dim across
/// line ends the way the terminal does.
fn rendered(capture: &str) -> Vec<Line> {
    let mut dim = false;
    let mut out = Vec::new();
    for raw in capture.split('\n') {
        let mut line = Line {
            all: String::new(),
            visible: String::new(),
        };
        let mut chars = raw.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '\u{1b}' => match chars.next() {
                    Some('[') => {
                        let mut params = String::new();
                        let mut last = None;
                        for p in chars.by_ref() {
                            if ('\u{40}'..='\u{7e}').contains(&p) {
                                last = Some(p);
                                break;
                            }
                            params.push(p);
                        }
                        if last == Some('m') {
                            dim = sgr_dim(&params, dim);
                        }
                    }
                    Some(']') => {
                        while let Some(p) = chars.next() {
                            if p == '\u{7}' || (p == '\u{1b}' && chars.next_if_eq(&'\\').is_some())
                            {
                                break;
                            }
                        }
                    }
                    _ => {}
                },
                '\r' => {}
                c => {
                    line.all.push(c);
                    if !dim {
                        line.visible.push(c);
                    }
                }
            }
        }
        out.push(line);
    }
    out
}

/// Whether dim is on after one SGR sequence's parameters.
fn sgr_dim(params: &str, mut dim: bool) -> bool {
    if params.is_empty() {
        return false;
    }
    let codes: Vec<&str> = params.split([';', ':']).collect();
    let mut i = 0;
    while i < codes.len() {
        match codes[i] {
            "0" | "" | "22" => dim = false,
            "2" => dim = true,
            // An extended colour carries its own arguments, which are not codes.
            "38" | "48" | "58" => {
                i += match codes.get(i + 1) {
                    Some(&"5") => 2,
                    Some(&"2") => 4,
                    _ => 0,
                };
            }
            _ => {}
        }
        i += 1;
    }
    dim
}

#[cfg(test)]
mod tests {
    use super::*;

    const RULE_LINE: &str = "\u{1b}[38;5;244m\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}";
    const FOOTER: &str = "\u{1b}[39m  \u{1b}[36mOpus 5.5\u{1b}[38;5;246m \u{1b}[2m\u{2502}\u{1b}[0m\u{1b}[38;5;246m ~/p \u{1b}[2m\u{2502}\u{1b}[0m $0.00\u{1b}[39m\n  \u{1b}[38;5;211m\u{23f5}\u{23f5} bypass permissions on\u{1b}[39m";

    fn frame(body: &[&str]) -> String {
        let mut lines = vec!["\u{25cf} earlier output".to_string(), RULE_LINE.to_string()];
        lines.extend(body.iter().map(|b| format!("\u{1b}[39m{b}")));
        lines.push(RULE_LINE.to_string());
        lines.push(FOOTER.to_string());
        lines.join("\n")
    }

    #[test]
    fn an_empty_composer_reads_empty() {
        // Captured off a live master pane: the prompt glyph, a no-break space, nothing.
        assert_eq!(read(&frame(&["\u{276f}\u{a0}"])), Composer::Empty);
        assert_eq!(read(&frame(&["\u{276f}"])), Composer::Empty);
    }

    #[test]
    fn the_dim_placeholder_of_a_fresh_composer_is_not_text() {
        // Captured off a fresh Claude Code pane, 2026-09-25.
        let fresh = frame(&["\u{276f}\u{a0}\u{1b}[2mTry \"write a test for <filepath>\"\u{1b}[0m"]);
        assert_eq!(read(&fresh), Composer::Empty);
    }

    #[test]
    fn text_left_at_the_prompt_is_read_whole() {
        let one = frame(&["\u{276f}\u{a0}LEFTOVER-FROM-SOMEWHERE-ELSE"]);
        assert_eq!(
            read(&one),
            Composer::Holds("LEFTOVER-FROM-SOMEWHERE-ELSE".into())
        );
        let several = frame(&[
            "\u{276f}\u{a0}LEFTOVER-FROM-SOMEWHERE-ELSE line one",
            "  line two",
        ]);
        assert_eq!(
            read(&several),
            Composer::Holds("LEFTOVER-FROM-SOMEWHERE-ELSE line one\nline two".into())
        );
    }

    #[test]
    fn text_typed_after_a_dim_run_on_the_same_line_is_still_text() {
        let mixed = frame(&["\u{276f}\u{a0}\u{1b}[2mhint\u{1b}[22mtyped"]);
        assert_eq!(read(&mixed), Composer::Holds("typed".into()));
        let coloured = frame(&["\u{276f}\u{a0}\u{1b}[38;5;2mtyped\u{1b}[39m"]);
        assert_eq!(
            read(&coloured),
            Composer::Holds("typed".into()),
            "256-colour index 2 is a colour, not SGR 2"
        );
    }

    #[test]
    fn a_line_of_rule_characters_typed_into_the_draft_is_part_of_it() {
        let drawn = frame(&[
            "\u{276f}\u{a0}first",
            "  \u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}",
            "  last",
        ]);
        assert_eq!(
            read(&drawn),
            Composer::Holds(
                "first\n\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\nlast"
                    .into()
            )
        );
    }

    #[test]
    fn a_trust_dialog_marked_with_the_prompt_glyph_is_not_a_composer() {
        let dialog = [
            RULE_LINE,
            " Accessing workspace:",
            "",
            " Quick safety check: Is this a project you created or one you trust?",
            "",
            " \u{276f} No, exit",
            "   Yes, I trust this folder",
            "",
            " Enter to confirm \u{b7} Esc to cancel",
        ]
        .join("\n");
        assert_eq!(read(&dialog), Composer::Unrecognised);
    }

    #[test]
    fn a_dialog_drawn_below_an_older_composer_frame_hides_it() {
        let mut capture = frame(&["\u{276f}\u{a0}"]);
        capture.push('\n');
        capture.push_str(RULE_LINE);
        capture.push_str("\n Do you want to proceed?\n \u{276f} 1. Yes\n   2. No");
        assert_eq!(read(&capture), Composer::Unrecognised);
    }

    #[test]
    fn a_plain_shell_is_not_a_composer() {
        assert_eq!(read("$ \n$ echo hi\nhi\n$ "), Composer::Unrecognised);
        assert_eq!(read(""), Composer::Unrecognised);
    }

    #[test]
    fn the_last_composer_in_the_capture_is_the_one_read() {
        let mut capture = frame(&["\u{276f}\u{a0}stale draft from scrollback"]);
        capture.push('\n');
        capture.push_str(&frame(&["\u{276f}\u{a0}"]));
        assert_eq!(read(&capture), Composer::Empty);
    }

    #[test]
    fn an_excerpt_is_one_line_and_bounded() {
        assert_eq!(excerpt("a\nb", 40), "a \u{23ce} b");
        assert_eq!(excerpt("abcdef", 3), "abc\u{2026}");
    }
}
