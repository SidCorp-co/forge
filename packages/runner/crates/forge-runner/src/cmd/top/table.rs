//! The first screen: one row per project and one for the box, in fixed columns
//! built to the screen's width, so a row never wraps and its verdict is never
//! cut.
//!
//! A cell carries a reading and nothing else: what it was read from is on the
//! row's source line, which `s` shows, and in the row's detail. A cell whose
//! source could not be read is `?`, and a cell read as nothing is `·`.

use unicode_width::UnicodeWidthChar;

use super::attention::{self, Assessment, PaneCell, Tone};
use super::fit::{cells, printable, wrap};
use super::gather::{CoreAnswer, Project, Snapshot};
use super::lanes::{self, Counts};
use super::ledger_ro::Run;
use super::people::lanes_route;
use super::render;
use super::source::{ago, span, Read, Unreadable};

/// One row of the screen, before colour.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub text: String,
    pub tone: Tone,
    /// The table row this line belongs to (0 is the box), where it belongs to one.
    pub owner: Option<usize>,
    /// The row a selection stands on, drawn reversed.
    pub selected: bool,
    pub bold: bool,
    /// The row's own line, rather than a run or source line under it.
    pub row: bool,
}

impl Line {
    fn plain(text: String, tone: Tone) -> Self {
        Self {
            text,
            tone,
            owner: None,
            selected: false,
            bold: false,
            row: false,
        }
    }
}

/// What the keys row says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeysSaid {
    Read,
    Unread(String),
}

pub struct Opts {
    pub cols: usize,
    pub selected: usize,
    pub sources: bool,
    pub keys: KeysSaid,
    pub interval: Option<u64>,
}

/// The screen above, within and below the scrolling rows.
pub struct Table {
    pub head: Vec<Line>,
    pub body: Vec<Line>,
    pub foot: Vec<Line>,
}

/// How many selectable rows the table has: the box and every project.
pub fn rows(s: &Snapshot) -> usize {
    1 + s.projects.len()
}

/// The widest verdict word a finding or row says: the column is this wide,
/// so no verdict is ever cut.
pub const VERDICT_W: usize = 7;
const ATT_W: usize = 3;
const PANE_W: usize = 5;
const RUNS_W: usize = 4;
const LANE_W: usize = 4;
/// Every cell but the name, NOW and CHANGE, and the spaces between cells.
const FIXED: usize =
    1 + ATT_W + 1 + 1 + PANE_W + 1 + RUNS_W + 5 * (1 + LANE_W) + 1 + VERDICT_W + 1 + 1;

struct Widths {
    name: usize,
    now: usize,
    change: usize,
}

/// A row's cells before they are laid out.
struct Cells {
    att: String,
    name: String,
    pane: String,
    runs: String,
    lanes: [String; 5],
    verdict: &'static str,
    now: String,
    change: String,
    tone: Tone,
}

pub fn build(s: &Snapshot, o: &Opts) -> Table {
    let boxed = box_cells(s);
    let rows: Vec<(Cells, Assessment)> = s.projects.iter().map(|p| project_cells(s, p)).collect();
    let w = widths(
        o.cols,
        std::iter::once(&boxed.0).chain(rows.iter().map(|(c, _)| c)),
    );

    let mut head = vec![Line {
        bold: true,
        ..Line::plain(fit(&render::header(o.interval), o.cols), Tone::Plain)
    }];
    head.push(Line {
        bold: true,
        ..Line::plain(fit(&heading(&w), o.cols), Tone::Plain)
    });

    let mut body = Vec::new();
    let mut push_row = |i: usize, c: &Cells, extra: Vec<Line>, sources: String| {
        body.push(Line {
            text: fit(&laid_out(c, &w, i == o.selected), o.cols),
            tone: c.tone,
            owner: Some(i),
            selected: i == o.selected,
            bold: false,
            row: true,
        });
        for mut l in extra {
            l.owner = Some(i);
            body.push(l);
        }
        if o.sources {
            for r in wrap(&format!("      {sources}"), o.cols) {
                body.push(Line {
                    owner: Some(i),
                    ..Line::plain(r, Tone::Dim)
                });
            }
        }
    };
    push_row(
        0,
        &boxed.0,
        stray_lines(s, o.cols),
        box_sources(s, &boxed.1),
    );
    for (i, (p, (c, a))) in s.projects.iter().zip(&rows).enumerate() {
        push_row(i + 1, c, run_lines(s, p, o.cols), project_sources(s, p, a));
    }

    let mut foot = Vec::new();
    for r in wrap(&legend(), o.cols) {
        foot.push(Line::plain(r, Tone::Dim));
    }
    let keys = match &o.keys {
        KeysSaid::Read => "↑↓ or j k select · Enter opens the selected row's detail · s shows each row's sources · q quits".to_string(),
        KeysSaid::Unread(why) => format!(
            "keys are not read ({why}), so no row can be opened; the table redraws{}",
            o.interval.map(|n| format!(" every {n}s")).unwrap_or_default()
        ),
    };
    for r in wrap(&keys, o.cols) {
        foot.push(Line::plain(r, Tone::Plain));
    }
    let attention_total = boxed.1.count() + rows.iter().map(|(_, a)| a.count()).sum::<usize>();
    for r in wrap(&footer(s, attention_total), o.cols) {
        foot.push(Line::plain(r, Tone::Plain));
    }
    Table { head, body, foot }
}

fn widths<'a>(cols: usize, all: impl Iterator<Item = &'a Cells> + Clone) -> Widths {
    let avail = cols.saturating_sub(FIXED);
    let longest = |f: fn(&Cells) -> &str, least: usize| {
        all.clone()
            .map(|c| cells(f(c)))
            .max()
            .unwrap_or(0)
            .max(least)
    };
    let name = longest(|c| &c.name, "PROJECT".len())
        .min(24)
        .min((avail / 3).max(8));
    let change = longest(|c| &c.change, "CHANGE".len()).min((avail / 4).max(6));
    Widths {
        name,
        change,
        now: avail.saturating_sub(name + change),
    }
}

fn heading(w: &Widths) -> String {
    let names: Vec<String> = lanes::LANES
        .iter()
        .map(|(n, _)| pad(n, LANE_W, true))
        .collect();
    format!(
        " {} {} {} {} {} {} {} {}",
        pad("!", ATT_W, true),
        pad("PROJECT", w.name, false),
        pad("PANE", PANE_W, false),
        pad("RUNS", RUNS_W, true),
        names.join(" "),
        pad("VERDICT", VERDICT_W, false),
        pad("NOW", w.now, false),
        pad("CHANGE", w.change, false),
    )
}

fn laid_out(c: &Cells, w: &Widths, selected: bool) -> String {
    let lanes: Vec<String> = c.lanes.iter().map(|l| pad(l, LANE_W, true)).collect();
    format!(
        "{}{} {} {} {} {} {} {} {}",
        if selected { ">" } else { " " },
        pad(&c.att, ATT_W, true),
        pad(&c.name, w.name, false),
        pad(&c.pane, PANE_W, false),
        pad(&c.runs, RUNS_W, true),
        lanes.join(" "),
        pad(c.verdict, VERDICT_W, false),
        pad(&c.now, w.now, false),
        pad(&c.change, w.change, false),
    )
}

fn count(n: usize) -> String {
    if n == 0 {
        "·".into()
    } else {
        n.to_string()
    }
}

fn att_cell(a: &Assessment) -> String {
    match (a.count(), a.any_unread()) {
        (0, true) => "?".into(),
        (n, _) => count(n),
    }
}

/// The project's lane counts, or why there are none.
pub fn lanes_of<'a>(s: &'a Snapshot, p: &Project) -> Read<&'a Counts> {
    let (_, all) = s.core.as_ref().map_err(Clone::clone)?;
    let core = render::core_of(p, all).map_err(|why| Unreadable::new("core", why))?;
    core.lanes.as_ref().map_err(Clone::clone)
}

/// The same project's lanes in core's previous reading, where there is one.
fn lanes_before<'a>(before: &'a Option<CoreAnswer>, p: &Project) -> Option<&'a Counts> {
    let (_, all) = before.as_ref()?.as_ref().ok()?;
    render::core_of(p, all).ok()?.lanes.as_ref().ok()
}

fn project_cells(s: &Snapshot, p: &Project) -> (Cells, Assessment) {
    let a = attention::project(s, p);
    let runs = attention::runs_of(s, p);
    let parked = attention::parked_of(s, p);
    let pane = attention::pane(s, p);
    let now_lanes = lanes_of(s, p);
    let lanes = match &now_lanes {
        Ok(c) => lanes::sums(c).map(|n| count(n as usize)),
        Err(_) => std::array::from_fn(|_| "?".to_string()),
    };
    let moving = now_lanes.as_ref().map(|c| lanes::sums(c)[0]).unwrap_or(0);
    let idle = runs.is_empty() && parked.is_empty() && moving == 0 && now_lanes.is_ok();
    let now = match (&s.ledger, runs.as_slice(), parked.as_slice()) {
        (Err(_), _, _) => "?".to_string(),
        (_, [one], _) => format!("{} {}", one.held_keys().join(","), short_wrote(s, one)),
        (_, [_, _, ..], _) => format!(
            "{} runs: {}",
            runs.len(),
            runs.iter()
                .map(|r| r.held_keys().join(","))
                .collect::<Vec<_>>()
                .join(" ")
        ),
        (_, [], [first, ..]) => format!(
            "{} parked on a person",
            first
                .issues
                .iter()
                .map(|(k, _)| k.as_str())
                .collect::<Vec<_>>()
                .join(",")
        ),
        (_, [], []) => match pane {
            PaneCell::Up { started_ms } => format!("master up {}", span(s.now_ms - started_ms)),
            _ => "—".into(),
        },
    };
    let change = match (&now_lanes, lanes_before(&s.core_before, p)) {
        (Err(_), _) => "?".into(),
        (Ok(_), None) => "—".into(),
        (Ok(n), Some(b)) => lanes::change(b, n),
    };
    let runs_cell = match &s.ledger {
        Err(_) => "?".into(),
        Ok(_) => count(runs.len()),
    };
    let cells = Cells {
        att: att_cell(&a),
        name: printable(&p.key),
        pane: pane.cell().into(),
        runs: runs_cell,
        lanes,
        verdict: a.verdict(idle),
        now,
        change,
        tone: a.tone(idle),
    };
    (cells, a)
}

fn short_wrote(s: &Snapshot, r: &Run) -> String {
    match attention::quiet(s, r) {
        attention::Quiet::For(ms) => format!("wrote {} ago", span(ms)),
        attention::Quiet::Partial {
            seen_ms: Some(ms), ..
        } => format!("wrote {} ago (partial walk)", span(ms)),
        attention::Quiet::Partial { seen_ms: None, .. } => "no file read (partial walk)".into(),
        attention::Quiet::Gone => "worktree gone".into(),
        attention::Quiet::NoAge => "no write seen".into(),
        attention::Quiet::Unread(_) => "worktree ?".into(),
    }
}

fn box_cells(s: &Snapshot) -> (Cells, Assessment) {
    let a = attention::boxwide(s);
    let panes: Vec<PaneCell> = s.projects.iter().map(|p| attention::pane(s, p)).collect();
    let pane = if s.sessions.is_err() {
        "?".to_string()
    } else {
        let up = panes
            .iter()
            .filter(|p| matches!(p, PaneCell::Up { .. }))
            .count();
        let named = panes
            .iter()
            .filter(|p| matches!(p, PaneCell::Up { .. } | PaneCell::Down { .. }))
            .count();
        format!("{up}/{named}")
    };
    let runs = match &s.ledger {
        Err(_) => "?".to_string(),
        Ok(v) => count(v.runs.iter().filter(|r| !r.held_keys().is_empty()).count()),
    };
    let reads: Vec<Read<Counts>> = s.projects.iter().map(|p| lanes_of(s, p).cloned()).collect();
    let summed = lanes::summed(&reads);
    let lanes = summed.map(|l| {
        if l.read > 0 && l.unread == 0 && l.sum == 0 {
            "·".into()
        } else {
            l.cell()
        }
    });
    let change = if s.core.is_err() {
        "?".to_string()
    } else {
        let pairs: Vec<(Counts, Counts)> = s
            .projects
            .iter()
            .filter_map(|p| {
                let now = lanes_of(s, p).ok()?;
                Some((lanes_before(&s.core_before, p)?.clone(), now.clone()))
            })
            .collect();
        if pairs.is_empty() {
            "—".into()
        } else {
            let (b, n) = lanes::added(pairs);
            lanes::change(&b, &n)
        }
    };
    let now = match (a.worst(), s.daemon_pid) {
        (Some(f), _) => f.text.clone(),
        (None, Some(pid)) => format!("daemon pid {pid}"),
        (None, None) => "—".into(),
    };
    let cells = Cells {
        att: att_cell(&a),
        name: "(box)".into(),
        pane,
        runs,
        lanes,
        verdict: a.verdict(false),
        now: printable(&now),
        change,
        tone: a.tone(false),
    };
    (cells, a)
}

/// One line under a project for each run holding a lease, and each parked on a person.
fn run_lines(s: &Snapshot, p: &Project, cols: usize) -> Vec<Line> {
    let mut out = Vec::new();
    let held = attention::runs_of(s, p);
    for r in &held {
        out.push(run_line(s, r, cols));
    }
    // A parked run still holding its lease has its line above.
    for r in attention::parked_of(s, p)
        .into_iter()
        .filter(|r| !held.iter().any(|h| h.run_id == r.run_id))
    {
        let keys: Vec<&str> = r.issues.iter().map(|(k, _)| k.as_str()).collect();
        out.push(Line::plain(
            fit(
                &format!(
                    "     ▶ {} parked on a person, waiting on {} · opened {}",
                    keys.join(","),
                    r.waiting_on
                        .as_deref()
                        .unwrap_or("an answer it did not record"),
                    ago(s.now_ms, r.created_at * 1000)
                ),
                cols,
            ),
            Tone::Red,
        ));
    }
    out
}

fn run_line(s: &Snapshot, r: &Run, cols: usize) -> Line {
    let parked = if r.parked_on_a_person() {
        format!(
            " · parked on a person, waiting on {}",
            r.waiting_on
                .as_deref()
                .unwrap_or("an answer it did not record")
        )
    } else {
        String::new()
    };
    Line::plain(
        fit(
            &format!(
                "     ▶ {} {} · {} · opened {}{parked}",
                r.held_keys().join(","),
                r.work,
                attention::wrote(s, r),
                ago(s.now_ms, r.created_at * 1000)
            ),
            cols,
        ),
        if r.parked_on_a_person() {
            Tone::Red
        } else {
            attention::run_tone(s, r)
        },
    )
}

/// Runs naming no project this box knows, under the box's row.
fn stray_lines(s: &Snapshot, cols: usize) -> Vec<Line> {
    render::runs_by_project(s)
        .remove("")
        .unwrap_or_default()
        .into_iter()
        .map(|r| run_line(s, r, cols))
        .collect()
}

fn dedup(all: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for one in all {
        if !out.contains(&one) {
            out.push(one);
        }
    }
    out
}

fn project_sources(s: &Snapshot, p: &Project, a: &Assessment) -> String {
    let ledger = match &s.ledger {
        Ok(v) => format!("{} runs", v.path.display()),
        Err(e) => e.to_string(),
    };
    let core_read = match &s.core {
        Ok((at, _)) => render::read_ago(s.now_ms, *at),
        Err(_) => String::new(),
    };
    let lanes = match p.project_id.as_deref() {
        Some(id) => format!("GET {}{core_read}", lanes_route(id)),
        None => "not asked: the binding names no project id".into(),
    };
    let before = match &s.core_before {
        Some(Ok((at, _))) => format!("core's reading of {}", ago(s.now_ms, *at)),
        Some(Err(_)) | None => "no earlier reading of core".into(),
    };
    let mut parts = vec![
        "← PANE tmux list-sessions".to_string(),
        format!("RUNS {ledger}, each worktree's newest file"),
        format!("lanes {lanes}"),
        format!("CHANGE against {before}"),
    ];
    let why = dedup(a.findings.iter().map(|f| f.source.clone()));
    if !why.is_empty() {
        parts.push(format!("! {}", why.join("; ")));
    }
    parts.join(" · ")
}

fn box_sources(s: &Snapshot, a: &Assessment) -> String {
    let ledger = match &s.ledger {
        Ok(v) => format!("{} runs", v.path.display()),
        Err(e) => e.to_string(),
    };
    let mut parts = vec![
        "← PANE the projects' master panes in tmux list-sessions".to_string(),
        format!("RUNS {ledger}"),
        "lanes the projects' rows below, summed".to_string(),
    ];
    let why = dedup(a.findings.iter().map(|f| f.source.clone()));
    if !why.is_empty() {
        parts.push(format!("! {}", why.join("; ")));
    }
    parts.join(" · ")
}

fn legend() -> String {
    let lanes: Vec<String> = lanes::LANES
        .iter()
        .map(|(n, statuses)| format!("{n} {}", statuses.join(" ")))
        .collect();
    format!(
        "! wanting attention · PANE master pane · RUNS holding a lease · {} · CHANGE since core's previous reading · ? could not be read · · none",
        lanes.join(" · ")
    )
}

fn footer(s: &Snapshot, attention_total: usize) -> String {
    let panes: Vec<PaneCell> = s.projects.iter().map(|p| attention::pane(s, p)).collect();
    let up = panes
        .iter()
        .filter(|p| matches!(p, PaneCell::Up { .. }))
        .count();
    let named = panes
        .iter()
        .filter(|p| matches!(p, PaneCell::Up { .. } | PaneCell::Down { .. }))
        .count();
    let panes = if s.sessions.is_err() {
        "master panes ?".to_string()
    } else {
        format!("{up} of {named} master pane(s) up")
    };
    let runs = match &s.ledger {
        Ok(v) => format!(
            "{} run(s) holding a lease",
            v.runs.iter().filter(|r| !r.held_keys().is_empty()).count()
        ),
        Err(_) => "runs ?".into(),
    };
    let (mut live, mut unread) = (0u64, 0usize);
    for p in &s.projects {
        match lanes_of(s, p) {
            Ok(c) => live += lanes::live(c),
            Err(_) => unread += 1,
        }
    }
    let live = match unread {
        0 => format!("{live} issue(s) live"),
        n => format!("{live} issue(s) live in the projects read, {n} not read"),
    };
    format!("{panes} · {runs} · {live} · {attention_total} thing(s) wanting attention — the ! column says whose")
}

/// `s` in exactly `w` cells: padded, or cut with `…` where it is longer.
pub fn pad(s: &str, w: usize, right: bool) -> String {
    let s = elide(s, w);
    let gap = " ".repeat(w.saturating_sub(cells(&s)));
    if right {
        format!("{gap}{s}")
    } else {
        format!("{s}{gap}")
    }
}

/// `s` cut to `w` cells, ending `…` where anything was cut.
pub fn elide(s: &str, w: usize) -> String {
    if cells(s) <= w {
        return s.to_string();
    }
    if w == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in s.chars() {
        let cw = UnicodeWidthChar::width(c).unwrap_or(0);
        if used + cw > w - 1 {
            break;
        }
        used += cw;
        out.push(c);
    }
    out.push('…');
    out
}

/// A row no wider than the screen, trailing spaces dropped.
fn fit(s: &str, cols: usize) -> String {
    elide(&printable(s), cols).trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd::top::people::ProjectCore;
    use crate::cmd::top::render::tests::{a_fine_box, row, snap, NOW};
    use std::collections::BTreeMap;

    fn opts(cols: usize) -> Opts {
        Opts {
            cols,
            selected: 0,
            sources: false,
            keys: KeysSaid::Read,
            interval: Some(5),
        }
    }

    fn all(t: &Table) -> Vec<&Line> {
        t.head.iter().chain(&t.body).chain(&t.foot).collect()
    }

    /// A box of many projects with long names, every lane in the hundreds, a
    /// long change and a run with a long path: the widest the cells get.
    fn a_crowded_box() -> Snapshot {
        let mut s = a_fine_box(true);
        s.daemon_pid = Some(4242);
        let mut before = BTreeMap::new();
        for i in 0..11 {
            let id = format!("id-{i}");
            let mut p = row(&format!("a-project-with-a-long-name-{i}"), &id, "/repo/x");
            p.skill = None;
            s.projects.push(p);
            let counts: Counts = lanes::LABELS
                .iter()
                .map(|(k, _)| (k.to_string(), 100 + i))
                .collect();
            let prev: Counts = lanes::LABELS
                .iter()
                .map(|(k, _)| (k.to_string(), 90))
                .collect();
            let core = |c: Counts| ProjectCore {
                questions: Ok(crate::cmd::top::people::Questions {
                    total: 0,
                    listed: vec![],
                }),
                awaiting: Ok(crate::cmd::top::people::AwaitingRelease {
                    total: 0,
                    keys: vec![],
                    blockers: Ok(vec![]),
                }),
                lanes: Ok(c),
            };
            if let Ok((_, all)) = &mut s.core {
                all.insert(id.clone(), core(counts));
            }
            before.insert(id, core(prev));
        }
        s.core_before = Some(Ok((NOW - 60_000, before)));
        s
    }

    /// Criteria 7 and 8: at 80 and at 170 columns no row is wider than the
    /// screen, and every row's verdict is whole in its column.
    #[test]
    fn no_row_is_wider_than_the_screen_and_every_verdict_is_whole() {
        for s in [
            a_fine_box(true),
            a_fine_box(false),
            a_crowded_box(),
            snap(vec![row("alpha", "id-a", "/r")]),
        ] {
            for cols in [80, 120, 170] {
                for sources in [false, true] {
                    let t = build(
                        &s,
                        &Opts {
                            sources,
                            ..opts(cols)
                        },
                    );
                    for l in all(&t) {
                        assert!(
                            cells(&l.text) <= cols,
                            "{cols}: {} cells: {}",
                            cells(&l.text),
                            l.text
                        );
                    }
                    let verdict_at =
                        cells(&t.head[1].text[..t.head[1].text.find("VERDICT").unwrap()]);
                    for (i, l) in t.body.iter().filter(|l| l.row).enumerate() {
                        let rest: String = l.text.chars().skip(verdict_at).collect();
                        let word = rest.split_whitespace().next().unwrap_or("");
                        assert!(
                            [
                                "idle", "ok", "?", "STALL", "ASKS", "DRIFT", "ORPHAN", "NOPATH",
                                "AGEING", "DOWN", "WAITS", "DAEMON", "GATE"
                            ]
                            .contains(&word),
                            "{cols}, row {i}: verdict {word:?} in {:?}",
                            l.text
                        );
                    }
                }
            }
        }
    }

    /// The planted failure for the rule above: with the verdict column one
    /// cell narrower than its widest word, the check sees a cut word.
    #[test]
    fn a_verdict_column_too_narrow_would_cut_a_word() {
        assert_eq!(pad("ORPHAN", VERDICT_W - 2, false), "ORPH…");
        assert!(VERDICT_W >= "VERDICT".len() && "NOPATH".len() < VERDICT_W);
    }

    /// Criteria 1 and 2: header, heading, the box, then each project in
    /// the frame's order, each with its cells.
    #[test]
    fn the_table_opens_on_the_box_then_every_project_in_order() {
        let s = a_fine_box(true);
        let t = build(&s, &opts(170));
        assert!(t.head[0].text.starts_with("forge-runner top —"));
        for col in [
            "!", "PROJECT", "PANE", "RUNS", "MOV", "HAND", "QUE", "BLK", "DRF", "VERDICT", "NOW",
            "CHANGE",
        ] {
            assert!(t.head[1].text.contains(col), "{col}: {}", t.head[1].text);
        }
        let rows: Vec<&Line> = t.body.iter().filter(|l| l.row).collect();
        assert!(rows[0].text.contains("(box)"), "{}", rows[0].text);
        assert!(rows[0].text.starts_with('>'), "the box is selected first");
        assert!(
            rows[1].text.contains("alpha") && rows[2].text.contains("beta"),
            "{rows:#?}"
        );
        // alpha: 4 wanting attention, pane up, 2 runs holding a lease (live
        // and orphan; unwalked too), lanes MOV 1 QUE 2 DRF 1, verdict ASKS.
        let a = &rows[1].text;
        let words: Vec<&str> = a.split_whitespace().collect();
        assert_eq!(
            &words[..10],
            &["4", "alpha", "up", "3", "1", "·", "2", "·", "1", "ASKS"],
            "{a}"
        );
        assert!(a.contains("3 runs: ISS-1 ISS-1 ISS-1"), "{a}");
        assert!(a.ends_with('—'), "no earlier reading: {a}");
        let b = &rows[2].text;
        let words: Vec<&str> = b.split_whitespace().collect();
        assert_eq!(
            &words[..10],
            &["·", "beta", "none", "·", "·", "·", "·", "·", "·", "idle"],
            "{b}"
        );
        assert_eq!(rows[2].tone, Tone::Dim);
        assert_eq!(rows[1].tone, Tone::Red);
    }

    /// Criterion 11: each run holding a lease is a line under its project's
    /// row, with its keys, work state, newest write and age.
    #[test]
    fn each_run_holding_a_lease_is_a_line_under_its_project() {
        let s = a_fine_box(true);
        let t = build(&s, &opts(170));
        let lines: Vec<&Line> = t
            .body
            .iter()
            .filter(|l| l.owner == Some(1) && l.text.starts_with("     ▶"))
            .collect();
        assert_eq!(lines.len(), 4, "3 held and 1 parked: {lines:#?}");
        assert!(
            lines[0]
                .text
                .contains("ISS-1 runnable · wrote 1m ago src/lib.rs · opened"),
            "{}",
            lines[0].text
        );
        assert!(
            lines[1].text.contains("not walked yet"),
            "{}",
            lines[1].text
        );
        assert!(
            lines[3]
                .text
                .contains("ISS-4 parked on a person, waiting on the owner"),
            "{}",
            lines[3].text
        );
    }

    /// Criteria 4 and 5: CHANGE against core's previous reading, blank where
    /// nothing moved, `—` without an earlier reading, `?` when unread; and
    /// the box sums every project's moves.
    #[test]
    fn change_is_against_the_previous_reading_of_core() {
        let s = a_crowded_box();
        let t = build(&s, &opts(170));
        // The box, alpha, beta, then the eleven planted from index 3.
        let change = |t: &Table, i: usize| {
            let at = cells(&t.head[1].text[..t.head[1].text.find("CHANGE").unwrap()]);
            let row = &t.body.iter().filter(|l| l.row).nth(i).unwrap().text;
            row.chars().skip(at).collect::<String>().trim().to_string()
        };
        let r3 = change(&t, 6);
        assert!(
            r3.starts_with("prog+13 test+13 rlsg+13") && r3.ends_with('…'),
            "{r3}"
        );
        assert_eq!(change(&t, 1), "—", "alpha had no earlier reading");
        assert!(
            change(&t, 0).starts_with("prog+"),
            "the box sums the moves: {}",
            change(&t, 0)
        );
        let mut s = a_crowded_box();
        let same = s.core.clone().unwrap();
        s.core_before = Some(Ok(same));
        let t = build(&s, &opts(170));
        assert_eq!(change(&t, 6), "", "nothing moved is blank");
        let mut s = a_crowded_box();
        s.core = Err(Unreadable::new("core", "503"));
        let t = build(&s, &opts(170));
        assert_eq!(change(&t, 6), "?");
        assert_eq!(change(&t, 0), "?");
    }

    /// Criterion 8, on the box row and on every cell of a project nothing
    /// could be read for.
    #[test]
    fn an_unread_cell_is_a_question_mark_never_zero() {
        let mut s = snap(vec![row("alpha", "id-a", "/repo/a")]);
        s.daemon_pid = Some(1);
        let t = build(&s, &opts(120));
        for l in t.body.iter().filter(|l| l.row) {
            let words: Vec<&str> = l.text.split_whitespace().collect();
            let from = if l.text.starts_with('>') { 1 } else { 0 };
            // `!` · name · PANE · RUNS · five lanes · VERDICT · NOW · CHANGE
            let cells = &words[from..];
            assert_eq!(cells[0], "?", "{}", l.text);
            assert_eq!(&cells[2..9], &["?"; 7], "{}", l.text);
            assert_eq!(cells[9], "?", "{}", l.text);
            assert!(!l.text.contains(" 0 "), "{}", l.text);
        }
    }

    /// Criterion 24: sources are on a line under each row with `s`, and no
    /// row carries a `←` without it.
    #[test]
    fn sources_are_one_toggle_away() {
        let s = a_fine_box(true);
        let off = build(&s, &opts(170));
        assert!(off.body.iter().all(|l| !l.text.contains('←')));
        let on = build(
            &s,
            &Opts {
                sources: true,
                ..opts(170)
            },
        );
        let alpha: String = on
            .body
            .iter()
            .filter(|l| l.owner == Some(1) && l.tone == Tone::Dim)
            .map(|l| l.text.trim())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(alpha.starts_with("← PANE tmux list-sessions"), "{alpha}");
        assert!(
            alpha
                .contains("GET /api/projects/aaaaaaaa-1111/issues/search?limit=1&withBuckets=true"),
            "{alpha}"
        );
        assert!(
            alpha.contains("GET /api/projects/aaaaaaaa-1111/release-readiness"),
            "{alpha}"
        );
    }

    /// Criteria 26 and 28: the legend names every column and lane, and the
    /// keys row says what each key does or why none is read.
    #[test]
    fn the_legend_and_keys_say_what_each_column_and_key_means() {
        let s = a_fine_box(false);
        let t = build(&s, &opts(170));
        let words = |t: &Table| {
            t.foot
                .iter()
                .map(|l| l.text.as_str())
                .collect::<Vec<_>>()
                .join(" ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        };
        let foot = words(&t);
        for said in [
            "! wanting attention",
            "MOV in_progress testing releasing",
            "HAND developed tested awaiting_release",
            "QUE open confirmed clarified approved",
            "BLK needs_info waiting on_hold reopen",
            "DRF draft",
            "? could not be read",
            "Enter opens",
            "q quits",
            "s shows",
        ] {
            assert!(foot.contains(said), "{said}: {foot}");
        }
        let t = build(
            &s,
            &Opts {
                keys: KeysSaid::Unread("stdin is not a terminal".into()),
                ..opts(170)
            },
        );
        let foot = words(&t);
        assert!(
            foot.contains("keys are not read (stdin is not a terminal)")
                && foot.contains("redraws every 5s"),
            "{foot}"
        );
    }

    /// Criterion 9 at the (box): its CHANGE sums what moved over the projects
    /// read, and says `?` where any project's lanes were not read, never the
    /// `—` of no earlier reading nor the blank of nothing moved.
    #[test]
    fn the_box_change_says_question_mark_where_any_lanes_were_unread() {
        let change = |t: &Table, i: usize| {
            let at = cells(&t.head[1].text[..t.head[1].text.find("CHANGE").unwrap()]);
            let row = &t.body.iter().filter(|l| l.row).nth(i).unwrap().text;
            row.chars().skip(at).collect::<String>().trim().to_string()
        };
        let unread = |s: &mut Snapshot, all: bool| {
            if let Ok((_, m)) = &mut s.core {
                for (i, c) in m.values_mut().enumerate() {
                    if all || i == 0 {
                        c.lanes = Err(Unreadable::new("lanes", "500"));
                    }
                }
            }
        };
        let mut s = a_crowded_box();
        unread(&mut s, true);
        assert_eq!(change(&build(&s, &opts(170)), 0), "?", "none read");
        let mut s = a_crowded_box();
        let same = s.core.clone().unwrap();
        s.core_before = Some(Ok(same));
        unread(&mut s, false);
        assert_eq!(
            change(&build(&s, &opts(170)), 0),
            "?",
            "nothing moved among those read, one unread"
        );
        let mut s = a_crowded_box();
        unread(&mut s, false);
        let c = change(&build(&s, &opts(300)), 0);
        assert!(
            c.starts_with("prog+") && c.ends_with(" ?"),
            "moves among those read, one unread: {c}"
        );
    }

    /// Criterion 28: the legend says what every column the heading names
    /// means, VERDICT and NOW among them, and names every verdict word.
    #[test]
    fn the_legend_names_every_column_and_every_verdict_word() {
        let s = a_fine_box(false);
        let t = build(&s, &opts(170));
        let foot = t
            .foot
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let foot = foot.split_whitespace().collect::<Vec<_>>().join(" ");
        // Every heading but the project's own name.
        for col in t.head[1]
            .text
            .split_whitespace()
            .filter(|c| *c != "PROJECT")
        {
            assert!(
                foot.contains(&format!("{col} ")),
                "column {col} unexplained: {foot}"
            );
        }
        for word in [
            "STALL", "ASKS", "DRIFT", "ORPHAN", "NOPATH", "AGEING", "DOWN", "WAITS", "GATE",
            "DAEMON", "idle", "ok",
        ] {
            assert!(
                foot.contains(&format!("{word} ")),
                "verdict {word} unexplained: {foot}"
            );
        }
    }
}
