//! What a live view shows on each redraw: the table, or one row's detail, and
//! what each key does to it.
//!
//! The table fills the screen and scrolls to keep its selection in view; a
//! detail is text, paged as the whole frame always was, space holding the
//! page and `n` and `p` turning it. Colour is laid on last, over rows already
//! fitted to the screen, so it never counts toward a row's width.

use super::attention::{self, Tone};
use super::fit::{self, Screen};
use super::gather::Snapshot;
use super::keys::{Key, Keys};
use super::lanes;
use super::render;
use super::source::ago;
use super::table::{self, KeysSaid, Line, Opts};
use super::Paging;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Table,
    /// The detail of the table's row with this index; 0 is the box.
    Detail(usize),
}

/// What a key asks of the loop around the view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Act {
    Redraw,
    Quit,
}

pub struct View {
    pub mode: Mode,
    pub selected: usize,
    pub sources: bool,
    /// The first body row of the table on screen.
    scroll: usize,
    pub paging: Paging,
    /// The detail page last drawn, which a key turns from.
    shown: Option<fit::Shown>,
    colour: bool,
    interval: u64,
}

/// Width the table is built to where the screen's size cannot be read.
const UNSIZED_COLS: usize = 170;

impl View {
    pub fn new(interval: u64, colour: bool) -> Self {
        Self {
            mode: Mode::Table,
            selected: 0,
            sources: false,
            scroll: 0,
            paging: Paging::default(),
            shown: None,
            colour,
            interval,
        }
    }

    pub fn pressed(&mut self, key: Key, s: &Snapshot) -> Act {
        let last = table::rows(s) - 1;
        match (self.mode, key) {
            (_, Key::Quit) => return Act::Quit,
            (Mode::Table, Key::Up) => self.selected = self.selected.saturating_sub(1),
            (Mode::Table, Key::Down) => self.selected = (self.selected + 1).min(last),
            (Mode::Table, Key::Open) => {
                self.mode = Mode::Detail(self.selected.min(last));
                self.paging = Paging::default();
                self.shown = None;
            }
            (Mode::Table, Key::Sources) => self.sources = !self.sources,
            (Mode::Detail(_), Key::Back) => self.mode = Mode::Table,
            (Mode::Detail(_), k @ (Key::Hold | Key::Next | Key::Previous)) => {
                if let Some(shown) = &self.shown {
                    self.paging.pressed(k, shown);
                }
            }
            _ => {}
        }
        Act::Redraw
    }

    /// A redraw's interval is over: a detail turns to its next page unless
    /// one is held; the table stays where the selection put it.
    pub fn turned(&mut self) {
        if let (Mode::Detail(_), Some(shown)) = (self.mode, &self.shown) {
            self.paging.turned(shown);
        }
    }

    /// The rows to write, colour included, for `s` on a screen of `size`.
    pub fn draw(
        &mut self,
        s: &Snapshot,
        size: Option<Screen>,
        keys: &Result<Keys, String>,
    ) -> Vec<String> {
        let rows = table::rows(s);
        self.selected = self.selected.min(rows - 1);
        if let Mode::Detail(i) = self.mode {
            if i >= rows {
                self.mode = Mode::Table;
            }
        }
        match self.mode {
            Mode::Table => self.draw_table(s, size, keys),
            Mode::Detail(i) => self.draw_detail(s, i, size, keys),
        }
    }

    fn draw_table(
        &mut self,
        s: &Snapshot,
        size: Option<Screen>,
        keys: &Result<Keys, String>,
    ) -> Vec<String> {
        let cols = size.map_or(UNSIZED_COLS, |z| z.cols);
        let t = table::build(
            s,
            &Opts {
                cols,
                selected: self.selected,
                sources: self.sources,
                keys: match keys {
                    Ok(_) => KeysSaid::Read,
                    Err(why) => KeysSaid::Unread(why.clone()),
                },
                interval: Some(self.interval),
            },
        );
        let (head, mut body, mut foot) = (t.head, t.body, t.foot);
        match size {
            None => foot.push(Line {
                text: "the screen's size could not be read, so this table is not fitted to it"
                    .into(),
                ..foot_line()
            }),
            Some(z) => {
                // The screen's own rows bound everything: legend rows go first,
                // then the keys, before a body row does.
                while head.len() + foot.len() + 1 > z.rows && !foot.is_empty() {
                    foot.remove(0);
                }
                let room = z.rows.saturating_sub(head.len() + foot.len());
                if body.len() > room {
                    let room = room.saturating_sub(1).max(1);
                    self.scroll_to(&body, room);
                    let total = body.len();
                    body = body.split_off(self.scroll);
                    body.truncate(room);
                    let said = Line {
                        text: fit::wrap(
                            &format!(
                                "rows {}–{} of {total} shown; moving the selection scrolls the rest",
                                self.scroll + 1,
                                self.scroll + body.len()
                            ),
                            cols,
                        )
                        .remove(0),
                        ..foot_line()
                    };
                    foot.insert(0, said);
                } else {
                    self.scroll = 0;
                }
            }
        }
        let mut out: Vec<String> = head
            .iter()
            .chain(&body)
            .chain(&foot)
            .map(|l| paint(l, self.colour))
            .collect();
        if let Some(z) = size {
            out.truncate(z.rows);
        }
        out
    }

    /// Keep the selected row's lines on screen, moving as little as needed.
    fn scroll_to(&mut self, body: &[Line], room: usize) {
        let mine: Vec<usize> = body
            .iter()
            .enumerate()
            .filter(|(_, l)| l.owner == Some(self.selected))
            .map(|(i, _)| i)
            .collect();
        let (first, last) = (
            mine.first().copied().unwrap_or(0),
            mine.last().copied().unwrap_or(0),
        );
        if first < self.scroll {
            self.scroll = first;
        } else if last >= self.scroll + room {
            self.scroll = (last + 1 - room).min(first);
        }
        self.scroll = self.scroll.min(body.len().saturating_sub(room));
    }

    fn draw_detail(
        &mut self,
        s: &Snapshot,
        i: usize,
        size: Option<Screen>,
        keys: &Result<Keys, String>,
    ) -> Vec<String> {
        let lines = detail(s, i, self.interval);
        let shown = fit::screen(&lines, size, self.paging.page, &self.paging.said(keys));
        self.paging.page = shown.at;
        let out = shown
            .rows
            .iter()
            .enumerate()
            .map(|(n, r)| {
                paint(
                    &Line {
                        text: r.clone(),
                        bold: n == 0,
                        ..foot_line()
                    },
                    self.colour,
                )
            })
            .collect();
        self.shown = Some(shown);
        out
    }
}

fn foot_line() -> Line {
    Line {
        text: String::new(),
        tone: Tone::Plain,
        owner: None,
        selected: false,
        bold: false,
        row: false,
    }
}

/// The detail of table row `i` as frame lines, header first: the box's is the
/// whole frame `--once` prints, a project's its own block and findings.
pub fn detail(s: &Snapshot, i: usize, interval: u64) -> Vec<String> {
    let mut out = vec![render::header(Some(interval))];
    if i == 0 {
        out.push(
            "DETAIL (box) — the whole frame, as --once prints it · Esc returns to the table, q quits"
                .into(),
        );
        out.push(String::new());
        findings(&attention::boxwide(s), &mut out);
        out.extend(render::frame(s, None).into_iter().skip(1));
        return out;
    }
    let p = &s.projects[i - 1];
    out.push(format!(
        "DETAIL {} — its findings, its lanes by status and its block of the full frame · Esc returns to the table, q quits",
        p.key
    ));
    out.push(String::new());
    findings(&attention::project(s, p), &mut out);
    out.push(String::new());
    out.push("LANES BY STATUS".into());
    match table::lanes_of(s, p) {
        Err(e) => out.push(format!("  {e}")),
        Ok(counts) => {
            let route = p
                .project_id
                .as_deref()
                .map(super::people::lanes_route)
                .unwrap_or_default();
            let read = match &s.core {
                Ok((at, _)) => render::read_ago(s.now_ms, *at),
                Err(_) => String::new(),
            };
            for ((name, statuses), n) in lanes::LANES.iter().zip(lanes::sums(counts)) {
                let each: Vec<String> = statuses
                    .iter()
                    .map(|st| format!("{st} {}", counts.get(*st).copied().unwrap_or(0)))
                    .collect();
                out.push(format!(
                    "  {name:<5} {n} — {}{read} ← GET {route}",
                    each.join(", ")
                ));
            }
            for st in ["closed", "dropped"] {
                out.push(format!(
                    "  {st:<5} {} — in no lane{read} ← GET {route}",
                    counts.get(st).copied().unwrap_or(0)
                ));
            }
            for (st, n) in lanes::outside(counts) {
                out.push(format!(
                    "  {st} {n} — a status in no lane{read} ← GET {route}"
                ));
            }
            let before = s
                .core_before
                .as_ref()
                .and_then(|b| b.as_ref().ok())
                .and_then(|(at, all)| {
                    Some((at, render::core_of(p, all).ok()?.lanes.as_ref().ok()?))
                });
            out.push(match before {
                None => "  CHANGE —, no earlier reading of core to compare against".into(),
                Some((at, b)) => {
                    let moved = lanes::change(b, counts);
                    format!(
                        "  CHANGE {} against core's reading of {} ← GET {route}",
                        if moved.is_empty() {
                            "nothing moved"
                        } else {
                            &moved
                        },
                        ago(s.now_ms, *at)
                    )
                }
            });
        }
    }
    out.push(String::new());
    out.push("PROJECT".into());
    out.extend(render::project_detail(s, p));
    out
}

fn findings(a: &attention::Assessment, out: &mut Vec<String>) {
    out.push("ATTENTION".into());
    if a.findings.is_empty() {
        out.push("  nothing wants attention — every source this row reads was read".into());
    }
    for f in &a.findings {
        out.push(format!("  {:<6} {} ← {}", f.word, f.text, f.source));
    }
}

/// `line` with its colour, where colour is on.
pub fn paint(line: &Line, colour: bool) -> String {
    if !colour {
        return line.text.clone();
    }
    let mut codes = Vec::new();
    if line.bold {
        codes.push("1");
    }
    match line.tone {
        Tone::Red => codes.push("31"),
        Tone::Yellow | Tone::Unread => codes.push("33"),
        Tone::Dim => codes.push("2"),
        Tone::Plain => {}
    }
    if line.selected {
        codes.push("7");
    }
    if codes.is_empty() {
        line.text.clone()
    } else {
        format!("\x1b[{}m{}\x1b[0m", codes.join(";"), line.text)
    }
}

/// Whether a view on a terminal writes colour: not where `NO_COLOR` is set to
/// anything but empty (no-color.org).
pub fn colour_wanted(no_color: Option<std::ffi::OsString>) -> bool {
    no_color.is_none_or(|v| v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd::top::render::tests::a_fine_box;

    fn keys_unread() -> Result<Keys, String> {
        Err("stdin is not a terminal".into())
    }

    fn screen(cols: usize, rows: usize) -> Option<Screen> {
        Some(Screen { cols, rows })
    }

    fn plain(rows: &[String]) -> Vec<String> {
        rows.iter().map(|r| strip(r)).collect()
    }

    fn strip(r: &str) -> String {
        let mut out = String::new();
        let mut esc = false;
        for c in r.chars() {
            match (esc, c) {
                (false, '\x1b') => esc = true,
                (true, 'm') => esc = false,
                (true, _) => {}
                (false, c) => out.push(c),
            }
        }
        out
    }

    /// Criteria 17 and 18: the arrows and `j`/`k` move the selection and stop
    /// at either end, and the selected row reads `>` and, with colour,
    /// reversed.
    #[test]
    fn the_selection_moves_and_stops_at_either_end() {
        let s = a_fine_box(true);
        let mut v = View::new(5, true);
        v.pressed(Key::Up, &s);
        assert_eq!(v.selected, 0, "stops at the first");
        for _ in 0..5 {
            v.pressed(Key::Down, &s);
        }
        assert_eq!(v.selected, 2, "stops at the last of box, alpha, beta");
        let rows = v.draw(&s, screen(170, 40), &keys_unread());
        let beta = rows.iter().find(|r| r.contains("beta")).unwrap();
        assert!(beta.starts_with("\x1b[2;7m>"), "dim and reversed: {beta:?}");
        let alpha = rows.iter().find(|r| strip(r).contains(" alpha ")).unwrap();
        assert!(alpha.starts_with("\x1b[31m "), "red, unselected: {alpha:?}");
    }

    /// Criteria 15 and 16: with colour off not one escape is written, and the
    /// selection and verdicts still read from the text.
    #[test]
    fn without_colour_the_text_still_says_everything() {
        let s = a_fine_box(true);
        let mut v = View::new(5, false);
        v.pressed(Key::Down, &s);
        let rows = v.draw(&s, screen(120, 40), &keys_unread());
        assert!(rows.iter().all(|r| !r.contains('\x1b')), "{rows:#?}");
        let alpha = rows.iter().find(|r| r.contains(" alpha ")).unwrap();
        assert!(alpha.starts_with('>') && alpha.contains("ASKS"), "{alpha}");
        assert!(colour_wanted(None));
        assert!(colour_wanted(Some("".into())));
        assert!(!colour_wanted(Some("1".into())));
    }

    /// Criteria 19, 20 and 21: Enter opens the selected row's detail, Esc
    /// comes back to the table where the selection was, q asks to quit from
    /// either.
    #[test]
    fn enter_opens_esc_returns_and_q_quits() {
        let s = a_fine_box(true);
        let mut v = View::new(5, false);
        assert_eq!(v.pressed(Key::Quit, &s), Act::Quit);
        v.pressed(Key::Down, &s);
        v.pressed(Key::Open, &s);
        assert_eq!(v.mode, Mode::Detail(1));
        let rows = v.draw(&s, screen(170, 60), &keys_unread());
        assert!(
            rows.iter().any(|r| r.starts_with("DETAIL alpha")),
            "{rows:#?}"
        );
        assert_eq!(v.pressed(Key::Down, &s), Act::Redraw);
        assert_eq!(v.mode, Mode::Detail(1), "arrows do not leave a detail");
        v.pressed(Key::Back, &s);
        assert_eq!((v.mode, v.selected), (Mode::Table, 1));
        v.pressed(Key::Open, &s);
        assert_eq!(v.pressed(Key::Quit, &s), Act::Quit);
    }

    /// Criterion 22: the box's detail is the whole frame, paged, and space,
    /// `n` and `p` page it as before.
    #[test]
    fn the_box_detail_is_the_whole_frame_paged() {
        let s = a_fine_box(true);
        let mut v = View::new(5, false);
        v.pressed(Key::Open, &s);
        let whole = detail(&s, 0, 5).join("\n");
        for section in ["BINARY", "PROJECTS", "WAITING ON A PERSON", "HEALTH"] {
            assert!(whole.contains(section), "{section}");
        }
        for l in render::frame(&s, None).iter().skip(1) {
            assert!(
                whole.contains(l.as_str()),
                "the frame's line {l:?} is in the box's detail"
            );
        }
        let keys = Err("stdin is not a terminal".to_string());
        let first = plain(&v.draw(&s, screen(100, 12), &keys));
        assert!(
            first.iter().any(|r| r.starts_with("page 1 of ")),
            "{first:#?}"
        );
        v.pressed(Key::Next, &s);
        let second = plain(&v.draw(&s, screen(100, 12), &keys));
        assert!(
            second.iter().any(|r| r.starts_with("page 2 of ")),
            "{second:#?}"
        );
        // Keys are not read in a unit test, so the page row says so rather
        // than HELD; the hold is read off the paging itself.
        v.turned();
        assert_eq!(v.paging.page, 2, "an interval turns an unheld page");
        v.draw(&s, screen(100, 12), &keys);
        v.pressed(Key::Previous, &s);
        v.draw(&s, screen(100, 12), &keys);
        v.pressed(Key::Hold, &s);
        v.turned();
        v.draw(&s, screen(100, 12), &keys);
        assert_eq!(
            (v.paging.page, v.paging.held),
            (1, true),
            "a held page stays"
        );
    }

    /// Criterion 23: a project's detail holds its block of the frame, its
    /// lanes by status with their route, its questions and release rows, and
    /// each finding with its source.
    #[test]
    fn a_project_detail_holds_its_block_lanes_waits_and_findings() {
        let s = a_fine_box(true);
        let d = detail(&s, 1, 5).join("\n");
        for said in [
            "ASKS   ISS-4 run run-park is parked on a person, waiting on the owner ←",
            "NOPATH 1 at awaiting_release (ISS-7) with no release path: NO_RELEASE_GATE ← GET /api/projects/aaaaaaaa-1111/release-readiness",
            "MOV   1 — in_progress 1, testing 0, releasing 0 ← GET /api/projects/aaaaaaaa-1111/issues/search?limit=1&withBuckets=true",
            "closed 5 — in no lane",
            "CHANGE —, no earlier reading",
            "alpha  [aaaaaaaa]  /repo/a",
            "skill    /repo/a/SKILL.md",
            "lanes    MOV 1 (in_progress 1) · HAND 0 · QUE 2 (open 2) · BLK 0 · DRF 1 (draft 1) ← GET /api/projects/aaaaaaaa-1111/issues/search?limit=1&withBuckets=true",
            "questions  alpha: 1 open",
            "releases   alpha: 1 at awaiting_release (ISS-7) with no release path: NO_RELEASE_GATE",
            "parked     ISS-4 run run-park waits on the owner ← runs",
        ] {
            assert!(d.contains(said), "{said}\n---\n{d}");
        }
        assert!(!d.contains("beta"), "only alpha's rows: {d}");
    }

    /// Criterion 27: a table taller than the screen keeps the selection on
    /// screen and says which rows are shown.
    #[test]
    fn a_tall_table_scrolls_to_its_selection() {
        let s = a_fine_box(true);
        let mut v = View::new(5, false);
        v.sources = true;
        let size = screen(80, 16);
        let rows = v.draw(&s, size, &keys_unread());
        assert!(rows.len() <= 16, "{rows:#?}");
        assert!(rows.iter().any(|r| r.starts_with("rows 1–")), "{rows:#?}");
        v.pressed(Key::Down, &s);
        v.pressed(Key::Down, &s);
        let rows = v.draw(&s, size, &keys_unread());
        assert!(rows.len() <= 16);
        assert!(
            rows.iter()
                .any(|r| r.starts_with('>') && r.contains("beta")),
            "{rows:#?}"
        );
        let said = rows.iter().find(|r| r.starts_with("rows ")).unwrap();
        assert!(!said.starts_with("rows 1–"), "scrolled: {said}");
        for _ in 0..2 {
            v.pressed(Key::Up, &s);
        }
        let rows = v.draw(&s, size, &keys_unread());
        assert!(
            rows.iter()
                .any(|r| r.starts_with('>') && r.contains("(box)")),
            "{rows:#?}"
        );
    }
}
