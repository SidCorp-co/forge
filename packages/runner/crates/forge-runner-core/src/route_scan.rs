//! The scan behind `config::tests::every_other_resolution_of_the_config_dir_is_a_counted_reader`
//! (ISS-1344): every route to a directory the OS names for the user, counted where it happens.
//!
//! It reads tokens rather than lines, so a comment is no route, a second route on a line counts,
//! and spacing cannot hide one. A read of a variable is counted at its call site, whatever names
//! the variable: a literal, a `concat!` of literals, a `const`, or anything the scan cannot resolve,
//! which counts as a route because it may be one. A name a `use` binds to a route counts wherever it
//! is used, and a glob import from a route module is refused by name, since the scan cannot tell
//! which of its names a file calls.

use proc_macro2::{Delimiter, Spacing, TokenStream, TokenTree};
use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

/// One route, where it stands and what it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Hit {
    pub line: usize,
    pub what: String,
}

/// What a file's `use` items bind. Built before any route is counted, because a `use` may stand
/// below the code that uses its names.
#[derive(Default, Clone, PartialEq)]
struct Bindings {
    /// A name for the `dirs_next` crate itself: `d` in `use dirs_next as d`.
    dirs_modules: BTreeSet<String>,
    /// A name bound to an item of `dirs_next`: `config_dir`, or `cd` in `.. as cd`.
    dirs_items: BTreeSet<String>,
    /// A name for `std::env`: `e` in `use std::env as e`.
    env_modules: BTreeSet<String>,
    /// A name bound to one of `std::env`'s readers.
    env_reads: BTreeSet<String>,
    /// A name for the runner's `Config`.
    configs: BTreeSet<String>,
    /// Every name a `use` binds, so a bare name it brought in resolves through any `const` of
    /// that name rather than counting as unknown.
    imported: BTreeSet<String>,
    /// The path each name a `use` binds stands for, so a `use` through it is read as that path.
    /// Every path, since a file's modules may each bind the same name to a different one.
    aliases: BTreeMap<String, BTreeSet<Vec<String>>>,
    /// A `macro_rules!` that builds a path from a metavariable, by name.
    assembling: BTreeSet<String>,
    /// What the scan refuses outright: a glob import from a route module, and a macro that
    /// assembles a path, neither of which it can see through.
    refused: Vec<Hit>,
}

impl Bindings {
    /// How many names each route kind is bound to, to tell whether one `use` bound a route.
    fn route_names(&self) -> [usize; 5] {
        [
            self.dirs_modules.len(),
            self.dirs_items.len(),
            self.env_modules.len(),
            self.env_reads.len(),
            self.configs.len(),
        ]
    }
}

/// The value a `const` or `static` is defined with, by name, across every file scanned.
pub(crate) type Consts = BTreeMap<String, Vec<Option<String>>>;

const READERS: [&str; 4] = ["var", "var_os", "vars", "vars_os"];
const SETTERS: [&str; 6] = ["set", "unset", "set_var", "remove_var", "env", "env_remove"];

/// The variables a route reads. One literal, so this file's own needles are no route.
fn variables() -> Vec<&'static str> {
    "XDG_CONFIG_HOME XDG_DATA_HOME HOME USERPROFILE"
        .split(' ')
        .collect()
}

/// Spellings that name a per-user directory on some platform, wherever a literal or an
/// identifier holds them. Each is split by `·` so that this list is not one of them.
fn platform_names() -> Vec<String> {
    "APP·DATA|Roaming·AppData|Application· Support"
        .split('|')
        .map(|s| s.replace('·', ""))
        .collect()
}

pub(crate) fn lex(src: &str, file: &str) -> Vec<TokenTree> {
    TokenStream::from_str(src)
        .unwrap_or_else(|e| panic!("{file} does not lex, so it cannot be scanned: {e}"))
        .into_iter()
        .collect()
}

/// Every `const` and `static` in `tokens`, at any depth, with the value it is defined with. The
/// table a qualified or imported name resolves through, by its last identifier: every definition
/// of that name in either crate, so one that is a route, or one the scan cannot read, counts.
/// What one file adds to the table every qualified or imported name resolves through: its
/// `const`s and `static`s, and each name a `use` renames, as a definition that is the path it
/// renames. A const elsewhere that names `KEY` then resolves through `HOME_KEY` too where any
/// file has `use keys::HOME_KEY as KEY`, rather than through an unrelated `KEY` alone.
pub(crate) fn collect_file(tokens: &[TokenTree], into: &mut Consts) {
    collect_consts(tokens, into);
    for (name, paths) in bindings(tokens).aliases {
        for path in paths {
            if path.last() != Some(&name) {
                into.entry(name.clone())
                    .or_default()
                    .push(Some(format!("\u{0}{}", path.join("::"))));
            }
        }
    }
}

fn collect_consts(tokens: &[TokenTree], into: &mut Consts) {
    for t in tokens {
        if let TokenTree::Group(g) = t {
            collect_consts(&g.stream().into_iter().collect::<Vec<_>>(), into);
        }
    }
    for (name, defs) in consts_at(tokens) {
        into.entry(name).or_default().extend(defs);
    }
}

/// The `const`s and `static`s defined directly in `tokens`, not inside a group of them, with the
/// value each is defined with: a literal, a `concat!` of literals or the name of another; `None`
/// for any other.
fn consts_at(tokens: &[TokenTree]) -> Consts {
    let mut into = Consts::new();
    let mut i = 0;
    while i < tokens.len() {
        if (is_ident(&tokens[i], "const") || is_ident(&tokens[i], "static"))
            && matches!(tokens.get(i + 1), Some(TokenTree::Ident(_)))
        {
            let mut at = i + 1;
            if is_ident(&tokens[at], "mut") {
                at += 1;
            }
            let Some(TokenTree::Ident(name)) = tokens.get(at) else {
                i += 1;
                continue;
            };
            let Some(eq) = (at..tokens.len()).find(|&k| is_punct(&tokens[k], '=')) else {
                i += 1;
                continue;
            };
            let end = (eq..tokens.len())
                .find(|&k| is_punct(&tokens[k], ';'))
                .unwrap_or(tokens.len());
            let value = &tokens[eq + 1..end];
            let v = folded(value).or_else(|| path_text(value).map(|n| format!("\u{0}{n}")));
            into.entry(name.to_string()).or_default().push(v);
            i = end;
        }
        i += 1;
    }
    into
}

/// The literal values `name` may hold, following one const through another however long the
/// chain; `None` where any definition of it is not one the scan can read, or the chain comes back
/// to a name it is already following. `chain` holds the names being followed.
fn resolve(consts: &Consts, name: &str, chain: &mut Vec<String>) -> Option<Vec<String>> {
    let key = format!("global {name}");
    if chain.contains(&key) {
        return None;
    }
    let defs = consts.get(name)?;
    chain.push(key);
    let mut out = Some(Vec::new());
    for d in defs {
        let got = match d.as_deref() {
            Some(v) if v.starts_with('\u{0}') => {
                let name = v[1..].rsplit_once("::").map_or(&v[1..], |(_, last)| last);
                resolve(consts, name, chain)
            }
            Some(v) => Some(vec![v.to_string()]),
            None => None,
        };
        match (&mut out, got) {
            (Some(all), Some(vals)) => all.extend(vals),
            _ => out = None,
        }
    }
    chain.pop();
    out
}

/// What one file holds: its routes, and what the scan refuses outright because it cannot see
/// through it, which no allowance admits.
#[derive(Debug)]
pub(crate) struct Scanned {
    pub routes: Vec<Hit>,
    pub refused: Vec<Hit>,
}

/// Every route in one file. `in_config` is `config.rs`, whose `Self::path()` is `Config::path()`.
pub(crate) fn routes(tokens: &[TokenTree], consts: &Consts, in_config: bool) -> Scanned {
    let b = bindings(tokens);
    let mut hits = Vec::new();
    let scan = Scan {
        b: &b,
        consts,
        in_config,
        variables: variables(),
        platform: platform_names(),
    };
    let mut stack = vec![Frame {
        module: true,
        consts: consts_at(tokens),
    }];
    scan.walk(tokens, false, &mut hits, &mut stack);
    hits.sort_by_key(|h| h.line);
    Scanned {
        routes: hits,
        refused: b.refused,
    }
}

/// The `const`s one level of a file defines, and whether that level opens a module, past which a
/// name the module does not import is not in scope.
#[derive(Clone)]
struct Frame {
    module: bool,
    consts: Consts,
}

/// What a brace group's header says it opens.
enum Opens {
    Module,
    /// An `impl` or `trait` body, whose `const`s are reached as `Self::NAME`, never bare.
    Associated,
    Block,
}

/// The item a brace group at `tokens[i]` is the body of, read back to the previous item's end.
fn opens(tokens: &[TokenTree], i: usize) -> Opens {
    let start = tokens[..i]
        .iter()
        .rposition(|t| {
            is_punct(t, ';')
                || matches!(t, TokenTree::Group(g) if g.delimiter() == Delimiter::Brace)
        })
        .map_or(0, |k| k + 1);
    let header = &tokens[start..i];
    let has = |w: &str| header.iter().any(|t| is_ident(t, w));
    if has("mod") {
        Opens::Module
    } else if has("fn") {
        Opens::Block
    } else if has("impl") || has("trait") {
        Opens::Associated
    } else {
        Opens::Block
    }
}

/// Whether a module body imports everything of its parent, `use super::*`.
fn imports_its_parent(tokens: &[TokenTree]) -> bool {
    tokens.windows(5).any(|w| {
        is_ident(&w[0], "use")
            && is_ident(&w[1], "super")
            && is_path_sep(w, 2)
            && is_punct(&w[4], '*')
    })
}

struct Scan<'a> {
    b: &'a Bindings,
    consts: &'a Consts,
    in_config: bool,
    variables: Vec<&'static str>,
    platform: Vec<String>,
}

impl Scan<'_> {
    /// `handed_to_a_setter`: `tokens` are the arguments of a call that sets or removes a
    /// variable, so the name it is handed first scopes the variable rather than reading it.
    fn walk(
        &self,
        tokens: &[TokenTree],
        handed_to_a_setter: bool,
        hits: &mut Vec<Hit>,
        stack: &mut Vec<Frame>,
    ) {
        let mut i = 0;
        while i < tokens.len() {
            let t = &tokens[i];
            let first = i == 0 && handed_to_a_setter;
            // A doc comment is the lexer's `#[doc = ".."]`; no doctest runs (the manifests and
            // the library's own refusal), so it is prose.
            if is_punct(t, '#') {
                let at = if tokens.get(i + 1).is_some_and(|n| is_punct(n, '!')) {
                    i + 2
                } else {
                    i + 1
                };
                if let Some(TokenTree::Group(g)) = tokens.get(at) {
                    if g.delimiter() == Delimiter::Bracket
                        && g.stream()
                            .into_iter()
                            .next()
                            .is_some_and(|f| is_ident(&f, "doc"))
                    {
                        i = at + 1;
                        continue;
                    }
                }
            }
            if is_ident(t, "use") {
                let end = (i..tokens.len())
                    .find(|&k| is_punct(&tokens[k], ';'))
                    .unwrap_or(tokens.len());
                self.idents_only(&tokens[i..end], hits);
                i = end + 1;
                continue;
            }
            if is_ident(t, "concat") && tokens.get(i + 1).is_some_and(|n| is_punct(n, '!')) {
                if let Some(TokenTree::Group(g)) = tokens.get(i + 2) {
                    let inner: Vec<TokenTree> = g.stream().into_iter().collect();
                    if let Some(v) = folded_concat(&inner) {
                        if !first {
                            self.literal(&v, line_of(t), hits);
                        }
                        i += 3;
                        continue;
                    }
                }
            }
            match t {
                TokenTree::Literal(l) => {
                    if let Some(v) = unquote(&l.to_string()) {
                        if !first {
                            self.literal(&v, line_of(t), hits);
                        }
                    }
                }
                TokenTree::Ident(id) => {
                    let name = id.to_string();
                    self.ident(&name, tokens, i, hits, stack);
                }
                TokenTree::Group(g) => {
                    let inner: Vec<TokenTree> = g.stream().into_iter().collect();
                    let setter =
                        g.delimiter() == Delimiter::Parenthesis && is_setter_call(tokens, i);
                    let opened = if g.delimiter() == Delimiter::Brace {
                        opens(tokens, i)
                    } else {
                        Opens::Block
                    };
                    match opened {
                        Opens::Module => {
                            let from = stack.iter().rposition(|f| f.module).unwrap_or(0);
                            let mut inner_stack = if imports_its_parent(&inner) {
                                stack[from..].to_vec()
                            } else {
                                Vec::new()
                            };
                            inner_stack.push(Frame {
                                module: true,
                                consts: consts_at(&inner),
                            });
                            self.walk(&inner, setter, hits, &mut inner_stack);
                        }
                        Opens::Associated | Opens::Block => {
                            let consts = match opened {
                                Opens::Associated => Consts::new(),
                                _ => consts_at(&inner),
                            };
                            stack.push(Frame {
                                module: false,
                                consts,
                            });
                            self.walk(&inner, setter, hits, stack);
                            stack.pop();
                        }
                    }
                }
                TokenTree::Punct(_) => {}
            }
            i += 1;
        }
    }

    fn literal(&self, v: &str, line: usize, hits: &mut Vec<Hit>) {
        if self.variables.contains(&v) {
            hits.push(Hit {
                line,
                what: format!("the variable name {v:?}"),
            });
        }
        if v == ".·config".replace('·', "") {
            hits.push(Hit {
                line,
                what: "a hand-built config dir".into(),
            });
        }
        for p in &self.platform {
            for _ in v.matches(p.as_str()) {
                hits.push(Hit {
                    line,
                    what: format!("{p:?} in a literal"),
                });
            }
        }
    }

    fn ident(
        &self,
        name: &str,
        tokens: &[TokenTree],
        i: usize,
        hits: &mut Vec<Hit>,
        stack: &[Frame],
    ) {
        let line = line_of(&tokens[i]);
        let mut hit = |what: String| hits.push(Hit { line, what });
        let qualified = i >= 1 && (is_punct(&tokens[i - 1], '.') || path_sep_before(tokens, i));
        if name == "dirs_next" {
            hit("the dirs_next crate".into());
        } else if name == "home_dir" && !self.guarded_home(tokens, i, qualified) {
            hit("home_dir".into());
        } else if name == "getenv" {
            hit("getenv, a read of any variable".into());
        } else if self.b.dirs_modules.contains(name) && path_sep_after(tokens, i) {
            hit(format!("{name}, the dirs_next crate by another name"));
        } else if self.b.dirs_items.contains(name) && !qualified {
            hit(format!("{name}, imported from dirs_next"));
        }
        if self.b.assembling.contains(name) && tokens.get(i + 1).is_some_and(|t| is_punct(t, '!')) {
            hit(format!(
                "{name}!, a macro that builds a path from a metavariable"
            ));
        }
        for p in &self.platform {
            for _ in name.matches(p.as_str()) {
                hit(format!("{p:?} in an identifier"));
            }
        }
        // `Config::path`, called or taken as a value, `<Config>::path` included.
        let config =
            name == "Config" || self.b.configs.contains(name) || (self.in_config && name == "Self");
        if config {
            let mut at = i + 1;
            if tokens.get(at).is_some_and(|t| is_punct(t, '>')) {
                at += 1;
            }
            if is_path_sep(tokens, at) && tokens.get(at + 2).is_some_and(|t| is_ident(t, "path")) {
                hit(format!("{name}::path"));
            }
        }
        // A read of the environment, at its call site.
        let module = name == "env" || self.b.env_modules.contains(name);
        if module && is_path_sep(tokens, i + 1) {
            if let Some(TokenTree::Ident(f)) = tokens.get(i + 3) {
                let f = f.to_string();
                if READERS.contains(&f.as_str()) {
                    if let Some(why) = self.read_at(tokens, i + 3, stack) {
                        hit(format!("{name}::{f} {why}"));
                    }
                }
            }
        }
        if (name == "env" || name == "option_env")
            && tokens.get(i + 1).is_some_and(|t| is_punct(t, '!'))
        {
            if let Some(why) = self.read_at(tokens, i + 1, stack) {
                hit(format!("{name}! {why}"));
            }
        }
        // Through a path too (`readers::get`), never as a method (`.get`).
        let a_method = i >= 1 && is_punct(&tokens[i - 1], '.');
        if self.b.env_reads.contains(name) && !a_method {
            if let Some(why) = self.read_at(tokens, i, stack) {
                hit(format!("{name}, a reader imported from std::env, {why}"));
            }
        }
    }

    /// Whether the `home_dir` at `tokens[i]` is `config::home_dir`, the guarded route itself:
    /// spelled `config::home_dir`, or unqualified inside config.rs.
    fn guarded_home(&self, tokens: &[TokenTree], i: usize, qualified: bool) -> bool {
        if !qualified {
            return self.in_config;
        }
        path_sep_before(tokens, i) && tokens.get(i - 3).is_some_and(|t| is_ident(t, "config"))
    }

    /// Whether the reader at `tokens[at]` reads a route, and how: `None` where its argument is a
    /// literal (counted as a literal) or names a variable no route reads.
    fn read_at(&self, tokens: &[TokenTree], at: usize, stack: &[Frame]) -> Option<String> {
        let Some(TokenTree::Group(g)) = tokens.get(at + 1) else {
            return Some("taken as a value, so what it reads is not known here".into());
        };
        if g.delimiter() != Delimiter::Parenthesis {
            return Some("taken as a value, so what it reads is not known here".into());
        }
        let args: Vec<TokenTree> = g.stream().into_iter().collect();
        if args.is_empty() {
            return Some("reads every variable".into());
        }
        if folded(&args).is_some() {
            return None;
        }
        if let Some(n) = path_name(&args) {
            let qualified = (0..args.len()).any(|k| is_path_sep(&args, k));
            return match self.value_of(&n, qualified, stack, &mut Vec::new()) {
                Some(vals) if vals.iter().any(|v| self.variables.contains(&v.as_str())) => {
                    Some(format!("reads {vals:?} through {n}"))
                }
                Some(_) => None,
                None => Some(format!("reads {n}, which the scan cannot resolve")),
            };
        }
        Some("reads a name the scan cannot resolve".into())
    }

    /// The literal values the name `n` may hold where it is read: through the `const` of that name
    /// in scope there for a bare name, or through every definition of it in either crate for a
    /// qualified or imported one. `None` where it holds anything else, or nothing names it: a bare
    /// name no `const` in scope defines is a local, whatever it is called.
    fn value_of(
        &self,
        n: &str,
        qualified: bool,
        stack: &[Frame],
        chain: &mut Vec<String>,
    ) -> Option<Vec<String>> {
        // The frame that defines `n`, and with it the scope its own definition is read in: a
        // bare name inside it names what is in scope there, not at the read.
        let found = if qualified {
            None
        } else {
            stack
                .iter()
                .enumerate()
                .rev()
                .find_map(|(k, f)| f.consts.get(n).map(|defs| (k, defs)))
        };
        let Some((at, defs)) = found else {
            // An imported name resolves through the name it was imported as, `KEY` in
            // `use keys::HOME_KEY as KEY` through `HOME_KEY`.
            // A name two modules import from different places resolves through both.
            let originals: Vec<&String> = self
                .b
                .aliases
                .get(n)
                .into_iter()
                .flatten()
                .filter_map(|p| p.last())
                .collect();
            return if !qualified && !originals.is_empty() {
                let mut all = Vec::new();
                for original in originals {
                    all.extend(resolve(self.consts, original, chain)?);
                }
                Some(all)
            } else if qualified || self.b.imported.contains(n) {
                resolve(self.consts, n, chain)
            } else {
                None
            };
        };
        let key = format!("in scope {at} {n}");
        if chain.contains(&key) {
            return None;
        }
        chain.push(key);
        let mut out = Some(Vec::new());
        for d in defs {
            let got = match d.as_deref() {
                // A qualified reference names its own module's const, never the one in scope here.
                Some(v) if v.starts_with('\u{0}') => match v[1..].rsplit_once("::") {
                    Some((_, last)) => resolve(self.consts, last, chain),
                    None => self.value_of(&v[1..], false, &stack[..=at], chain),
                },
                Some(v) => Some(vec![v.to_string()]),
                None => None,
            };
            match (&mut out, got) {
                (Some(all), Some(vals)) => all.extend(vals),
                _ => out = None,
            }
        }
        chain.pop();
        out
    }

    /// Inside a `use`: the identifiers that are routes wherever they stand, and nothing it binds.
    fn idents_only(&self, tokens: &[TokenTree], hits: &mut Vec<Hit>) {
        for t in tokens {
            match t {
                TokenTree::Ident(id) => {
                    let n = id.to_string();
                    if n == "dirs_next" || n == "home_dir" || n == "getenv" {
                        hits.push(Hit {
                            line: line_of(t),
                            what: format!("{n} in a use"),
                        });
                    }
                }
                TokenTree::Group(g) => {
                    self.idents_only(&g.stream().into_iter().collect::<Vec<_>>(), hits)
                }
                _ => {}
            }
        }
    }
}

/// What a file's `use` and `extern crate` items bind, read until a pass learns nothing new, so an
/// import through another's alias resolves in whichever order the two stand.
fn bindings(tokens: &[TokenTree]) -> Bindings {
    let mut known = Bindings::default();
    // `expanded` follows an alias chain to its end, so a pass settles every import whose chain
    // the pass before recorded; this bound is a guard, and a file that meets it is refused.
    for _ in 0..64 {
        let mut b = Bindings::default();
        collect_bindings(tokens, &mut b, &known);
        if b == known {
            return known;
        }
        known = b;
    }
    known.refused.push(Hit {
        line: tokens.first().map_or(0, line_of),
        what: "imports the scan could not settle in 64 passes: name each import's own path".into(),
    });
    known
}

/// What every `use` and `extern crate` in `tokens` binds, at any depth, reading a path that opens
/// with an alias `known` holds as the path it stands for.
fn collect_bindings(tokens: &[TokenTree], b: &mut Bindings, known: &Bindings) {
    let mut i = 0;
    while i < tokens.len() {
        if let TokenTree::Group(g) = &tokens[i] {
            collect_bindings(&g.stream().into_iter().collect::<Vec<_>>(), b, known);
        }
        if is_ident(&tokens[i], "macro_rules")
            && tokens.get(i + 1).is_some_and(|t| is_punct(t, '!'))
        {
            if let (Some(TokenTree::Ident(name)), Some(TokenTree::Group(body))) =
                (tokens.get(i + 2), tokens.get(i + 3))
            {
                if assembles_a_path(&body.stream().into_iter().collect::<Vec<_>>()) {
                    b.assembling.insert(name.to_string());
                    b.refused.push(Hit {
                        line: line_of(&tokens[i]),
                        what: format!(
                            "macro_rules! {name} builds a path from a metavariable, so what it calls \
                             is not known here: spell the path at the call site"
                        ),
                    });
                }
            }
        }
        if is_ident(&tokens[i], "use") {
            let end = (i..tokens.len())
                .find(|&k| is_punct(&tokens[k], ';'))
                .unwrap_or(tokens.len());
            use_tree(&tokens[i + 1..end], &[], b, known, line_of(&tokens[i]));
            let public = i >= 1
                && (is_ident(&tokens[i - 1], "pub")
                    || (i >= 2
                        && is_ident(&tokens[i - 2], "pub")
                        && matches!(&tokens[i - 1], TokenTree::Group(g) if g.delimiter() == Delimiter::Parenthesis)));
            // What this import binds on its own: a name an earlier import already bound to a
            // route adds nothing to `b`, and is re-exported all the same.
            let mut own = Bindings::default();
            if public {
                use_tree(
                    &tokens[i + 1..end],
                    &[],
                    &mut own,
                    known,
                    line_of(&tokens[i]),
                );
            }
            if public && own.route_names() != [0; 5] {
                b.refused.push(Hit {
                    line: line_of(&tokens[i]),
                    what: "a re-export of a route, which hides every call through it from the \
                           file that makes it: import it where it is called"
                        .into(),
                });
            }
            i = end;
        } else if is_ident(&tokens[i], "extern")
            && tokens.get(i + 1).is_some_and(|t| is_ident(t, "crate"))
        {
            let end = (i..tokens.len())
                .find(|&k| is_punct(&tokens[k], ';'))
                .unwrap_or(tokens.len());
            let item: Vec<String> = tokens[i + 2..end].iter().map(|t| t.to_string()).collect();
            if let [krate, r#as, alias] = item.as_slice() {
                if r#as == "as" {
                    bind(std::slice::from_ref(krate), alias, b);
                }
            }
            i = end;
        }
        i += 1;
    }
}

/// Whether a macro body puts a metavariable other than `$crate` beside a `::`, at any depth.
fn assembles_a_path(tokens: &[TokenTree]) -> bool {
    tokens.iter().enumerate().any(|(i, t)| match t {
        TokenTree::Group(g) => assembles_a_path(&g.stream().into_iter().collect::<Vec<_>>()),
        _ => {
            is_punct(t, '$')
                && matches!(tokens.get(i + 1), Some(TokenTree::Ident(v)) if v != "crate")
                && (is_path_sep(tokens, i + 2) || path_sep_before(tokens, i))
        }
    })
}

/// One `use` tree under `prefix`.
fn use_tree(
    tokens: &[TokenTree],
    prefix: &[String],
    b: &mut Bindings,
    known: &Bindings,
    line: usize,
) {
    let mut path = prefix.to_vec();
    let mut i = 0;
    while i < tokens.len() {
        match &tokens[i] {
            TokenTree::Ident(id) if id == "as" => {
                if let Some(TokenTree::Ident(alias)) = tokens.get(i + 1) {
                    for p in expanded(&path, known) {
                        bind(&p, &alias.to_string(), b);
                    }
                }
                return;
            }
            TokenTree::Ident(id) => path.push(id.to_string()),
            TokenTree::Punct(p) if p.as_char() == '*' => {
                let from = path.join("::");
                let route = expanded(&path, known).iter().any(|path| {
                    path.iter().any(|s| s == "dirs_next")
                        || path.ends_with(&["std".into(), "env".into()])
                        || path.last().is_some_and(|s| s == "config")
                });
                if route {
                    b.refused.push(Hit {
                        line,
                        what: format!(
                            "a glob import from {from}, which hides every route it brings in: name the items"
                        ),
                    });
                }
                return;
            }
            TokenTree::Group(g) if g.delimiter() == Delimiter::Brace => {
                let inner: Vec<TokenTree> = g.stream().into_iter().collect();
                for part in inner.split(|t| is_punct(t, ',')) {
                    use_tree(part, &path, b, known, line);
                }
                return;
            }
            _ => {}
        }
        i += 1;
    }
    if let Some(last) = path.last().cloned() {
        if last == "self" {
            let module: Vec<String> = path[..path.len() - 1].to_vec();
            if let Some(name) = module.last().cloned() {
                for p in expanded(&module, known) {
                    bind(&p, &name, b);
                }
            }
        } else {
            for p in expanded(&path, known) {
                bind(&p, &last, b);
            }
        }
    }
}

/// Every path `path` stands for, with an opening alias written out to the end of its chain and
/// each path an alias holds followed. An alias met twice on one chain is a cycle, left as it
/// stands, and `use build::build`, a function through a module of the same name in two
/// namespaces, is no alias of itself.
fn expanded(path: &[String], known: &Bindings) -> Vec<Vec<String>> {
    let mut done = BTreeSet::new();
    let mut todo = vec![(path.to_vec(), BTreeSet::new())];
    while let Some((out, followed)) = todo.pop() {
        let Some(first) = out.first().cloned() else {
            continue;
        };
        let next: Vec<&Vec<String>> = known
            .aliases
            .get(&first)
            .into_iter()
            .flatten()
            .filter(|stands_for| stands_for[0] != first)
            .collect();
        if next.is_empty() || followed.contains(&first) || done.len() + todo.len() > 256 {
            done.insert(out);
            continue;
        }
        for stands_for in next {
            let mut seen = followed.clone();
            seen.insert(first.clone());
            todo.push((stands_for.iter().chain(&out[1..]).cloned().collect(), seen));
        }
    }
    done.into_iter().collect()
}

/// `name` is bound to `path`.
fn bind(path: &[String], name: &str, b: &mut Bindings) {
    let path: Vec<&str> = path
        .iter()
        .map(String::as_str)
        .filter(|s| *s != "self")
        .collect();
    let Some(&last) = path.last() else {
        return;
    };
    b.imported.insert(name.to_string());
    b.aliases
        .entry(name.to_string())
        .or_default()
        .insert(path.iter().map(|s| s.to_string()).collect());
    if last == "dirs_next" {
        b.dirs_modules.insert(name.to_string());
    } else if path.contains(&"dirs_next") {
        b.dirs_items.insert(name.to_string());
    } else if last == "env" && path.len() >= 2 && path[path.len() - 2] == "std" {
        b.env_modules.insert(name.to_string());
    } else if READERS.contains(&last) && path.len() >= 2 && path[path.len() - 2] == "env" {
        b.env_reads.insert(name.to_string());
    } else if last == "Config" && name != "Config" {
        b.configs.insert(name.to_string());
    }
}

fn is_setter_call(tokens: &[TokenTree], group_at: usize) -> bool {
    if group_at < 2 {
        return false;
    }
    let TokenTree::Ident(f) = &tokens[group_at - 1] else {
        return false;
    };
    let f = f.to_string();
    if !SETTERS.contains(&f.as_str()) {
        return false;
    }
    // Anchored on the `.` or `::` before it, so `reset(` or `my_env_remove(` is no setter.
    let dotted = is_punct(&tokens[group_at - 2], '.');
    let pathed = path_sep_before(tokens, group_at - 1);
    match f.as_str() {
        "env" | "env_remove" => dotted,
        _ => pathed,
    }
}

/// The single value a run of tokens spells: one literal, or one `concat!` of literals.
fn folded(tokens: &[TokenTree]) -> Option<String> {
    match tokens {
        [TokenTree::Literal(l)] => unquote(&l.to_string()),
        [c, bang, TokenTree::Group(g)] if is_ident(c, "concat") && is_punct(bang, '!') => {
            folded_concat(&g.stream().into_iter().collect::<Vec<_>>())
        }
        _ => None,
    }
}

/// `concat!`'s arguments, joined, where every one is a literal or itself a foldable `concat!`.
fn folded_concat(args: &[TokenTree]) -> Option<String> {
    let mut out = String::new();
    for part in args.split(|t| is_punct(t, ',')) {
        if part.is_empty() {
            continue;
        }
        out.push_str(&folded(part)?);
    }
    Some(out)
}

/// A path such as `A`, `m::A` or `Self::A` as written, segments joined by `::`.
fn path_text(tokens: &[TokenTree]) -> Option<String> {
    path_name(tokens)?;
    let segments: Vec<String> = tokens
        .iter()
        .filter_map(|t| match t {
            TokenTree::Ident(id) => Some(id.to_string()),
            _ => None,
        })
        .collect();
    Some(segments.join("::"))
}

/// The last identifier of a path such as `A`, `m::A` or `Self::A`.
fn path_name(tokens: &[TokenTree]) -> Option<String> {
    let mut last = None;
    let mut i = 0;
    while i < tokens.len() {
        match &tokens[i] {
            TokenTree::Ident(id) => last = Some(id.to_string()),
            _ if is_path_sep(tokens, i) => i += 1,
            TokenTree::Punct(p) if p.as_char() == '&' => {}
            _ => return None,
        }
        i += 1;
    }
    last
}

/// A string literal's value, or `None` for any other literal.
pub(crate) fn unquote(lit: &str) -> Option<String> {
    let body = lit.trim_start_matches(['b', 'c']);
    if let Some(raw) = body.strip_prefix('r') {
        let hashes = raw.len() - raw.trim_start_matches('#').len();
        let inner = raw.get(hashes + 1..raw.len().checked_sub(hashes + 1)?)?;
        return Some(inner.to_string());
    }
    let inner = body.strip_prefix('"')?.rsplit_once('"')?.0;
    let mut out = String::new();
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next()? {
            'n' => out.push('\n'),
            't' => out.push('\t'),
            'r' => out.push('\r'),
            '0' => out.push('\0'),
            c @ ('\\' | '"' | '\'') => out.push(c),
            'x' => {
                let hex: String = [chars.next()?, chars.next()?].iter().collect();
                out.push(char::from(u8::from_str_radix(&hex, 16).ok()?));
            }
            'u' => {
                if chars.next()? != '{' {
                    return None;
                }
                let hex: String = chars.by_ref().take_while(|&c| c != '}').collect();
                out.push(char::from_u32(
                    u32::from_str_radix(&hex.replace('_', ""), 16).ok()?,
                )?);
            }
            '\n' => {
                while chars.peek().is_some_and(|c| c.is_whitespace()) {
                    chars.next();
                }
            }
            // An escape the scan does not know is no value it can vouch for.
            _ => return None,
        }
    }
    Some(out)
}

fn is_ident(t: &TokenTree, name: &str) -> bool {
    matches!(t, TokenTree::Ident(id) if id == name)
}

fn is_punct(t: &TokenTree, c: char) -> bool {
    matches!(t, TokenTree::Punct(p) if p.as_char() == c)
}

/// `tokens[at..]` opens with `::`.
fn is_path_sep(tokens: &[TokenTree], at: usize) -> bool {
    matches!(tokens.get(at), Some(TokenTree::Punct(p)) if p.as_char() == ':' && p.spacing() == Spacing::Joint)
        && tokens.get(at + 1).is_some_and(|t| is_punct(t, ':'))
}

fn path_sep_after(tokens: &[TokenTree], i: usize) -> bool {
    is_path_sep(tokens, i + 1)
}

fn path_sep_before(tokens: &[TokenTree], i: usize) -> bool {
    i >= 2 && is_path_sep(tokens, i - 2)
}

fn line_of(t: &TokenTree) -> usize {
    t.span().start().line
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scanned(src: &str) -> Scanned {
        let tokens = lex(src, "a fixture");
        let mut consts = Consts::new();
        collect_file(&tokens, &mut consts);
        routes(&tokens, &consts, false)
    }

    #[track_caller]
    fn counts(src: &str, want: usize) {
        let s = scanned(src);
        assert!(s.refused.is_empty(), "{src}\n{:#?}", s.refused);
        assert_eq!(s.routes.len(), want, "{src}\n{:#?}", s.routes);
    }

    /// Judge j5's G1-G4 at edc8778, each of which the line scan let through.
    #[test]
    fn a_read_is_counted_where_it_happens_whatever_names_the_variable() {
        let through_a_const = r#"const DATA_HOME: &str = "XDG_DATA_HOME";
            fn a() { std::env::var_os(DATA_HOME); }"#;
        counts(through_a_const, 2);
        let one_more = r#"const DATA_HOME: &str = "XDG_DATA_HOME";
            fn a() { std::env::var_os(DATA_HOME); }
            pub fn raw_data_home() -> Option<PathBuf> { std::env::var_os(DATA_HOME).map(PathBuf::from) }"#;
        counts(one_more, 3);
        counts(r#"fn a() { std::env::var_os(concat!("HO", "ME")); }"#, 1);
        counts(
            r#"fn a() { let _ = std::env::var(concat!("XDG_CONFIG_", "HOME")); }"#,
            1,
        );
        counts("fn a() { let f = Config::path; f(); }", 1);
        counts("fn a() { <Config>::path().unwrap(); }", 1);
        counts("fn a() { crate::config::Config :: path (); }", 1);
    }

    #[test]
    fn a_read_the_scan_cannot_resolve_counts_and_one_it_can_place_elsewhere_does_not() {
        counts(
            r#"fn a(k: &str) { std::env::var_os(["HO", "ME"].concat()); std::env::var(k); }"#,
            2,
        );
        counts(
            r#"const TOKEN_ENV: &str = "FORGE_TOKEN"; fn a() { std::env::var(TOKEN_ENV); }"#,
            0,
        );
        counts(
            r#"const A: &str = B; const B: &str = "HOME"; fn a() { std::env::var(A); }"#,
            2,
        );
        counts("fn a() { for _ in std::env::vars_os() {} }", 1);
        counts("fn a() { names.iter().map(std::env::var_os); }", 1);
        counts(r#"fn a() { env!("CARGO_MANIFEST_DIR"); }"#, 0);
        counts(r#"fn a() { option_env!("HOME"); }"#, 1);
        counts(r#"fn a() { std::env::var(handover::UNKNOWN_NAME); }"#, 1);
    }

    /// The whole-set read's F1: an escape spells the name as surely as its letters do.
    #[test]
    fn an_escaped_literal_is_read_for_the_name_it_spells() {
        counts(r#"fn a() { std::env::var_os("\x48OME"); }"#, 1);
        counts(r#"fn a() { std::env::var_os("\u{48}OME"); }"#, 1);
        counts(
            r#"const H: &str = "\x48OME"; fn a() { std::env::var_os(H); }"#,
            2,
        );
        counts(
            r#"fn a() { std::env::var_os(concat!("\u{48}O", "ME")); }"#,
            1,
        );
        assert_eq!(
            unquote(r#""a\"b\\c\x41\u{1F600}""#).as_deref(),
            Some("a\"b\\cA\u{1F600}")
        );
    }

    /// The whole-set read's F2: a name resolves through the `const` in scope where it is read,
    /// never through an unrelated one that happens to share it.
    #[test]
    fn a_local_that_shares_a_consts_name_is_no_const() {
        counts(
            r#"mod other { pub const key: &str = "FORGE_TOKEN"; }
               fn read(key: &str) { let _ = std::env::var_os(key); }"#,
            1,
        );
        counts(
            r#"mod a { const KEY: &str = "FORGE_TOKEN"; }
               mod b { fn read(k: &str) { let KEY = k; let _ = std::env::var_os(KEY); } }"#,
            1,
        );
        counts(
            r#"impl X { const KEY: &str = "FORGE_TOKEN"; fn read(KEY: &str) { std::env::var(KEY); } }"#,
            1,
        );
        counts(
            r#"const KEY: &str = "FORGE_TOKEN"; fn read() { std::env::var(KEY); }
               mod tests { use super::*; fn t() { std::env::var(KEY); } }"#,
            0,
        );
        counts(
            r#"use crate::daemon::handover::LISTENER_ENV; fn a() { std::env::var_os(LISTENER_ENV); }"#,
            1,
        );
    }

    /// The second whole-set read's F1: a reader re-exported and called through its module.
    #[test]
    fn a_reexported_reader_is_refused_and_each_call_through_it_counts() {
        let once = scanned(
            "mod readers { pub use std::env::var_os as get; } fn read(k: &str) { let _ = readers::get(k); }",
        );
        assert_eq!((once.routes.len(), once.refused.len()), (1, 1), "{once:#?}");
        assert!(
            once.refused[0].what.contains("a re-export of a route"),
            "{once:#?}"
        );
        let twice = scanned(
            "mod readers { pub(crate) use std::env::var_os as get; }
             fn read(k: &str) { let _ = readers::get(k); let _ = readers::get(k); }",
        );
        assert_eq!(
            (twice.routes.len(), twice.refused.len()),
            (2, 1),
            "{twice:#?}"
        );
        counts(
            "use std::env::var_os as get; fn a(m: &M, k: &str) { m.get(k); }",
            0,
        );
    }

    /// The tenth whole-set read's F1: a public re-export under a name a private import already
    /// bound is still a re-export, though it adds no name the file did not hold.
    #[test]
    fn a_reexport_under_a_name_already_bound_is_refused() {
        let s = scanned(
            "use std::env::var_os as get; fn a(k: &str) { let _ = get(k); }
             pub mod readers { pub use std::env::var_os as get; }",
        );
        assert!(
            s.refused
                .iter()
                .any(|h| h.what.contains("a re-export of a route")),
            "{s:#?}"
        );
        let crate_wide = scanned(
            "use std::env::var_os as get; fn a(k: &str) { let _ = get(k); }
             pub mod readers { pub(crate) use std::env as get; }",
        );
        assert!(
            crate_wide
                .refused
                .iter()
                .any(|h| h.what.contains("a re-export of a route")),
            "{crate_wide:#?}"
        );
        let plain = scanned("pub use crate::config::home_dir as h; use std::env::var_os as get;");
        assert!(plain.refused.is_empty(), "{plain:#?}");
    }

    /// The third whole-set read's F1 and F2: a reader imported again under a second name, and a
    /// const that names a qualified one beside a local of the same last name.
    #[test]
    fn a_second_alias_and_a_qualified_reference_are_followed() {
        counts(
            "use std::env::var_os as first; use first as second; fn read(k: &str) { let _ = second(k); }",
            1,
        );
        counts(
            "use first as second; use std::env::var_os as first;
             fn read(k: &str) { let _ = second(k); let _ = second(k); }",
            2,
        );
        let qualified = r#"mod keys { pub const KEY: &str = concat!("HO", "ME"); }
            const KEY: &str = "FORGE_TOKEN"; const READ: &str = keys::KEY;
            fn read() { let _ = std::env::var_os(READ); }"#;
        counts(qualified, 2);
        counts(
            &qualified.replace(
                "var_os(READ); }",
                "var_os(READ); let _ = std::env::var_os(READ); }",
            ),
            3,
        );
    }

    /// The fourth whole-set read's F1: a chain of consts is followed to its end however long it
    /// is, and one that comes back on itself is no value.
    #[test]
    fn a_long_const_chain_resolves_and_a_cycle_counts() {
        let names: Vec<String> = (0..12).map(|i| format!("C{i}")).collect();
        let mut chain: String = names
            .windows(2)
            .map(|w| format!("const {}: &str = {};\n", w[0], w[1]))
            .collect();
        chain.push_str("const C11: &str = \"FORGE_TOKEN\";\n");
        counts(&format!("{chain}fn f() {{ std::env::var_os(C0); }}"), 0);
        counts(
            "const A: &str = B; const B: &str = A; fn f() { std::env::var_os(A); }",
            1,
        );
        counts(
            "mod m { pub const A: &str = crate::m::B; pub const B: &str = m::A; }
             fn f() { std::env::var_os(m::A); }",
            1,
        );
    }

    /// The fifth whole-set read's F1: a const's own bare reference is read in the scope that
    /// defines it, not in the scope that reads it.
    #[test]
    fn a_consts_reference_is_read_where_the_const_is_defined() {
        let src = r#"const A: &str = B; const B: &str = concat!("HO", "ME");
            fn f() { const B: &str = "FORGE_TOKEN"; std::env::var_os(A); }"#;
        counts(src, 2);
        counts(
            &src.replace("var_os(A); }", "var_os(A); std::env::var_os(A); }"),
            3,
        );
    }

    /// The fifth whole-set read's F2: an alias chain of any length, in either order, and a cycle
    /// that ends.
    #[test]
    fn an_alias_chain_of_any_length_is_followed() {
        let mut uses: Vec<String> = vec!["use std::env::var_os as a0;".into()];
        uses.extend((0..128).map(|i| format!("use a{i} as a{};", i + 1)));
        for order in [uses.clone(), uses.iter().rev().cloned().collect()] {
            let once = format!("{} fn r(k: &str) {{ a128(k); }}", order.join(" "));
            counts(&once, 1);
            counts(&once.replace("a128(k); }", "a128(k); a128(k); }"), 2);
        }
        counts("use a as b; use b as a; fn r(k: &str) { b(k); }", 0);
    }

    /// The sixth whole-set read's F1: a const imported under another name resolves through the
    /// name it was imported as.
    #[test]
    fn a_const_imported_under_another_name_resolves_as_its_original() {
        let src = r#"mod keys { pub const HOME_KEY: &str = concat!("HO", "ME"); }
            mod unrelated { pub const KEY: &str = "FORGE_TOKEN"; }
            use keys::HOME_KEY as KEY;
            fn f() { std::env::var_os(KEY); }"#;
        counts(src, 2);
        counts(
            &src.replace("var_os(KEY); }", "var_os(KEY); std::env::var_os(KEY); }"),
            3,
        );
    }

    /// The seventh whole-set read's F1: an alias stands for a bare name only, never for the
    /// last segment of a qualified one.
    #[test]
    fn a_qualified_name_is_not_read_through_an_alias_of_its_last_segment() {
        let src = r#"mod keys { pub const KEY: &str = concat!("HO", "ME"); }
            mod other { pub const TOKEN: &str = "FORGE_TOKEN"; }
            use other::TOKEN as KEY;
            fn f() { std::env::var_os(KEY); std::env::var_os(keys::KEY); }"#;
        counts(src, 2);
        counts(
            &src.replace(
                "var_os(keys::KEY); }",
                "var_os(keys::KEY); std::env::var_os(keys::KEY); }",
            ),
            3,
        );
    }

    /// The eighth whole-set read's F1: two modules importing the same name from different places
    /// each keep theirs.
    #[test]
    fn a_name_two_modules_import_differently_resolves_through_both() {
        let src = r#"mod keys { pub const HOME_KEY: &str = concat!("HO", "ME"); pub const TOKEN: &str = "FORGE_TOKEN"; }
            mod a { use super::keys::HOME_KEY as KEY; fn f() { std::env::var_os(KEY); } }
            mod b { use super::keys::TOKEN as KEY; fn g() { std::env::var_os(KEY); } }"#;
        counts(src, 3);
        counts(
            &src.replace(
                "fn f() { std::env::var_os(KEY); }",
                "fn f() { std::env::var_os(KEY); std::env::var_os(KEY); }",
            ),
            4,
        );
    }

    /// The ninth whole-set read's F1: a const that names an imported one, read through a
    /// qualified path from elsewhere, follows the import.
    #[test]
    fn a_const_naming_a_renamed_import_follows_it_from_anywhere() {
        let src = r#"mod keys { pub const HOME_KEY: &str = concat!("HO", "ME"); }
            mod unrelated { pub const KEY: &str = "FORGE_TOKEN"; }
            mod reader { use super::keys::HOME_KEY as KEY; pub const READ: &str = KEY; }
            fn f() { std::env::var_os(reader::READ); }"#;
        counts(src, 2);
        counts(
            &src.replace(
                "var_os(reader::READ); }",
                "var_os(reader::READ); std::env::var_os(reader::READ); }",
            ),
            3,
        );
    }

    /// The whole-set read's F3: an import through another import's alias, in either order.
    #[test]
    fn an_import_through_an_alias_is_followed_in_either_order() {
        counts(
            "use std::env as e; use e::var_os as get; fn read(k: &str) { let _ = get(k); }",
            1,
        );
        counts(
            "use e::var_os as get; use std::env as e; fn read(k: &str) { let _ = get(k); }",
            1,
        );
        counts(
            "use dirs_next as d; use d::config_dir as cd; fn a() { cd(); }",
            2,
        );
    }

    #[test]
    fn a_name_a_use_binds_to_a_route_counts_wherever_it_is_used() {
        counts(
            r#"use std::env::var_os as get; fn a() { get(X); get("HOME"); }"#,
            2,
        );
        counts("use std::env as e; fn a(k: &str) { e::var(k); }", 1);
        counts("use crate::config::Config as C; fn a() { C::path(); }", 1);
        counts(
            "use dirs_next::config_dir; fn a() { config_dir(); control::config_dir(); }",
            2,
        );
        counts("use ::dirs_next as d; fn a() { d::config_dir(); }", 2);
        counts("extern crate dirs_next as dn;", 1);
        counts("use { dirs_next as dd, x };", 1);
        counts("fn a() { my_dirs_next_x(); }", 0);
    }

    #[test]
    fn the_guarded_home_is_no_route_and_any_other_home_dir_is() {
        counts("fn a() { crate::config::home_dir().ok(); }", 0);
        counts("fn a() { dirs_next::home_dir(); std::env::home_dir(); }", 3);
        let config = lex(
            "pub fn home_dir() {} fn a() { home_dir(); dirs_next::home_dir(); }",
            "config.rs",
        );
        let hits = routes(&config, &Consts::new(), true).routes;
        assert_eq!(hits.len(), 2, "{hits:#?}");
    }

    #[test]
    fn every_route_on_a_line_counts() {
        counts(
            r#"let home = dirs_next::home_dir().or_else(|| std::env::var_os("HOME").map(Into::into));"#,
            3,
        );
    }

    #[test]
    fn what_the_scan_cannot_see_through_is_refused_by_name() {
        let glob = scanned("use std::env::*; fn a() { var(\"X\"); }").refused;
        assert!(
            glob.iter()
                .any(|h| h.what.contains("a glob import from std::env")),
            "{glob:#?}"
        );
        let dirs = scanned("use dirs_next::*;");
        assert_eq!((dirs.routes.len(), dirs.refused.len()), (1, 1), "{dirs:#?}");
        let aliased = scanned("use dirs_next as d; use d::*;");
        assert_eq!(
            aliased.refused.len(),
            1,
            "a glob through an alias: {aliased:#?}"
        );
        // The consult's macro, which builds `std::env::var_os` from its arguments.
        let assembled = r#"macro_rules! read {
                ($m:ident, $f:ident, $k:expr) => { std::$m::$f($k) };
            }
            fn a(x: &str) { read!(env, var_os, ["HO", "ME"].concat()); read!(env, var_os, x); }"#;
        let s = scanned(assembled);
        assert_eq!((s.routes.len(), s.refused.len()), (2, 1), "{s:#?}");
        assert!(
            s.refused[0]
                .what
                .contains("macro_rules! read builds a path"),
            "{s:#?}"
        );
        counts(
            "macro_rules! at { ($x:expr) => { $crate::daemon::at($x) }; } fn a() { at!(1); }",
            0,
        );
    }

    #[test]
    fn the_name_a_setter_is_handed_scopes_the_variable_and_does_not_read_it() {
        counts(r#"cmd.env("HOME", root);"#, 0);
        counts(r#"let _h = ScopedVar::set("HOME", home);"#, 0);
        counts(r#"std::env::set_var("HOME", x);"#, 0);
        counts(r#"std::env::remove_var(concat!("HO", "ME"));"#, 0);
        counts(
            r#"cmd.env("CACHE_ROOT", std::env::var("HOME").unwrap());"#,
            1,
        );
        for no_setter in [
            r#"env_remove(std::env::var("HOME").unwrap());"#,
            r#"my_env_remove("HOME");"#,
            r#"reset("HOME");"#,
        ] {
            counts(no_setter, 1);
        }
    }

    #[test]
    fn a_comment_is_no_route_and_a_platform_name_is_one_wherever_it_stands() {
        counts(
            "// std::env::var(\"HOME\")\n/// dirs_next::home_dir()\n/* home_dir() */ fn a() {}",
            0,
        );
        let platform = format!("fn a() {{ p.join(\"{}\"); }}", ["APP", "DATA"].concat());
        counts(&platform, 1);
        counts(r#"fn a() { home.join(".config"); }"#, 1);
        counts(r#"fn a() { home.join(concat!(".con", "fig")); }"#, 1);
    }
}
