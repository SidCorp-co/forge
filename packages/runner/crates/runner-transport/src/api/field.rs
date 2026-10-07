//! `-f name=value`, `-f name=@path`, `-f name=@-`: a JSON body of string fields, built here.
//!
//! A run writing prose to core — a comment on where its work stands — had only `--data`, which
//! takes the JSON as one shell argument, so the run quoted its words twice by hand: once for the
//! shell, once for JSON. An apostrophe broke the first and a double quote or a line break the
//! second, and the stop gate's hint taught exactly that shape (ISS-297). With `-f`, the text is
//! read from a file or from stdin as it stands — a quoted heredoc (`<<'EOF'`) carries any prose
//! untouched — and this module does the JSON escaping, so neither quoting is the caller's.
//!
//! Text read from a file or stdin loses one trailing line break, the one a heredoc or an editor
//! always ends with; everything else arrives byte for byte.

use std::path::PathBuf;

/// Where one field's text comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Source {
    Literal(String),
    Stdin,
    File(PathBuf),
}

/// `name=value`, `name=@path` or `name=@-` as a name and where its text is, or the refusal.
fn parse(arg: &str) -> Result<(String, Source), String> {
    let Some((name, value)) = arg.split_once('=') else {
        return Err(format!(
            "-f takes `name=value`, `name=@path` or `name=@-` (stdin), got `{arg}` — a comment is -f body=@- with its text on stdin"
        ));
    };
    let name = name.trim();
    if name.is_empty() {
        return Err(format!("-f `{arg}` names no field before `=`"));
    }
    let source = match value.strip_prefix('@') {
        None => Source::Literal(value.to_string()),
        Some("-") => Source::Stdin,
        Some("") => return Err(format!("-f `{arg}` names no file after `@`")),
        Some(path) => Source::File(PathBuf::from(path)),
    };
    Ok((name.to_string(), source))
}

fn without_final_newline(mut text: String) -> String {
    if text.ends_with('\n') {
        text.pop();
        if text.ends_with('\r') {
            text.pop();
        }
    }
    text
}

/// The JSON object the `-f` arguments make, `stdin` being what stdin held where one of them reads
/// it. Refused by name: a malformed argument, a field named twice, stdin read twice or not read, a
/// file that cannot be read or is not UTF-8.
pub fn json_body(args: &[String], stdin: Option<&str>) -> Result<String, String> {
    let mut obj = serde_json::Map::new();
    let mut stdin_by: Option<String> = None;
    for arg in args {
        let (name, source) = parse(arg)?;
        if obj.contains_key(&name) {
            return Err(format!(
                "-f names `{name}` twice, and a JSON object holds one value for each name"
            ));
        }
        let text = match source {
            Source::Literal(value) => value,
            Source::Stdin => {
                if let Some(first) = &stdin_by {
                    return Err(format!(
                        "-f {first}=@- and -f {name}=@- both read stdin, which holds one text — read the other from a file with @<path>"
                    ));
                }
                stdin_by = Some(name.clone());
                let Some(text) = stdin else {
                    return Err(format!("-f {name}=@- reads stdin, and stdin was not read"));
                };
                without_final_newline(text.to_string())
            }
            Source::File(path) => {
                let bytes = std::fs::read(&path).map_err(|e| {
                    format!("-f {name}=@{}: cannot read the file: {e}", path.display())
                })?;
                let text = String::from_utf8(bytes).map_err(|_| {
                    format!(
                        "-f {name}=@{}: the file is not UTF-8 text, and a JSON string carries text — send a file with -F",
                        path.display()
                    )
                })?;
                without_final_newline(text)
            }
        };
        obj.insert(name, serde_json::Value::String(text));
    }
    Ok(serde_json::Value::Object(obj).to_string())
}

/// Whether any `-f` argument reads stdin, so the caller knows to read it once before building.
pub fn reads_stdin(args: &[String]) -> bool {
    args.iter()
        .any(|a| matches!(parse(a), Ok((_, Source::Stdin))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn body(args: &[&str], stdin: Option<&str>) -> Result<Value, String> {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        json_body(&args, stdin).map(|b| serde_json::from_str(&b).unwrap())
    }

    const PROSE: &str = "It's \"held\"\nat step 2 \\ $HOME";

    #[test]
    fn stdin_text_arrives_as_written_less_its_final_line_break() {
        assert_eq!(
            body(&["body=@-"], Some(&format!("{PROSE}\n"))),
            Ok(json!({ "body": PROSE }))
        );
        assert_eq!(
            body(&["body=@-"], Some("two\n\n")),
            Ok(json!({ "body": "two\n" })),
            "only one final line break is the heredoc's"
        );
        assert_eq!(
            body(&["body=@-"], Some("crlf\r\n")),
            Ok(json!({ "body": "crlf" }))
        );
    }

    #[test]
    fn a_file_and_a_literal_are_fields_beside_stdin() {
        let path = std::env::temp_dir().join(format!("api-field-{}.txt", std::process::id()));
        std::fs::write(&path, format!("{PROSE}\n")).unwrap();
        let arg = format!("note=@{}", path.display());
        let got = body(&["kind=comment", &arg, "body=@-"], Some("x"));
        let _ = std::fs::remove_file(&path);
        assert_eq!(
            got,
            Ok(json!({ "kind": "comment", "note": PROSE, "body": "x" }))
        );
    }

    #[test]
    fn wrong_shapes_are_refused_by_name() {
        let why = |args: &[&str], stdin| body(args, stdin).unwrap_err();
        assert!(why(&["body"], None).contains("-f takes `name=value`"));
        assert!(why(&["=x"], None).contains("names no field"));
        assert!(why(&["body=@"], None).contains("names no file"));
        assert!(why(&["a=1", "a=2"], None).contains("`a` twice"));
        assert!(why(&["a=@-", "b=@-"], Some("x")).contains("both read stdin"));
        assert!(why(&["a=@-"], None).contains("stdin was not read"));
        assert!(why(&["a=@/no/such/file"], None).contains("cannot read the file"));
    }

    #[test]
    fn a_file_that_is_not_text_is_refused_not_mangled() {
        let path = std::env::temp_dir().join(format!("api-field-bin-{}", std::process::id()));
        std::fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        let arg = format!("body=@{}", path.display());
        let got = body(&[&arg], None);
        let _ = std::fs::remove_file(&path);
        assert!(got.unwrap_err().contains("not UTF-8"));
    }

    #[test]
    fn only_an_at_dash_value_reads_stdin() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(reads_stdin(&args(&["a=1", "body=@-"])));
        assert!(!reads_stdin(&args(&["a=@-x", "b=-"])));
    }
}
