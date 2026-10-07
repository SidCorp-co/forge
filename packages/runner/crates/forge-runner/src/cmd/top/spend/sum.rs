//! The responses read, summed by project and window and priced.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use super::read::Response;
use super::{DAY_MS, WEEK_MS};
use crate::cmd::top::source::Unreadable;

/// One model's price, in US dollars per million tokens of each kind.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rate {
    /// Input, output, cache-write and cache-read, in that order.
    pub per_million: [f64; 4],
}

/// The keys a `[rates."<model>"]` entry holds, in the order counts are kept.
pub const RATE_KEYS: [&str; 4] = ["input", "output", "cache_write", "cache_read"];

/// Every entry of `config.toml`'s `[rates]`, priced, or why it cannot be.
pub fn rates(table: &toml::Table) -> BTreeMap<String, Result<Rate, String>> {
    table
        .iter()
        .map(|(model, v)| (model.clone(), rate(v)))
        .collect()
}

fn rate(v: &toml::Value) -> Result<Rate, String> {
    let t = v.as_table().ok_or_else(|| {
        format!(
            "is a {}, not a table of {}",
            v.type_str(),
            RATE_KEYS.join(", ")
        )
    })?;
    if let Some(k) = t.keys().find(|k| !RATE_KEYS.contains(&k.as_str())) {
        return Err(format!(
            "names {k}, which is not one of {}",
            RATE_KEYS.join(", ")
        ));
    }
    let mut per_million = [0.0; 4];
    for (slot, key) in per_million.iter_mut().zip(RATE_KEYS) {
        let n = match t.get(key) {
            None => return Err(format!("has no {key}")),
            Some(toml::Value::Integer(i)) => *i as f64,
            Some(toml::Value::Float(f)) => *f,
            Some(other) => return Err(format!("{key} is a {}, not a number", other.type_str())),
        };
        if !n.is_finite() || n < 0.0 {
            return Err(format!(
                "{key} is {n}, and a price is a number of dollars from 0 up"
            ));
        }
        *slot = n;
    }
    Ok(Rate { per_million })
}

/// One window's tokens, and what the priced part of them cost.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Window {
    pub tokens: [u64; 4],
    /// The cost of the tokens of every model with a rate.
    pub cost: f64,
    /// Tokens of each model with no rate, which `cost` leaves out.
    pub unpriced: BTreeMap<String, u64>,
}

impl Window {
    fn add(&mut self, r: &Response, rate: Option<&Rate>) {
        for (t, n) in self.tokens.iter_mut().zip(r.tokens) {
            *t += n;
        }
        match rate {
            Some(rate) => {
                self.cost += r
                    .tokens
                    .iter()
                    .zip(rate.per_million)
                    .map(|(n, p)| *n as f64 * p / 1e6)
                    .sum::<f64>()
            }
            None => {
                *self.unpriced.entry(r.model.to_string()).or_default() +=
                    r.tokens.iter().sum::<u64>()
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.tokens == [0; 4] && self.unpriced.is_empty()
    }

    /// Whether any of its tokens are a priced model's, so that `cost` is a
    /// figure at all: with none, it is no dollar zero but no figure.
    pub fn priced(&self) -> bool {
        self.tokens.iter().sum::<u64>() > self.unpriced.values().sum::<u64>()
    }
}

/// The last 24 hours and the last 7 days.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Share {
    pub day: Window,
    pub week: Window,
}

impl Share {
    fn add(&mut self, r: &Response, rate: Option<&Rate>, now_ms: i64) {
        if r.at_ms >= now_ms - WEEK_MS {
            self.week.add(r, rate);
        }
        if r.at_ms >= now_ms - DAY_MS {
            self.day.add(r, rate);
        }
    }
}

/// A project's master, as far as the ledger lets its share be told apart.
#[derive(Debug, Clone, PartialEq)]
pub enum Master {
    /// The ledger records this conversation as the master's.
    Conversation { id: String, share: Share },
    /// The ledger records no conversation for this project's master.
    NoneRecorded,
    /// The ledger could not be read, so which conversation is the master's is
    /// not known.
    Unknown,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectSpend {
    pub key: String,
    /// `None` where the project has no checkout on this box, so no cwd can be
    /// told as its.
    pub repo: Option<PathBuf>,
    pub total: Share,
    pub master: Master,
}

/// A project as the sum needs it.
pub struct Owner<'a> {
    pub key: &'a str,
    pub repo: Option<&'a Path>,
    /// `None` where the ledger could not be read; `Some(None)` where it
    /// records no conversation.
    pub master: Option<Option<&'a str>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Totals {
    pub at_ms: i64,
    pub root: PathBuf,
    pub files: usize,
    pub projects: Vec<ProjectSpend>,
    /// Usage under no bound checkout, by cwd (or by transcript where no line
    /// named a cwd).
    pub unattributed: Vec<(String, Share)>,
    /// The whole box: every project and every unattributed cwd.
    pub whole: Share,
    /// Every `[rates]` entry that cannot price, and why.
    pub bad_rates: Vec<(String, String)>,
    /// Why no rate could be read at all, where the config itself could not be.
    pub rates_unread: Option<String>,
    pub unreadable: Vec<Unreadable>,
    pub bad: usize,
    pub unkeyed: usize,
}

pub struct Context<'a> {
    pub root: &'a Path,
    pub now_ms: i64,
    pub files: usize,
    pub owners: &'a [Owner<'a>],
    pub rates: &'a BTreeMap<String, Result<Rate, String>>,
    pub rates_unread: Option<String>,
    pub unreadable: Vec<Unreadable>,
    pub bad: usize,
    pub unkeyed: usize,
}

pub fn totals<'r>(responses: impl Iterator<Item = &'r Response>, cx: Context<'_>) -> Totals {
    // Longest checkout first, so a checkout inside another's tree takes its own.
    let mut order: Vec<usize> = (0..cx.owners.len()).collect();
    order.sort_by_key(|&i| {
        std::cmp::Reverse(cx.owners[i].repo.map_or(0, |r| r.components().count()))
    });
    let mut projects: Vec<ProjectSpend> = cx
        .owners
        .iter()
        .map(|o| ProjectSpend {
            key: o.key.to_string(),
            repo: o.repo.map(Path::to_path_buf),
            total: Share::default(),
            master: match o.master {
                None => Master::Unknown,
                Some(None) => Master::NoneRecorded,
                Some(Some(id)) => Master::Conversation {
                    id: id.to_string(),
                    share: Share::default(),
                },
            },
        })
        .collect();
    let mut unattributed: HashMap<String, Share> = HashMap::new();
    let mut whole = Share::default();
    for r in responses {
        let rate = cx.rates.get(r.model.as_ref()).and_then(|x| x.as_ref().ok());
        whole.add(r, rate, cx.now_ms);
        let owner = r.cwd.as_deref().and_then(|cwd| {
            order.iter().copied().find(|&i| {
                cx.owners[i]
                    .repo
                    .is_some_and(|repo| Path::new(cwd).starts_with(repo))
            })
        });
        let Some(i) = owner else {
            let place = r
                .cwd
                .as_deref()
                .map(str::to_string)
                .unwrap_or_else(|| format!("no cwd, written to {}", r.file.display()));
            unattributed
                .entry(place)
                .or_default()
                .add(r, rate, cx.now_ms);
            continue;
        };
        let p = &mut projects[i];
        p.total.add(r, rate, cx.now_ms);
        if let Master::Conversation { id, share } = &mut p.master {
            if is_lead_transcript(&r.file, cx.root, id) {
                share.add(r, rate, cx.now_ms);
            }
        }
    }
    let mut unattributed: Vec<(String, Share)> = unattributed.into_iter().collect();
    unattributed.sort_by(|a, b| a.0.cmp(&b.0));
    Totals {
        at_ms: cx.now_ms,
        root: cx.root.to_path_buf(),
        files: cx.files,
        projects,
        unattributed,
        whole,
        bad_rates: cx
            .rates
            .iter()
            .filter_map(|(m, r)| r.as_ref().err().map(|why| (m.clone(), why.clone())))
            .collect(),
        rates_unread: cx.rates_unread,
        unreadable: cx.unreadable,
        bad: cx.bad,
        unkeyed: cx.unkeyed,
    }
}

/// Whether `file` is the conversation `id`'s own transcript, directly under a
/// directory of `root`, rather than a subagent's under it.
fn is_lead_transcript(file: &Path, root: &Path, id: &str) -> bool {
    file.file_stem().is_some_and(|s| s == id) && file.parent().and_then(Path::parent) == Some(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const NOW: i64 = 1_790_985_600_000;

    fn resp(at_ms: i64, cwd: Option<&str>, file: &str, model: &str, tokens: [u64; 4]) -> Response {
        Response {
            at_ms,
            model: Arc::from(model),
            cwd: cwd.map(Arc::from),
            file: Arc::from(Path::new(file)),
            tokens,
        }
    }

    fn table(src: &str) -> toml::Table {
        src.parse().unwrap()
    }

    /// Criterion 7: a rate prices each kind of token per million; an entry
    /// missing a key, naming another, or not a number is refused by name.
    #[test]
    fn a_rate_prices_per_million_and_a_bad_one_says_why() {
        let r = rates(&table(
            "f = 3\n\
             [a]\ninput = 3\noutput = 15\ncache_write = 3.75\ncache_read = 0.3\n\
             [b]\ninput = 3\noutput = 15\ncache_write = 3.75\n\
             [c]\ninput = 3\noutput = 15\ncache_write = 3.75\ncache_read = 0.3\ncache_read_1h = 1\n\
             [d]\ninput = \"3\"\noutput = 15\ncache_write = 3.75\ncache_read = 0.3\n\
             [e]\ninput = -1\noutput = 15\ncache_write = 3.75\ncache_read = 0.3\n",
        ));
        assert_eq!(
            r["a"],
            Ok(Rate {
                per_million: [3.0, 15.0, 3.75, 0.3]
            })
        );
        assert_eq!(r["b"], Err("has no cache_read".into()));
        assert!(r["c"].as_ref().unwrap_err().contains("names cache_read_1h"));
        assert_eq!(r["d"], Err("input is a string, not a number".into()));
        assert!(r["e"].as_ref().unwrap_err().contains("input is -1"));
        assert!(r["f"].as_ref().unwrap_err().contains("not a table"));
    }

    /// Criteria 2, 3, 5, 6, 7 and 8 over the proof fixture's shapes.
    #[test]
    fn responses_are_summed_by_checkout_window_and_rate() {
        let root = Path::new("/h/.claude/projects");
        let m = 1_000_000;
        let (h, d) = (3_600_000, DAY_MS);
        let all = [
            resp(
                NOW - h,
                Some("/repos/alpha"),
                "/h/.claude/projects/-a/conv-a.jsonl",
                "model-a",
                [m, m, 2 * m, 10 * m],
            ),
            resp(
                NOW - 3 * d,
                Some("/repos/alpha/sub"),
                "/h/.claude/projects/-a/conv-a.jsonl",
                "model-a",
                [2 * m, 0, 0, 0],
            ),
            resp(
                NOW - 8 * d,
                Some("/repos/alpha"),
                "/h/.claude/projects/-a/conv-a.jsonl",
                "model-a",
                [7, 0, 0, 0],
            ),
            resp(
                NOW - 2 * h,
                Some("/repos/alpha/.claude/worktrees/x"),
                "/h/.claude/projects/-a/conv-a/subagents/agent-1.jsonl",
                "model-b",
                [3_000, 30_000, 0, 0],
            ),
            resp(
                NOW - h,
                Some("/repos/alpha-two"),
                "/h/.claude/projects/-b/j.jsonl",
                "model-a",
                [m, 0, 0, 0],
            ),
            resp(
                NOW - h,
                Some("/repos/alpha/nested"),
                "/h/.claude/projects/-n/j.jsonl",
                "model-a",
                [m, 0, 0, 0],
            ),
            resp(
                NOW - h,
                None,
                "/h/.claude/projects/-c/x.jsonl",
                "model-a",
                [m, 0, 0, 0],
            ),
        ];
        let owners = [
            Owner {
                key: "alpha",
                repo: Some(Path::new("/repos/alpha")),
                master: Some(Some("conv-a")),
            },
            Owner {
                key: "nested",
                repo: Some(Path::new("/repos/alpha/nested")),
                master: Some(None),
            },
            Owner {
                key: "gone",
                repo: None,
                master: None,
            },
        ];
        let rates = rates(&table(
            "[model-a]\ninput = 3\noutput = 15\ncache_write = 3.75\ncache_read = 0.3\n",
        ));
        let t = totals(
            all.iter(),
            Context {
                root,
                now_ms: NOW,
                files: 4,
                owners: &owners,
                rates: &rates,
                rates_unread: None,
                unreadable: vec![],
                bad: 0,
                unkeyed: 0,
            },
        );
        let alpha = &t.projects[0];
        assert_eq!(
            alpha.total.day.tokens,
            [m + 3_000, m + 30_000, 2 * m, 10 * m]
        );
        assert!(
            (alpha.total.day.cost - 28.5).abs() < 1e-9,
            "{}",
            alpha.total.day.cost
        );
        assert_eq!(alpha.total.day.unpriced["model-b"], 33_000);
        assert_eq!(
            alpha.total.week.tokens[0],
            3 * m + 3_000,
            "8 days old is out"
        );
        let Master::Conversation { share, .. } = &alpha.master else {
            panic!()
        };
        assert_eq!(
            share.week.tokens[0],
            3 * m,
            "the subagent is not the master's own"
        );
        assert!(share.day.unpriced.is_empty());
        assert_eq!(
            t.projects[1].total.day.tokens[0], m,
            "the nested checkout takes its own"
        );
        assert_eq!(t.projects[1].master, Master::NoneRecorded);
        assert_eq!(t.projects[2].master, Master::Unknown);
        assert!(t.projects[2].total.week.is_empty());
        let places: Vec<&str> = t.unattributed.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(
            places,
            vec![
                "/repos/alpha-two",
                "no cwd, written to /h/.claude/projects/-c/x.jsonl"
            ],
            "a sibling whose name starts like a checkout is not inside it"
        );
        assert_eq!(t.whole.day.tokens[0], 4 * m + 3_000);
    }

    /// Criterion 2: the master's share is its own transcript directly under
    /// a project directory of the root, never a file below it that happens
    /// to carry the conversation's name.
    #[test]
    fn the_masters_share_is_its_lead_transcript_alone() {
        let root = Path::new("/h/.claude/projects");
        let all = [
            resp(
                NOW - 1,
                Some("/r"),
                "/h/.claude/projects/-r/conv.jsonl",
                "a",
                [1, 0, 0, 0],
            ),
            resp(
                NOW - 1,
                Some("/r"),
                "/h/.claude/projects/-r/conv/subagents/conv.jsonl",
                "a",
                [10, 0, 0, 0],
            ),
            resp(
                NOW - 1,
                Some("/r"),
                "/elsewhere/-r/conv.jsonl",
                "a",
                [100, 0, 0, 0],
            ),
        ];
        let owners = [Owner {
            key: "r",
            repo: Some(Path::new("/r")),
            master: Some(Some("conv")),
        }];
        let rates = BTreeMap::new();
        let t = totals(
            all.iter(),
            Context {
                root,
                now_ms: NOW,
                files: 3,
                owners: &owners,
                rates: &rates,
                rates_unread: None,
                unreadable: vec![],
                bad: 0,
                unkeyed: 0,
            },
        );
        let Master::Conversation { share, .. } = &t.projects[0].master else {
            panic!()
        };
        assert_eq!(share.day.tokens[0], 1);
        assert_eq!(t.projects[0].total.day.tokens[0], 111);
    }
}
