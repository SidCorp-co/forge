//! What each platform's job actually compiles, read off the source.
//!
//! A `#[cfg]` that hides a case from a platform does not make that platform's
//! job pass over the case — it makes the job silent about it, and a green over
//! a case that was never compiled is evidence of nothing. The two are
//! indistinguishable from outside, which is why this went unnoticed until a
//! Windows job failed to compile a helper that nine of its own cases shared.
//!
//! The gate that runs here cannot represent a compiler that does not run here.
//! So the part of the question that IS answerable from any platform is asked
//! from any platform: which lines does a non-unix target compile, and do any of
//! them name something only unix has.
//!
//! The answer comes from evaluating the `cfg` predicate against a non-unix
//! target rather than matching how it is spelled. `all(unix, target_os =
//! "linux")` and `any(unix, windows)` read alike and mean opposite things — the
//! first is never compiled off unix, the second always is.

use std::path::{Path, PathBuf};

/// The APIs that exist on unix and nowhere else.
const ONLY_UNIX_HAS: [&str; 9] = [
    "os::unix",
    "nix::unistd",
    "nix::sys",
    "nix::errno",
    "nix::fcntl",
    "PermissionsExt",
    "MetadataExt",
    "OsStrExt",
    "CommandExt",
];

/// A line this crate compiles on a non-unix target that names a unix-only API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OffUnix {
    pub line: usize,
    pub text: String,
}

/// Whether `predicate` can hold on a target that is not unix.
///
/// Evaluated against Windows, the non-unix target this workspace builds for:
/// `unix` is false there and `windows` is true. An atom this does not know — a
/// feature, `test`, a custom key — is taken as possibly-true, so an unfamiliar
/// cfg leaves the code looking compiled and its unix calls still have to be
/// guarded. Guessing the other way is what hides a case.
pub fn compiled_off_unix(predicate: &str) -> bool {
    eval(predicate.trim())
}

fn eval(p: &str) -> bool {
    let p = p.trim();
    if let Some(inner) = combinator(p, "not") {
        return !eval(inner);
    }
    if let Some(inner) = combinator(p, "all") {
        return split_top(inner).into_iter().all(eval);
    }
    if let Some(inner) = combinator(p, "any") {
        return split_top(inner).into_iter().any(eval);
    }
    atom(p)
}

/// The text inside `name( ... )`, when `p` is exactly that and nothing else.
fn combinator<'a>(p: &'a str, name: &str) -> Option<&'a str> {
    let rest = p.strip_prefix(name)?.trim_start();
    let inner = rest.strip_prefix('(')?;
    let close = matching(inner)?;
    inner[close + 1..]
        .trim()
        .is_empty()
        .then_some(&inner[..close])
}

/// The index of the `)` closing the `(` that `inner` sits just inside of.
fn matching(inner: &str) -> Option<usize> {
    let mut depth = 0usize;
    for (i, c) in inner.char_indices() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' if depth == 0 => return Some(i),
            ')' | ']' => depth -= 1,
            _ => {}
        }
    }
    None
}

fn split_top(inner: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    for (i, c) in inner.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                parts.push(inner[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    let tail = inner[start..].trim();
    if !tail.is_empty() {
        parts.push(tail);
    }
    parts
}

fn atom(p: &str) -> bool {
    match p {
        "unix" => false,
        "windows" => true,
        _ => match key_value(p) {
            Some(("target_family" | "target_os", value)) => value == "windows",
            _ => true,
        },
    }
}

fn key_value(p: &str) -> Option<(&str, &str)> {
    let (key, value) = p.split_once('=')?;
    Some((key.trim(), value.trim().trim_matches('"')))
}

/// `src` with every comment and literal replaced by spaces, keeping newlines,
/// so line numbers and brace counts still mean what they say.
///
/// Without it a brace inside a string moves the depth, a `//` inside a raw
/// string swallows the rest of a line, and a rule naming the API it forbids —
/// this file's own list of names, nine lines of it — reads as a call into it.
pub fn code_only(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0usize;
    while i < chars.len() {
        if starts_raw_string(&chars, i) {
            i = blank_raw_string(&chars, i, &mut out);
            continue;
        }
        match chars[i] {
            '/' if chars.get(i + 1) == Some(&'/') => {
                while i < chars.len() && chars[i] != '\n' {
                    out.push(' ');
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => i = blank_block_comment(&chars, i, &mut out),
            '"' => i = blank_quoted(&chars, i, '"', &mut out),
            '\'' if opens_a_char_literal(&chars, i) => {
                i = blank_quoted(&chars, i, '\'', &mut out);
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

fn starts_raw_string(chars: &[char], i: usize) -> bool {
    if chars[i] != 'r' || i > 0 && (chars[i - 1].is_alphanumeric() || chars[i - 1] == '_') {
        return false;
    }
    let mut j = i + 1;
    while chars.get(j) == Some(&'#') {
        j += 1;
    }
    chars.get(j) == Some(&'"')
}

fn blank_raw_string(chars: &[char], start: usize, out: &mut String) -> usize {
    let mut i = start + 1;
    let mut hashes = 0usize;
    while chars.get(i) == Some(&'#') {
        hashes += 1;
        i += 1;
    }
    // `r`, the hashes, and the opening quote.
    for _ in 0..hashes + 2 {
        out.push(' ');
    }
    i += 1;
    while i < chars.len() {
        if chars[i] == '"' && chars[i + 1..].iter().take(hashes).all(|c| *c == '#') {
            for _ in 0..=hashes {
                if i < chars.len() {
                    out.push(' ');
                    i += 1;
                }
            }
            return i;
        }
        out.push(if chars[i] == '\n' { '\n' } else { ' ' });
        i += 1;
    }
    i
}

fn blank_block_comment(chars: &[char], start: usize, out: &mut String) -> usize {
    let mut i = start;
    let mut depth = 0usize;
    while i < chars.len() {
        if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
            depth += 1;
            out.push_str("  ");
            i += 2;
            continue;
        }
        if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
            depth -= 1;
            out.push_str("  ");
            i += 2;
            if depth == 0 {
                return i;
            }
            continue;
        }
        out.push(if chars[i] == '\n' { '\n' } else { ' ' });
        i += 1;
    }
    i
}

fn blank_quoted(chars: &[char], start: usize, close: char, out: &mut String) -> usize {
    let mut i = start + 1;
    out.push(' ');
    while i < chars.len() {
        if chars[i] == '\\' {
            // The escaped character, whatever it is — and in this tree it is
            // very often a real newline, which a blanket two spaces would eat,
            // shortening the file and moving every line number after it.
            out.push(' ');
            i += 1;
            if i < chars.len() {
                out.push(if chars[i] == '\n' { '\n' } else { ' ' });
                i += 1;
            }
            continue;
        }
        let done = chars[i] == close;
        out.push(if chars[i] == '\n' { '\n' } else { ' ' });
        i += 1;
        if done {
            return i;
        }
    }
    i
}

/// Whether the `'` at `i` opens a character literal rather than a lifetime.
///
/// `'a'` and `'\n'` close; the `'a` in `&'a str` never does, and reading to the
/// next quote would blank real code looking for one.
fn opens_a_char_literal(chars: &[char], i: usize) -> bool {
    match chars.get(i + 1) {
        Some('\\') => true,
        Some(_) => chars.get(i + 2) == Some(&'\''),
        None => false,
    }
}

/// Every line of `src` that a non-unix target compiles and that names an API
/// only unix has.
pub fn unguarded_unix_lines(src: &str) -> Vec<OffUnix> {
    let blanked = code_only(src);
    let code: Vec<&str> = blanked.lines().collect();
    let orig: Vec<&str> = src.lines().collect();

    let mut found = Vec::new();
    let mut depth = 0usize;
    let mut hidden_at: Vec<usize> = Vec::new();
    let mut pending = false;
    let mut i = 0usize;

    while i < code.len() {
        if code[i].trim_start().starts_with("#[") {
            let (attr, next) = whole_attribute(&orig, i);
            pending = pending || hides_from_off_unix(&attr);
            i = next;
            continue;
        }

        if hidden_at.is_empty() && !pending && names_only_unix(code[i]) {
            found.push(OffUnix {
                line: i + 1,
                text: orig[i].trim().to_string(),
            });
        }

        let before = depth;
        depth = depth_after(code[i], depth);
        if pending {
            // Whether a block opened at all, not whether the depth ended up
            // higher: `#[cfg(unix)]` over a `{}` opens and closes on one line,
            // and reading the net depth leaves the guard standing over
            // everything after it (consult 585c9f F1).
            if code[i].contains('{') {
                if depth > before {
                    hidden_at.push(before);
                }
                pending = false;
            } else if code[i].trim_end().ends_with(';') {
                // An item with no block of its own — a `use`, a `mod x;` — is
                // over at the end of its line.
                pending = false;
            }
            // Anything else is an item still being written: a `fn` whose
            // arguments are wrapped over four lines is guarded by the cfg
            // above it just as much as a one-line one, and dropping the guard
            // at the end of the first line uncovers its whole body.
        }
        while hidden_at.last().is_some_and(|level| depth <= *level) {
            hidden_at.pop();
        }
        i += 1;
    }
    found
}

fn depth_after(line: &str, depth: usize) -> usize {
    (depth + line.matches('{').count()).saturating_sub(line.matches('}').count())
}

fn names_only_unix(code_line: &str) -> bool {
    ONLY_UNIX_HAS.iter().any(|api| code_line.contains(api))
}

/// One attribute, however many lines it is wrapped over, and the line after it.
fn whole_attribute(orig: &[&str], start: usize) -> (String, usize) {
    let mut text = String::new();
    let mut depth = 0i32;
    let mut i = start;
    while i < orig.len() {
        text.push_str(orig[i].trim());
        for c in orig[i].chars() {
            match c {
                '[' | '(' => depth += 1,
                ']' | ')' => depth -= 1,
                _ => {}
            }
        }
        i += 1;
        if depth <= 0 {
            break;
        }
    }
    (text, i)
}

/// Whether this attribute keeps what it is attached to off a non-unix target.
///
/// `#[cfg_attr(...)]` does not, whatever it says: it changes an attribute
/// rather than dropping the item. Only a `#[cfg]` whose predicate is false off
/// unix hides anything.
pub fn hides_from_off_unix(attr: &str) -> bool {
    let Some(rest) = attr.trim().strip_prefix("#[cfg(") else {
        return false;
    };
    matching(rest).is_some_and(|close| !compiled_off_unix(&rest[..close]))
}

/// The names of every `#[test]` in `src` that a non-unix target never compiles.
///
/// Read off the case's whole attribute set, so the order they are written in
/// and the shape of the predicate change nothing.
pub fn tests_hidden_off_unix(src: &str) -> Vec<String> {
    let mut hidden = Vec::new();
    walk_items(src, |attrs, declared| {
        if let Item::Fn(name) = declared {
            if attrs.iter().any(|a| a.starts_with("#[test]"))
                && attrs.iter().any(|a| hides_from_off_unix(a))
            {
                hidden.push(name);
            }
        }
    });
    hidden
}

/// The module files `src` declares that a non-unix target never compiles —
/// dropped by a `#[cfg]`, or swapped for another file by
/// `#[cfg_attr(not(unix), path = "...")]`.
///
/// Resolved to real paths from the declaring file, because a module name is not
/// unique: two directories may each hold a `helper.rs` with only one of them
/// swapped, and exempting both by name would hide the other completely.
pub fn modules_not_compiled_off_unix(file: &Path, src: &str) -> Vec<PathBuf> {
    let dir = module_dir(file);
    let mut out = Vec::new();
    walk_items(src, |attrs, declared| {
        if let Item::Mod(name) = declared {
            if attrs
                .iter()
                .any(|a| hides_from_off_unix(a) || swaps_the_file(a))
            {
                out.push(dir.join(format!("{name}.rs")));
                out.push(dir.join(&name));
            }
        }
    });
    out
}

enum Item {
    Fn(String),
    Mod(String),
}

/// Calls `see` for each `fn` or `mod` declaration with the attributes attached
/// to it, whatever order they were written in.
fn walk_items(src: &str, mut see: impl FnMut(&[String], Item)) {
    let blanked = code_only(src);
    let code: Vec<&str> = blanked.lines().collect();
    let orig: Vec<&str> = src.lines().collect();

    let mut attrs: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < code.len() {
        let trimmed = code[i].trim();
        if trimmed.starts_with("#[") {
            let (attr, next) = whole_attribute(&orig, i);
            attrs.push(attr);
            i = next;
            continue;
        }
        if let Some(name) = declared_mod(trimmed) {
            see(&attrs, Item::Mod(name));
            attrs.clear();
        } else if let Some(name) = declared_fn(trimmed) {
            see(&attrs, Item::Fn(name));
            attrs.clear();
        } else if !trimmed.is_empty() && !orig[i].trim_start().starts_with("//") {
            attrs.clear();
        }
        i += 1;
    }
}

fn declared_fn(trimmed: &str) -> Option<String> {
    let rest = trimmed
        .strip_prefix("fn ")
        .or_else(|| trimmed.strip_prefix("pub fn "))
        .or_else(|| trimmed.strip_prefix("async fn "))?;
    Some(rest.split('(').next()?.trim().to_string())
}

fn declared_mod(trimmed: &str) -> Option<String> {
    let rest = trimmed
        .strip_prefix("pub mod ")
        .or_else(|| trimmed.strip_prefix("mod "))
        .or_else(|| trimmed.strip_prefix("pub(crate) mod "))?;
    Some(rest.strip_suffix(';')?.trim().to_string())
}

/// `#[cfg_attr(<true off unix>, path = "...")]` — off unix the name resolves to
/// a different file, so this one is not read there. An attribute that swaps no
/// path drops no file: `#[cfg_attr(unix, allow(dead_code))]` exempts nothing.
fn swaps_the_file(attr: &str) -> bool {
    let Some(rest) = attr.trim().strip_prefix("#[cfg_attr(") else {
        return false;
    };
    let Some(close) = matching(rest) else {
        return false;
    };
    let parts = split_top(&rest[..close]);
    let Some(predicate) = parts.first() else {
        return false;
    };
    compiled_off_unix(predicate)
        && parts
            .iter()
            .skip(1)
            .any(|p| p.trim_start().starts_with("path"))
}

fn module_dir(file: &Path) -> PathBuf {
    let parent = file.parent().unwrap_or(Path::new(".")).to_path_buf();
    match file.file_stem().and_then(|s| s.to_str()) {
        Some("mod" | "lib" | "main") | None => parent,
        Some(stem) => parent.join(stem),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_predicate_naming_unix_two_ways_means_two_different_things() {
        assert!(!compiled_off_unix("unix"));
        assert!(!compiled_off_unix("all(unix, target_os = \"linux\")"));
        assert!(!compiled_off_unix("target_os = \"linux\""));
        assert!(!compiled_off_unix("target_family = \"unix\""));
        assert!(!compiled_off_unix("all(test, unix)"));
        // Reads like the lines above and is their opposite: windows builds it.
        assert!(compiled_off_unix("any(unix, windows)"));
        assert!(compiled_off_unix("not(unix)"));
        assert!(compiled_off_unix("windows"));
        assert!(compiled_off_unix("target_os = \"windows\""));
        // An atom this does not know leaves the code looking compiled.
        assert!(compiled_off_unix("test"));
        assert!(compiled_off_unix("feature = \"pty\""));
    }

    /// Consult f4c1e2 F1: the walk accepted a cfg whose block had already
    /// closed. Nothing stands between that `}` and the call, so every platform
    /// compiles the call and the sweep has to say so.
    #[test]
    fn a_unix_call_after_a_unix_block_closed_is_not_covered_by_it() {
        const SRC: &str = "fn f() {\n    #[cfg(unix)]\n    {\n        let _ = 1;\n    }\n    use std::os::unix::fs::PermissionsExt;\n}\n";
        let found = unguarded_unix_lines(SRC);
        assert_eq!(found.len(), 1, "found: {found:?}");
        assert_eq!(found[0].line, 6);
    }

    /// Same consult: a predicate that merely mentioned a platform was read as
    /// excluding one.
    #[test]
    fn a_case_windows_also_compiles_is_not_hidden_by_naming_unix_in_its_cfg() {
        const BOTH: &str =
            "#[cfg(any(unix, windows))]\nfn f() {\n    use std::os::unix::fs::PermissionsExt;\n}\n";
        assert_eq!(unguarded_unix_lines(BOTH).len(), 1);

        const HIDDEN: &str = "#[cfg(all(unix, target_os = \"linux\"))]\nfn f() {\n    use std::os::unix::fs::PermissionsExt;\n}\n";
        assert!(unguarded_unix_lines(HIDDEN).is_empty());
    }

    /// Consult f4c1e2 F2: a `"` inside a character literal flipped the scanner
    /// into a string it never left, blanking the call on the line after it.
    #[test]
    fn a_quote_inside_a_character_literal_does_not_swallow_what_follows() {
        // On the SAME line, which is where the old line-local scanner lost it:
        // the quote opened a string it never left, so the call after it was
        // blanked away (consult 585c9f, refuting F2 on the weaker fixture).
        const SRC: &str = "fn f() {\n    let q = '\"'; use std::os::unix::fs::PermissionsExt;\n}\n";
        let found = unguarded_unix_lines(SRC);
        assert_eq!(found.len(), 1, "found: {found:?}");
        assert_eq!(found[0].line, 2);
    }

    #[test]
    fn a_cfg_covers_a_signature_that_is_wrapped_over_several_lines() {
        const SRC: &str = "#[cfg(unix)]\nfn f(\n    a: &str,\n    b: &str,\n) -> u32 {\n    use std::os::unix::fs::PermissionsExt;\n    0\n}\n";
        assert!(
            unguarded_unix_lines(SRC).is_empty(),
            "the guard was dropped at the end of the first line of the signature"
        );
    }

    #[test]
    fn a_guarded_block_that_opens_and_closes_on_one_line_covers_only_that_line() {
        const SRC: &str =
            "fn f() {\n    #[cfg(unix)]\n    {}\n    use std::os::unix::fs::PermissionsExt;\n}\n";
        let found = unguarded_unix_lines(SRC);
        assert_eq!(found.len(), 1, "found: {found:?}");
        assert_eq!(found[0].line, 4);
    }

    #[test]
    fn a_lifetime_is_not_a_character_literal() {
        const SRC: &str =
            "fn f<'a>(s: &'a str) -> &'a str {\n    use std::os::unix::fs::MetadataExt;\n    s\n}\n";
        assert_eq!(unguarded_unix_lines(SRC).len(), 1);
    }

    #[test]
    fn a_unix_api_named_in_a_string_or_a_comment_is_prose_about_it() {
        const SRC: &str = "fn f() {\n    let _ = \"PermissionsExt\";\n    // os::unix\n    let _ = r#\"std::os::unix::fs\"#;\n}\n";
        assert!(unguarded_unix_lines(SRC).is_empty());
    }

    #[test]
    fn a_cfg_written_inside_a_raw_string_guards_nothing() {
        const SRC: &str = "fn f() {\n    let _ = r#\"#[cfg(unix)]\"#;\n    use std::os::unix::fs::PermissionsExt;\n}\n";
        assert_eq!(unguarded_unix_lines(SRC).len(), 1);
    }

    #[test]
    fn a_brace_inside_a_string_does_not_move_the_depth() {
        const SRC: &str = "#[cfg(unix)]\nfn f() {\n    let _ = \"}\";\n    use std::os::unix::fs::PermissionsExt;\n}\n";
        assert!(
            unguarded_unix_lines(SRC).is_empty(),
            "the guard was closed by a brace that is only text"
        );
    }

    /// Consult f4c1e2 F4: the case gate read the attributes in one order only,
    /// so `#[test]` written above `#[cfg(unix)]` entered nothing.
    #[test]
    fn a_hidden_case_is_found_whatever_order_its_attributes_are_in() {
        assert_eq!(
            tests_hidden_off_unix("#[test]\n#[cfg(unix)]\nfn hidden_one() {}\n"),
            vec!["hidden_one".to_string()]
        );
        assert_eq!(
            tests_hidden_off_unix("#[cfg(unix)]\n#[test]\nfn hidden_two() {}\n"),
            vec!["hidden_two".to_string()]
        );
        assert_eq!(
            tests_hidden_off_unix("#[cfg(all(unix))]\n#[test]\nfn hidden_three() {}\n"),
            vec!["hidden_three".to_string()]
        );
        assert!(tests_hidden_off_unix("#[test]\nfn not_hidden() {}\n").is_empty());
        assert!(
            tests_hidden_off_unix("#[cfg(any(unix, windows))]\n#[test]\nfn everywhere() {}\n")
                .is_empty()
        );
    }

    /// Consult f4c1e2 F3: exempting by module NAME exempted every file that
    /// happened to share it, and any `cfg_attr` at all counted as a swap.
    #[test]
    fn a_module_is_exempt_by_the_file_it_resolves_to_and_not_by_its_name() {
        let swapped = modules_not_compiled_off_unix(
            Path::new("crates/core/src/runner/mod.rs"),
            "#[cfg_attr(not(unix), path = \"helper_no_fifo.rs\")]\npub mod helper;\n",
        );
        assert!(swapped.contains(&PathBuf::from("crates/core/src/runner/helper.rs")));
        assert!(
            !swapped.contains(&PathBuf::from("crates/core/src/daemon/helper.rs")),
            "a same-named module in another directory was exempted with it: {swapped:?}"
        );

        let no_swap = modules_not_compiled_off_unix(
            Path::new("crates/core/src/daemon/mod.rs"),
            "#[cfg_attr(unix, allow(dead_code))]\npub mod helper;\n",
        );
        assert!(
            no_swap.is_empty(),
            "an attribute that drops no file was read as a swap: {no_swap:?}"
        );

        let dropped = modules_not_compiled_off_unix(
            Path::new("crates/core/src/daemon/mod.rs"),
            "#[cfg(unix)]\npub mod helper;\n",
        );
        assert!(dropped.contains(&PathBuf::from("crates/core/src/daemon/helper.rs")));
    }

    #[test]
    fn a_module_declared_from_a_named_file_resolves_beside_that_files_own_name() {
        let out = modules_not_compiled_off_unix(
            Path::new("crates/core/src/runner.rs"),
            "#[cfg(unix)]\nmod doorbell;\n",
        );
        assert!(
            out.contains(&PathBuf::from("crates/core/src/runner/doorbell.rs")),
            "{out:?}"
        );
    }
}
