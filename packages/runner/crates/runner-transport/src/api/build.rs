//! Turn parsed CLI arguments into a `Request`, or refuse with the reason.
//!
//! Separate from `cmd/api.rs` because everything here is a decision — which
//! method, which project, is this body sendable — and a decision fused to
//! `process::exit` is a decision nothing can test.

use crate::api::exit::is_json;
use crate::api::field::json_body;
use crate::api::form::{parse_field, FormField};
use crate::api::request::{Body, Request};

/// The arguments, with `--data -` already resolved to the text it read.
pub struct RequestSpec<'a> {
    pub path: &'a str,
    pub method: Option<&'a str>,
    pub data: Option<&'a str>,
    /// `-f` arguments: each `name=value`, `name=@path` or `name=@-`, sent as one JSON object of
    /// string fields.
    pub fields: &'a [String],
    /// What stdin held, read once by the caller where a `-f name=@-` reads it.
    pub stdin: Option<&'a str>,
    /// `-F` arguments: each `name=@path` or `name=value`, sent as one `multipart/form-data` body.
    pub form: &'a [String],
    pub project: Option<&'a str>,
    pub headers: &'a [String],
    pub include: bool,
}

/// Where a project slug may come from, in precedence order.
pub struct SlugSources<'a> {
    /// `$FORGE_PROJECT_SLUG`.
    pub env: Option<&'a str>,
    /// Every project slug bound in this runner's config.
    pub bindings: &'a [String],
}

/// Build the request, or return the message the caller should refuse with.
pub fn build(spec: &RequestSpec<'_>, slugs: &SlugSources<'_>) -> Result<Request, String> {
    if let Some(b) = spec.data {
        if !is_json(b) {
            return Err("--data is not valid JSON".to_string());
        }
    }
    if spec.data.is_some() && !spec.form.is_empty() {
        return Err(
            "--data and -F are two bodies, and a request carries one: --data sends JSON, -F sends multipart/form-data — an attachment route takes -F file=@<path>"
                .to_string(),
        );
    }
    if !spec.fields.is_empty() && (spec.data.is_some() || !spec.form.is_empty()) {
        return Err(
            "-f builds the JSON body itself, so it goes without --data and -F: a request carries one body"
                .to_string(),
        );
    }
    let form = spec
        .form
        .iter()
        .map(|arg| parse_field(arg))
        .collect::<Result<Vec<FormField>, String>>()?;
    let fields = if spec.fields.is_empty() {
        None
    } else {
        Some(json_body(spec.fields, spec.stdin)?)
    };
    let data = spec.data.or(fields.as_deref());

    let mut headers = Vec::new();
    for h in spec.headers {
        let Some((k, v)) = h.split_once(':') else {
            return Err(format!("header must be `Name: value`, got `{h}`"));
        };
        if k.trim().is_empty() {
            return Err(format!("header name is empty in `{h}`"));
        }
        headers.push((k.trim().to_string(), v.trim().to_string()));
    }

    if spec.path.trim().is_empty() {
        return Err("path is empty".to_string());
    }
    if let Some(at) = empty_segment(spec.path) {
        return Err(format!(
            "path `{}` has an empty segment after `{at}/` — a shell variable meant to fill it is unset (a job pane exports $FORGE_PROJECT_ID and $FORGE_PROJECT_SLUG; elsewhere write the project id out)",
            spec.path
        ));
    }

    let method = spec.method.map(str::to_string).unwrap_or_else(|| {
        if data.is_some() || !form.is_empty() {
            "POST"
        } else {
            "GET"
        }
        .to_string()
    });
    let body = match (data, form.is_empty()) {
        (Some(json), _) => Some(Body::Json(json.to_string())),
        (None, false) => Some(Body::Form(form)),
        (None, true) => None,
    };

    Ok(Request {
        method,
        path: spec.path.to_string(),
        body,
        project_slug: spec
            .project
            .map(str::to_string)
            .or_else(|| default_slug(slugs)),
        headers,
        include_headers: spec.include,
    })
}

/// The part of the path before an empty segment, where one sits between two `/`. The query is not
/// read: a value there may carry `//` legitimately.
fn empty_segment(path: &str) -> Option<&str> {
    let route = path.split(['?', '#']).next().unwrap_or(path);
    let trimmed = route.trim_start_matches('/');
    let at = trimmed.find("//")?;
    Some(&trimmed[..at])
}

fn default_slug(slugs: &SlugSources<'_>) -> Option<String> {
    if let Some(s) = slugs.env {
        if !s.trim().is_empty() {
            return Some(s.trim().to_string());
        }
    }
    match slugs.bindings {
        [only] => Some(only.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec<'a>(data: Option<&'a str>, form: &'a [String]) -> RequestSpec<'a> {
        RequestSpec {
            path: "issues/x/attachments",
            method: None,
            data,
            form,
            fields: &[],
            stdin: None,
            project: None,
            headers: &[],
            include: false,
        }
    }

    const NO_SLUG: SlugSources<'static> = SlugSources {
        env: None,
        bindings: &[],
    };

    #[test]
    fn a_form_is_a_post_carrying_its_fields() {
        let form = vec!["file=@shot.png".to_string()];
        let req = build(&spec(None, &form), &NO_SLUG).unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(
            req.body,
            Some(Body::Form(vec![FormField::File {
                name: "file".into(),
                path: "shot.png".into(),
                mime: None
            }]))
        );
    }

    #[test]
    fn json_and_a_form_together_are_refused_by_name() {
        let form = vec!["file=@shot.png".to_string()];
        let why = build(&spec(Some("{}"), &form), &NO_SLUG).unwrap_err();
        assert!(why.contains("--data and -F"), "{why}");
    }

    #[test]
    fn a_malformed_field_refuses_the_whole_request() {
        let form = vec!["file=@shot.png".to_string(), "shot.png".to_string()];
        let why = build(&spec(None, &form), &NO_SLUG).unwrap_err();
        assert!(why.contains("`shot.png`"), "{why}");
    }

    #[test]
    fn text_fields_are_a_json_post_and_go_alone() {
        let fields = vec!["body=@-".to_string()];
        let req = build(
            &RequestSpec {
                fields: &fields,
                stdin: Some("It's \"done\"\nnext\n"),
                ..spec(None, &[])
            },
            &NO_SLUG,
        )
        .unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(
            req.body,
            Some(Body::Json(r#"{"body":"It's \"done\"\nnext"}"#.into()))
        );
        let form = vec!["file=@shot.png".to_string()];
        for (data, form) in [(Some("{}"), &[][..]), (None, &form[..])] {
            let why = build(
                &RequestSpec {
                    fields: &fields,
                    stdin: Some("x"),
                    ..spec(data, form)
                },
                &NO_SLUG,
            )
            .unwrap_err();
            assert!(why.contains("-f builds the JSON body itself"), "{why}");
        }
    }

    #[test]
    fn json_alone_is_sent_as_before() {
        let req = build(&spec(Some("{\"a\":1}"), &[]), &NO_SLUG).unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.body, Some(Body::Json("{\"a\":1}".into())));
        let get = build(&spec(None, &[]), &NO_SLUG).unwrap();
        assert_eq!((get.method.as_str(), get.body), ("GET", None));
    }
}
