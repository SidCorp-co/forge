//! `-F name=@path` and `-F name=value`: a `multipart/form-data` body for the routes that take one.
//!
//! Core's attachment routes read one file from a multipart `file` field and refuse JSON, so a box
//! that could only send JSON could not attach a verdict's evidence without a second client carrying
//! the token (ISS-294). The body is built here rather than through reqwest's `multipart` feature,
//! which would bring a dependency in for thirty lines of framing.
//!
//! The media type is the caller's to claim (`;type=`) and never guessed here: a part sent without
//! one goes as `application/octet-stream`, which core reads as undeclared and resolves from the
//! file's name and bytes itself (`lib/attachment-mime.ts:resolveAttachmentMime`).

use std::path::{Path, PathBuf};

/// One `-F` argument, parsed and not yet read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FormField {
    Text {
        name: String,
        value: String,
    },
    File {
        name: String,
        path: PathBuf,
        mime: Option<String>,
    },
}

/// One part with its bytes in hand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Part {
    pub name: String,
    pub filename: Option<String>,
    pub mime: Option<String>,
    pub bytes: Vec<u8>,
}

const UNDECLARED: &str = "application/octet-stream";

/// `name=@path[;type=mime]` is a file, `name=value` a text field, or the reason it is neither.
pub fn parse_field(arg: &str) -> Result<FormField, String> {
    let Some((name, value)) = arg.split_once('=') else {
        return Err(format!(
            "-F takes `name=@path` for a file or `name=value` for a text field, got `{arg}` — an attachment route reads its file from `file`: -F file=@./shot.png"
        ));
    };
    let name = name.trim();
    if name.is_empty() {
        return Err(format!("-F `{arg}` names no field before `=`"));
    }
    if name.contains(['"', '\r', '\n']) {
        return Err(format!(
            "-F field name `{name}` carries a quote or a line break, which no form field name can"
        ));
    }
    let Some(file) = value.strip_prefix('@') else {
        return Ok(FormField::Text {
            name: name.to_string(),
            value: value.to_string(),
        });
    };
    let (path, mime) = match file.split_once(";type=") {
        Some((path, mime)) => {
            let mime = mime.trim();
            if !mime.contains('/') || mime.contains(['\r', '\n']) {
                return Err(format!(
                    "-F `{arg}`: `;type=` takes a media type such as image/png, got `{mime}`"
                ));
            }
            (path, Some(mime.to_string()))
        }
        None => (file, None),
    };
    if path.is_empty() {
        return Err(format!("-F `{arg}` names no file after `@`"));
    }
    Ok(FormField::File {
        name: name.to_string(),
        path: PathBuf::from(path),
        mime,
    })
}

/// Read every file the fields name, or say which one could not be read. Nothing is sent until all
/// of them are in hand, so a typo in the second path never leaves the first one uploaded alone.
pub fn read_parts(fields: &[FormField]) -> Result<Vec<Part>, String> {
    fields
        .iter()
        .map(|field| match field {
            FormField::Text { name, value } => Ok(Part {
                name: name.clone(),
                filename: None,
                mime: None,
                bytes: value.as_bytes().to_vec(),
            }),
            FormField::File { name, path, mime } => {
                let bytes = std::fs::read(path).map_err(|e| {
                    format!("-F {name}=@{}: cannot read the file: {e}", path.display())
                })?;
                Ok(Part {
                    name: name.clone(),
                    filename: Some(filename_of(path)),
                    mime: mime.clone(),
                    bytes,
                })
            }
        })
        .collect()
}

fn filename_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string())
}

/// A quoted-string value in a `Content-Disposition` header, escaped the way browsers send a form:
/// a quote and a line break would otherwise end the header the name sits in.
fn quoted(value: &str) -> String {
    value
        .replace('"', "%22")
        .replace('\r', "%0D")
        .replace('\n', "%0A")
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// The first boundary no part's bytes carry. Chosen, not drawn at random, so a body is the same
/// bytes every time it is built from the same parts.
fn boundary_for(parts: &[Part]) -> String {
    (0u64..)
        .map(|n| format!("forge-runner-form-{n:016x}"))
        .find(|b| !parts.iter().any(|p| contains(&p.bytes, b.as_bytes())))
        .expect("a u64 range holds a boundary absent from a finite body")
}

/// The body and the `Content-Type` header value that names its boundary.
pub fn encode(parts: &[Part]) -> (String, Vec<u8>) {
    let boundary = boundary_for(parts);
    let mut body = Vec::new();
    for part in parts {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        let mut disposition = format!(
            "Content-Disposition: form-data; name=\"{}\"",
            quoted(&part.name)
        );
        if let Some(filename) = &part.filename {
            disposition.push_str(&format!("; filename=\"{}\"", quoted(filename)));
        }
        body.extend_from_slice(disposition.as_bytes());
        body.extend_from_slice(b"\r\n");
        if part.filename.is_some() {
            let mime = part.mime.as_deref().unwrap_or(UNDECLARED);
            body.extend_from_slice(format!("Content-Type: {mime}\r\n").as_bytes());
        }
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(&part.bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_field_names_its_path_and_an_optional_claimed_type() {
        assert_eq!(
            parse_field("file=@./shot.png").unwrap(),
            FormField::File {
                name: "file".into(),
                path: "./shot.png".into(),
                mime: None
            }
        );
        assert_eq!(
            parse_field("file=@out.log;type=text/plain").unwrap(),
            FormField::File {
                name: "file".into(),
                path: "out.log".into(),
                mime: Some("text/plain".into())
            }
        );
        assert_eq!(
            parse_field("note=a=b").unwrap(),
            FormField::Text {
                name: "note".into(),
                value: "a=b".into()
            }
        );
    }

    #[test]
    fn a_field_that_is_neither_shape_is_refused_by_name() {
        for (arg, says) in [
            ("shot.png", "-F takes `name=@path`"),
            ("=@shot.png", "names no field"),
            ("file=@", "names no file"),
            ("file=@x.png;type=png", "takes a media type"),
            ("fi\"le=@x.png", "quote or a line break"),
        ] {
            let why = parse_field(arg).expect_err(arg);
            assert!(why.contains(says), "{arg}: {why}");
        }
    }

    #[test]
    fn an_unreadable_file_is_named_before_anything_is_built() {
        let why = read_parts(&[FormField::File {
            name: "file".into(),
            path: "/nonexistent/forge-runner/evidence.png".into(),
            mime: None,
        }])
        .unwrap_err();
        assert!(
            why.contains("/nonexistent/forge-runner/evidence.png"),
            "{why}"
        );
    }

    #[test]
    fn the_body_frames_each_part_with_its_name_filename_and_type() {
        let parts = vec![
            Part {
                name: "file".into(),
                filename: Some("a\"b.png".into()),
                mime: None,
                bytes: vec![0x89, b'P', b'N', b'G'],
            },
            Part {
                name: "note".into(),
                filename: None,
                mime: None,
                bytes: b"hi".to_vec(),
            },
        ];
        let (content_type, body) = encode(&parts);
        let boundary = content_type
            .strip_prefix("multipart/form-data; boundary=")
            .unwrap();
        let mut want = Vec::new();
        want.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a%22b.png\"\r\nContent-Type: application/octet-stream\r\n\r\n"
            )
            .as_bytes(),
        );
        want.extend_from_slice(&[0x89, b'P', b'N', b'G']);
        want.extend_from_slice(
            format!(
                "\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\nhi\r\n--{boundary}--\r\n"
            )
            .as_bytes(),
        );
        assert_eq!(body, want);
    }

    #[test]
    fn the_boundary_is_one_no_part_carries() {
        let first = boundary_for(&[]);
        let parts = vec![Part {
            name: "file".into(),
            filename: Some("x.txt".into()),
            mime: Some("text/plain".into()),
            bytes: format!("before {first} after").into_bytes(),
        }];
        let (content_type, body) = encode(&parts);
        assert!(!content_type.ends_with(&first), "{content_type}");
        assert!(body.windows(first.len()).any(|w| w == first.as_bytes()));
    }
}
