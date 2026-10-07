//! Spend as the frame, a project's detail and the table say it.

use super::sum::{Master, ProjectSpend, Share, Totals, Window};
use super::Spend;
use crate::cmd::top::source::ago;

const I1: &str = "  ";
const I2: &str = "    ";

/// The SPEND section: its heading names what it read, and every line under
/// it is a reading of that.
pub fn section(spend: &Spend, now_ms: i64, config_path: &str) -> Vec<String> {
    let mut out = Vec::new();
    match spend {
        Spend::Unreadable(u) => {
            out.push(format!("SPEND  {u}"));
            return out;
        }
        Spend::Reading {
            root,
            read,
            outstanding,
            files,
        } => {
            out.push(format!(
                "SPEND  reading the {files} transcript(s) modified within 7d: {} read, {} still to read; totals are shown once every one is read ← {}",
                bytes(*read),
                bytes(*outstanding),
                root.display()
            ));
            return out;
        }
        Spend::Read(t) => {
            out.push(format!(
                "SPEND  tokens and estimated cost by the checkout each response was written from, each API response counted once ← {} (*/*.jsonl and */<session>/subagents/*.jsonl, {} file(s) modified within 7d), read {}; rates ← {config_path} [rates]",
                t.root.display(),
                t.files,
                ago(now_ms, t.at_ms)
            ));
            for p in &t.projects {
                out.extend(project_rows(p));
            }
            for (place, share) in &t.unattributed {
                out.push(format!(
                    "{I1}unattributed  ← every response written from {place}, under no bound checkout"
                ));
                out.extend(windows(I2, "", share));
            }
            out.extend(notes(t, config_path));
        }
    }
    out
}

/// The spend of the snapshot's `index`th project, for its detail: the
/// section as the frame draws it, its own rows alone. Looked up by place,
/// never by name: two rows can share a display key (whole-set read at
/// 07832d1f4, F3).
pub fn project(spend: &Spend, index: usize, now_ms: i64, config_path: &str) -> Vec<String> {
    match spend {
        Spend::Read(t) => match t.projects.get(index) {
            None => vec![format!(
                "SPEND  this project was not bound when the transcripts were summed ← {}",
                t.root.display()
            )],
            Some(p) => {
                let mut out = vec![format!(
                    "SPEND  ← {}, read {}; rates ← {config_path} [rates]",
                    t.root.display(),
                    ago(now_ms, t.at_ms)
                )];
                out.extend(project_rows(p));
                out.extend(notes(t, config_path));
                out
            }
        },
        other => section(other, now_ms, config_path),
    }
}

fn project_rows(p: &ProjectSpend) -> Vec<String> {
    let mut out = Vec::new();
    let Some(repo) = &p.repo else {
        out.push(format!(
            "{I1}{}  no checkout on this box, so no transcript's cwd can be told as this project's",
            p.key
        ));
        return out;
    };
    out.push(format!(
        "{I1}{}  ← every response written from a cwd under {}: its master, job panes and subagent runs",
        p.key,
        repo.display()
    ));
    out.extend(windows(I2, "", &p.total));
    match &p.master {
        Master::Conversation { id, share } => {
            out.push(format!(
                "{I2}master conversation {id}, its share apart ← the ledger's masters.conversation_id; a conversation it replaced counts above only"
            ));
            out.extend(windows(I2, "master ", share));
        }
        Master::NoneRecorded => out.push(format!(
            "{I2}master the ledger records no conversation for it, so its share cannot be told apart"
        )),
        Master::Unknown => out.push(format!(
            "{I2}master the ledger could not be read, so which conversation is the master's is not known"
        )),
    }
    out
}

fn windows(indent: &str, label: &str, s: &Share) -> Vec<String> {
    vec![
        format!("{indent}{label}24h  {}", window(&s.day)),
        format!("{indent}{label}7d   {}", window(&s.week)),
    ]
}

/// A window's four counts and its cost, the cost saying which models it
/// leaves out.
pub fn window(w: &Window) -> String {
    if w.is_empty() {
        return "nothing".into();
    }
    let [i, o, cw, cr] = w.tokens;
    format!(
        "in {} · out {} · cache-write {} · cache-read {} · {}",
        count(i),
        count(o),
        count(cw),
        count(cr),
        cost(w)
    )
}

fn cost(w: &Window) -> String {
    let priced = format!("${:.2}", w.cost);
    if w.unpriced.is_empty() {
        return priced;
    }
    let models: Vec<&str> = w.unpriced.keys().map(String::as_str).collect();
    let models = models.join(", ");
    if w.priced() {
        format!("{priced} + {models} unpriced")
    } else {
        format!("cost unread, {models} unpriced")
    }
}

fn notes(t: &Totals, config_path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut unpriced: std::collections::BTreeMap<&str, (u64, u64)> = Default::default();
    for (m, n) in &t.whole.day.unpriced {
        unpriced.entry(m).or_default().0 += n;
    }
    for (m, n) in &t.whole.week.unpriced {
        unpriced.entry(m).or_default().1 += n;
    }
    for (m, (day, week)) in unpriced {
        let why = t
            .bad_rates
            .iter()
            .find(|(b, _)| b == m)
            .map(|(_, why)| format!("its [rates.\"{m}\"] entry {why}"))
            .or_else(|| {
                t.rates_unread
                    .as_ref()
                    .map(|why| format!("{config_path} could not be read: {why}"))
            })
            .unwrap_or_else(|| format!("no [rates.\"{m}\"] in {config_path}"));
        out.push(format!(
            "{I1}{m} has no rate ({why}), so every cost naming \"{m} unpriced\" leaves out its tokens: 24h {}, 7d {}",
            count(day),
            count(week)
        ));
    }
    for (m, why) in &t.bad_rates {
        if !t.whole.week.unpriced.contains_key(m) {
            out.push(format!(
                "{I1}[rates.\"{m}\"] in {config_path} {why}, so it prices nothing"
            ));
        }
    }
    if t.bad > 0 {
        out.push(format!(
            "{I1}{} line(s) naming usage could not be counted (no timestamp, or not the shape a transcript line is written in), so every total leaves them out",
            t.bad
        ));
    }
    if t.unkeyed > 0 {
        out.push(format!(
            "{I1}{} response(s) carry no message.id or requestId, so each of their lines is counted as written",
            t.unkeyed
        ));
    }
    for u in &t.unreadable {
        out.push(format!("{I1}{u}, so every total leaves it out"));
    }
    out
}

/// The table's 24-hour cost of the snapshot's `index`th project, or the
/// whole box's: `?` where the transcripts were not all read, `…` while the
/// first read is under way, `·` for none, a trailing `+` where a model in it
/// has no rate, and `$?+` where no model in it has one, never a dollar zero. A transcript that could not be read could be any
/// project's, so it makes every cell `?` rather than a total that leaves it
/// out (whole-set read at 07832d1f4, F4); the detail says which.
pub fn cell(spend: &Spend, index: Option<usize>) -> String {
    let t = match spend {
        Spend::Unreadable(_) => return "?".into(),
        Spend::Reading { .. } => return "…".into(),
        Spend::Read(t) if !t.unreadable.is_empty() => return "?".into(),
        Spend::Read(t) => t,
    };
    let day = match index {
        None => &t.whole.day,
        Some(i) => match t.projects.get(i) {
            Some(p) if p.repo.is_some() => &p.total.day,
            _ => return "?".into(),
        },
    };
    if day.is_empty() {
        return "·".into();
    }
    if !day.priced() {
        return "$?+".into();
    }
    let mut c = dollars(day.cost);
    if !day.unpriced.is_empty() {
        c.push('+');
    }
    c
}

/// Dollars in at most six cells.
fn dollars(x: f64) -> String {
    if x < 10.0 {
        format!("${x:.2}")
    } else if x < 1_000.0 {
        format!("${x:.0}")
    } else if x < 100_000.0 {
        format!("${:.1}K", x / 1_000.0)
    } else {
        format!("${:.0}K", x / 1_000.0)
    }
}

/// A token count a person reads at a glance: `999`, `12.3K`, `123K`, `1.0M`.
pub fn count(n: u64) -> String {
    if n < 1_000 {
        return n.to_string();
    }
    let (v, unit) = match n {
        n if n < 1_000_000 => (n as f64 / 1e3, "K"),
        n if n < 1_000_000_000 => (n as f64 / 1e6, "M"),
        n => (n as f64 / 1e9, "B"),
    };
    if v < 100.0 {
        format!("{v:.1}{unit}")
    } else {
        format!("{v:.0}{unit}")
    }
}

fn bytes(n: u64) -> String {
    match n {
        n if n < 1 << 20 => format!("{} KB", n >> 10),
        n if n < 1 << 30 => format!("{:.1} MB", n as f64 / (1u64 << 20) as f64),
        n => format!("{:.1} GB", n as f64 / (1u64 << 30) as f64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd::top::spend::sum::{Master, ProjectSpend, Share, Totals};
    use std::collections::BTreeMap;

    #[test]
    fn counts_and_dollars_read_at_a_glance() {
        assert_eq!(count(0), "0");
        assert_eq!(count(999), "999");
        assert_eq!(count(33_000), "33.0K");
        assert_eq!(count(123_456), "123K");
        assert_eq!(count(1_003_000), "1.0M");
        assert_eq!(count(10_000_000), "10.0M");
        assert_eq!(count(2_500_000_000), "2.5B");
        assert_eq!(dollars(0.0), "$0.00");
        assert_eq!(dollars(28.5), "$28");
        assert_eq!(dollars(9.999), "$10.00");
        assert_eq!(dollars(1_234.0), "$1.2K");
        assert_eq!(dollars(123_456.0), "$123K");
    }

    fn totals(day: Window, repo: Option<&str>) -> Spend {
        Spend::Read(Box::new(Totals {
            at_ms: 0,
            root: "/h/.claude/projects".into(),
            files: 1,
            projects: vec![ProjectSpend {
                key: "alpha".into(),
                repo: repo.map(Into::into),
                total: Share {
                    day: day.clone(),
                    week: day.clone(),
                },
                master: Master::NoneRecorded,
            }],
            unattributed: vec![],
            whole: Share {
                day: day.clone(),
                week: day,
            },
            bad_rates: vec![],
            rates_unread: None,
            unreadable: vec![],
            bad: 0,
            unkeyed: 0,
        }))
    }

    /// ISS-1375, criterion 9: the table's cell reads `?` unread, `…` while
    /// the first read runs, `·` for none, and ends `+` where a model in it
    /// has no rate; a project with no checkout here is `?`, never `·`.
    #[test]
    fn the_table_cell_says_unread_reading_none_and_unpriced() {
        use crate::cmd::top::source::Unreadable;
        let unread = Spend::Unreadable(Unreadable::new("/h/.claude/projects", "denied"));
        assert_eq!(cell(&unread, Some(0)), "?");
        let reading = Spend::Reading {
            root: "/h/.claude/projects".into(),
            read: 1 << 30,
            outstanding: 3 << 30,
            files: 1800,
        };
        assert_eq!(cell(&reading, None), "…");
        let priced = Window {
            tokens: [1_000_000, 0, 0, 0],
            cost: 3.0,
            unpriced: BTreeMap::new(),
        };
        assert_eq!(cell(&totals(priced.clone(), Some("/r")), Some(0)), "$3.00");
        let partial = Window {
            unpriced: BTreeMap::from([("model-b".to_string(), 5)]),
            ..priced
        };
        assert_eq!(
            cell(&totals(partial.clone(), Some("/r")), Some(0)),
            "$3.00+"
        );
        assert_eq!(cell(&totals(partial, Some("/r")), None), "$3.00+");
        assert_eq!(cell(&totals(Window::default(), Some("/r")), Some(0)), "·");
        assert_eq!(cell(&totals(Window::default(), None), Some(0)), "?");
        assert_eq!(cell(&totals(Window::default(), Some("/r")), Some(1)), "?");
        // Whole-set read at 07832d1f4, F4: one transcript unread is no
        // project's "none", and no project's whole amount.
        use crate::cmd::top::source::Unreadable as U;
        for day in [Window::default(), priced_window()] {
            let Spend::Read(mut t) = totals(day, Some("/r")) else {
                unreachable!()
            };
            t.unreadable
                .push(U::new("/h/.claude/projects/-x/s.jsonl", "denied"));
            let spend = Spend::Read(t);
            assert_eq!(cell(&spend, Some(0)), "?");
            assert_eq!(cell(&spend, None), "?");
        }
    }

    fn priced_window() -> Window {
        Window {
            tokens: [1_000_000, 0, 0, 0],
            cost: 3.0,
            unpriced: BTreeMap::new(),
        }
    }

    /// ISS-1375, criterion 12: until the window is read whole the section
    /// says how far it has read, and prints no total.
    #[test]
    fn a_window_not_yet_read_whole_says_how_far_and_prints_no_total() {
        let reading = Spend::Reading {
            root: "/h/.claude/projects".into(),
            read: 1 << 30,
            outstanding: 3 << 30,
            files: 1800,
        };
        let text = section(&reading, 0, "/c/config.toml").join("\n");
        assert!(
            text.contains("1800 transcript(s) modified within 7d: 1.0 GB read, 3.0 GB still to read; totals are shown once every one is read ← /h/.claude/projects"),
            "{text}"
        );
        assert!(!text.contains('$') && !text.contains("24h"), "{text}");
    }

    /// Criterion 8: a cost that leaves a model's tokens out says so.
    #[test]
    fn a_cost_leaving_a_model_out_names_it() {
        let w = Window {
            tokens: [11, 2, 3, 4],
            cost: 1.5,
            unpriced: BTreeMap::from([("model-b".to_string(), 10)]),
        };
        assert_eq!(
            window(&w),
            "in 11 · out 2 · cache-write 3 · cache-read 4 · $1.50 + model-b unpriced"
        );
        assert_eq!(window(&Window::default()), "nothing");
    }
    /// Judge iss-1341+1375-cd92ac72, finding 3: with no rate for any model
    /// in a window there is no priced part to show, so no row, total or
    /// share reads a dollar zero; the cost is said to be unread.
    #[test]
    fn a_window_with_no_priced_model_shows_no_dollar_zero() {
        let none = Window {
            tokens: [1_000, 2_000, 0, 0],
            cost: 0.0,
            unpriced: BTreeMap::from([("claude-opus-5-5".to_string(), 3_000)]),
        };
        assert_eq!(
            window(&none),
            "in 1.0K · out 2.0K · cache-write 0 · cache-read 0 · cost unread, claude-opus-5-5 unpriced"
        );
        let spend = totals(none, Some("/r"));
        assert_eq!(cell(&spend, Some(0)), "$?+");
        assert_eq!(cell(&spend, None), "$?+");
        assert!(
            crate::cmd::top::table::legend(crate::cmd::top::table::Legend::Full)
                .contains(&"$?+ no rate".to_string()),
            "the full legend says what $?+ is"
        );
        let text = section(&spend, 0, "/c/config.toml").join("\n");
        assert!(!text.contains("$0.00") && !text.contains('$'), "{text}");
        assert!(
            text.contains("every cost naming \"claude-opus-5-5 unpriced\" leaves out its tokens"),
            "{text}"
        );
        // A priced part, however small, is still shown beside the rest.
        let some = Window {
            tokens: [1, 0, 0, 0],
            cost: 0.0,
            unpriced: BTreeMap::new(),
        };
        assert_eq!(cell(&totals(some.clone(), Some("/r")), Some(0)), "$0.00");
        assert!(window(&some).ends_with(" · $0.00"), "{}", window(&some));
    }
}
