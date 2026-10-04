//! Turn parsed CLI arguments into a `Request`, or refuse with the reason.
//!
//! Separate from `cmd/api.rs` because everything here is a decision — which
//! method, which project, is this body sendable — and a decision fused to
//! `process::exit` is a decision nothing can test.

use crate::api::exit::is_json;
use crate::api::request::Request;

/// The arguments, with `--data -` already resolved to the text it read.
pub struct RequestSpec<'a> {
    pub path: &'a str,
    pub method: Option<&'a str>,
    pub data: Option<&'a str>,
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

    let method = spec
        .method
        .map(str::to_string)
        .unwrap_or_else(|| if spec.data.is_some() { "POST" } else { "GET" }.to_string());

    Ok(Request {
        method,
        path: spec.path.to_string(),
        body: spec.data.map(str::to_string),
        project_slug: spec
            .project
            .map(str::to_string)
            .or_else(|| default_slug(slugs)),
        headers,
        include_headers: spec.include,
    })
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
