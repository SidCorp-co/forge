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
#[derive(Default)]
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
    /// A `macro_rules!` that builds a path from a metavariable, by name.
    assembling: BTreeSet<String>,
    /// What the scan refuses outright: a glob import from a route module, and a macro that
    /// assembles a path, neither of which it can see through.
    refused: Vec<Hit>,
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

/// Every `const` and `static` in `tokens` with the value it is defined with, where that value is
/// a literal, a `concat!` of literals or the name of another; `None` for any other.
pub(crate) fn collect_consts(tokens: &[TokenTree], into: &mut Consts) {
    let mut i = 0;
    while i < tokens.len() {
        if let TokenTree::Group(g) = &tokens[i] {
            collect_consts(&g.stream().into_iter().collect::<Vec<_>>(), into);
        }
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
            let v = folded(value).or_else(|| path_name(value).map(|n| format!("\u{0}{n}")));
            into.entry(name.to_string()).or_default().push(v);
            i = end;
        }
        i += 1;
    }
}

/// The literal values `name` may hold, following one const through another; `None` where any
/// definition of it is not one the scan can read.
fn resolve(consts: &Consts, name: &str, depth: usize) -> Option<Vec<String>> {
    let defs = consts.get(name)?;
    let mut out = Vec::new();
    for d in defs {
        match d.as_deref() {
            Some(v) if v.starts_with('\u{0}') => {
                if depth > 8 {
                    return None;
                }
                out.extend(resolve(consts, &v[1..], depth + 1)?);
            }
            Some(v) => out.push(v.to_string()),
            None => return None,
        }
    }
    Some(out)
}

/// Every route in one file. `in_config` is `config.rs`, whose `Self::path()` is `Config::path()`.
pub(crate) fn routes(tokens: &[TokenTree], consts: &Consts, in_config: bool) -> Vec<Hit> {
    let mut b = Bindings::default();
    collect_bindings(tokens, &mut b);
    let mut hits = b.refused.clone();
    let scan = Scan {
        b: &b,
        consts,
        in_config,
        variables: variables(),
        platform: platform_names(),
    };
    scan.walk(tokens, false, &mut hits);
    hits.sort_by_key(|h| h.line);
    hits
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
    fn walk(&self, tokens: &[TokenTree], handed_to_a_setter: bool, hits: &mut Vec<Hit>) {
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
                    self.ident(&name, tokens, i, hits);
                }
                TokenTree::Group(g) => {
                    let inner: Vec<TokenTree> = g.stream().into_iter().collect();
                    let setter =
                        g.delimiter() == Delimiter::Parenthesis && is_setter_call(tokens, i);
                    self.walk(&inner, setter, hits);
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

    fn ident(&self, name: &str, tokens: &[TokenTree], i: usize, hits: &mut Vec<Hit>) {
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
                    if let Some(why) = self.read_at(tokens, i + 3) {
                        hit(format!("{name}::{f} {why}"));
                    }
                }
            }
        }
        if (name == "env" || name == "option_env")
            && tokens.get(i + 1).is_some_and(|t| is_punct(t, '!'))
        {
            if let Some(why) = self.read_at(tokens, i + 1) {
                hit(format!("{name}! {why}"));
            }
        }
        if self.b.env_reads.contains(name) && !qualified {
            if let Some(why) = self.read_at(tokens, i) {
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
    fn read_at(&self, tokens: &[TokenTree], at: usize) -> Option<String> {
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
            return match resolve(self.consts, &n, 0) {
                Some(vals) if vals.iter().any(|v| self.variables.contains(&v.as_str())) => {
                    Some(format!("reads {vals:?} through {n}"))
                }
                Some(_) => None,
                None => Some(format!("reads {n}, which the scan cannot resolve")),
            };
        }
        Some("reads a name the scan cannot resolve".into())
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

/// What every `use` and `extern crate` in `tokens` binds, at any depth.
fn collect_bindings(tokens: &[TokenTree], b: &mut Bindings) {
    let mut i = 0;
    while i < tokens.len() {
        if let TokenTree::Group(g) = &tokens[i] {
            collect_bindings(&g.stream().into_iter().collect::<Vec<_>>(), b);
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
            use_tree(&tokens[i + 1..end], &[], b, line_of(&tokens[i]));
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
fn use_tree(tokens: &[TokenTree], prefix: &[String], b: &mut Bindings, line: usize) {
    let mut path = prefix.to_vec();
    let mut i = 0;
    while i < tokens.len() {
        match &tokens[i] {
            TokenTree::Ident(id) if id == "as" => {
                if let Some(TokenTree::Ident(alias)) = tokens.get(i + 1) {
                    bind(&path, &alias.to_string(), b);
                }
                return;
            }
            TokenTree::Ident(id) => path.push(id.to_string()),
            TokenTree::Punct(p) if p.as_char() == '*' => {
                let from = path.join("::");
                let route = path.iter().any(|s| s == "dirs_next")
                    || path.ends_with(&["std".into(), "env".into()])
                    || path.last().is_some_and(|s| s == "config");
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
                    use_tree(part, &path, b, line);
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
                bind(&module, &name, b);
            }
        } else {
            bind(&path, &last, b);
        }
    }
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
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('0') => out.push('\0'),
            Some('\n') => {
                while chars.peek().is_some_and(|c| c.is_whitespace()) {
                    chars.next();
                }
            }
            Some(other) => out.push(other),
            None => {}
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

    fn scan(src: &str) -> Vec<Hit> {
        let tokens = lex(src, "a fixture");
        let mut consts = Consts::new();
        collect_consts(&tokens, &mut consts);
        routes(&tokens, &consts, false)
    }

    #[track_caller]
    fn counts(src: &str, want: usize) {
        let hits = scan(src);
        assert_eq!(hits.len(), want, "{src}\n{hits:#?}");
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
        let hits = routes(&config, &Consts::new(), true);
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
        let glob = scan("use std::env::*; fn a() { var(\"X\"); }");
        assert!(
            glob.iter()
                .any(|h| h.what.contains("a glob import from std::env")),
            "{glob:#?}"
        );
        counts("use dirs_next::*;", 2);
        // The consult's macro, which builds `std::env::var_os` from its arguments.
        let assembled = r#"macro_rules! read {
                ($m:ident, $f:ident, $k:expr) => { std::$m::$f($k) };
            }
            fn a(x: &str) { read!(env, var_os, ["HO", "ME"].concat()); read!(env, var_os, x); }"#;
        let hits = scan(assembled);
        assert_eq!(hits.len(), 3, "{hits:#?}");
        assert!(
            hits[0].what.contains("macro_rules! read builds a path"),
            "{hits:#?}"
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
