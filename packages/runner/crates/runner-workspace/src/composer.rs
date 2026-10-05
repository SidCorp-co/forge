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
//! anybody typed.
//!
//! A menu marks its highlighted choice with the same `❯`, and Enter there
//! decides that choice rather than sending anything — the folder-trust dialog
//! took *No, exit* from a routine `say` and the master died with it, and a
//! tool-permission dialog took *1. Yes* (ISS-1266). So a menu is a reading of
//! its own, told from the rest by two marks at once: Claude Code indents it
//! inside the dialog body, while a composer's prompt, a shell's, and the
//! transcript's echo of a message already sent all sit at column zero; and the
//! nearest line either side of it that is not blank starts its text at the
//! column its own text starts at, which a prompt with output above it does not.

/// How a capture reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Composer {
    /// A composer with nothing typed in it.
    Empty,
    /// A composer holding this unsent text.
    Holds(String),
    /// A choice list, and the option its marker highlights. Enter here is a
    /// decision on that option, so nothing typed at it becomes a message.
    Menu { highlighted: String },
    /// Neither of the shapes above: a pane still starting, a dialog offering
    /// no choice, or not Claude Code at all.
    Unrecognised,
}

const PROMPT: char = '\u{276f}';
const RULE: char = '\u{2500}';
const SHORTEST_RULE: usize = 8;

/// The marker and the one space after it, before an option's own text.
const MARKER_WIDTH: usize = 2;

/// Read the last element drawn in `capture`, which is `capture-pane -p -e`
/// output.
///
/// The composer frame and a choice list can both be in one capture — a menu
/// raised over an old frame, a composer redrawn under a menu that has gone.
/// tmux draws the live one last, so the lower of the two is the one this
/// answers with.
pub fn read(capture: &str) -> Composer {
    let lines = rendered(capture);
    match (framed(&lines), choice(&lines)) {
        (Some((close, seen)), Some((at, _))) if at < close => seen,
        (_, Some((_, highlighted))) => Composer::Menu { highlighted },
        (Some((_, seen)), None) => seen,
        (None, None) => Composer::Unrecognised,
    }
}

/// The composer frame's closing rule and what it holds, or `None` where the
/// capture draws no frame in that shape.
fn framed(lines: &[Line]) -> Option<(usize, Composer)> {
    let rules: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| is_rule(&l.all))
        .map(|(i, _)| i)
        .collect();
    let [.., open, close] = rules[..] else {
        return None;
    };
    let body = &lines[open + 1..close];
    let first = body.first()?;
    if !opens_with_prompt(&first.all) {
        return None;
    }
    let mut typed: Vec<String> = Vec::with_capacity(body.len());
    typed.push(after_prompt(&first.visible).trim().to_string());
    typed.extend(body[1..].iter().map(|l| l.visible.trim().to_string()));
    let text = typed.join("\n").trim().to_string();
    Some((
        close,
        if text.is_empty() {
            Composer::Empty
        } else {
            Composer::Holds(text)
        },
    ))
}

/// The lowest choice-list marker and the option it highlights.
///
/// Two marks have to hold together, because each one alone names something
/// else as well. The glyph is drawn at column one or further right: Claude
/// Code indents a menu inside the dialog body, while a composer's prompt, a
/// shell's, and the transcript's echo of a message already sent all sit at
/// column zero. And the nearest line either side of it that is not blank starts
/// its own text at the column this line's text starts at, which is what makes
/// the line one of a list rather than a prompt with something indented above
/// it. A blank line carries no column at all, so the search steps over it
/// rather than scoring it as a column that differs: Claude Code parts the
/// Rewind picker's rows with blank lines and draws its highlighted row alone
/// between two, and reading those as a mismatch dropped the marker and let
/// `say` press Enter at the picker (ISS-1272).
///
/// Neither mark survives being quoted, so a marker inside a message already
/// sent is excluded as well: the transcript indents the body of an echo, and
/// a menu somebody described in one is drawn with both marks and decides
/// nothing.
fn choice(lines: &[Line]) -> Option<(usize, String)> {
    (0..lines.len()).rev().find_map(|i| {
        let at = marker(&lines[i].all).filter(|at| *at > 0)?;
        let text = at + MARKER_WIDTH;
        let above = (0..i).rev().find_map(|j| indent(&lines[j].all));
        let below = (i + 1..lines.len()).find_map(|j| indent(&lines[j].all));
        if (above != Some(text) && below != Some(text)) || echoed(lines, i) {
            return None;
        }
        Some((i, after_prompt(&lines[i].all).trim().to_string()))
    })
}

/// Whether the line at `i` is inside the transcript's echo of a message
/// already sent.
///
/// An echo opens with the marker at column zero and everything under it is
/// indented, blank lines included, until the next thing drawn at column zero.
/// Every dialog Claude Code raises is drawn in a box whose own border starts
/// at column zero, so the nearest column-zero line above a real menu is that
/// border and never an echo's opening line.
fn echoed(lines: &[Line], i: usize) -> bool {
    (0..i)
        .rev()
        .filter_map(|j| indent(&lines[j].all).map(|at| (j, at)))
        .find(|(_, at)| *at == 0)
        .is_some_and(|(j, _)| marker(&lines[j].all) == Some(0))
}

/// The column a line's own text starts at, or `None` for a blank line.
fn indent(line: &str) -> Option<usize> {
    line.trim_end().chars().position(|c| c != ' ')
}

/// The column of a marker drawn with an option after it, or `None`.
fn marker(line: &str) -> Option<usize> {
    let at = indent(line)?;
    let mut rest = line.chars().skip(at);
    if rest.next() != Some(PROMPT) {
        return None;
    }
    matches!(rest.next(), Some(' ') | Some('\u{a0}')).then_some(at)
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
