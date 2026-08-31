//! Turn parsed CLI arguments into a `Request`, or refuse with the reason.
//!
//! Separate from `cmd/api.rs` because everything here is a decision — which
//! method, which project, is this body sendable — and a decision fused to
//! `process::exit` is a decision nothing can test.

use super::exit::is_json;
use super::request::Request;

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
    // cm:guard --data is checked HERE, before anything is sent. A body core would reject costs a round trip and reports the SERVER's parse error rather than the caller's typo; and for a POST, "it was never sent" is the only cheap answer to "did it half-happen?".
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

    // cm:why POST when a body is given: `-X` exists for the rest, and a body on a GET is the one combination that is almost always a mistake rather than an intent
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

/// `--project` (handled by the caller), then `$FORGE_PROJECT_SLUG`, then the
/// sole binding.
// cm:guard AMBIGUITY RESOLVES TO NOTHING, never to a guess: with two bindings this returns None, core sees no slug header and refuses the project-scoped route. Picking the first binding instead would send the call to the wrong project with a token that is valid for both — a wrong answer that looks like a Forge bug rather than a missing `--project`.
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

    fn spec<'a>(path: &'a str) -> RequestSpec<'a> {
        RequestSpec {
            path,
            method: None,
            data: None,
            project: None,
            headers: &[],
            include: false,
        }
    }

    fn no_slugs<'a>() -> SlugSources<'a> {
        SlugSources {
            env: None,
            bindings: &[],
        }
    }

    #[test]
    fn a_bare_path_is_a_get_with_no_body() {
        let r = build(&spec("issues"), &no_slugs()).unwrap();
        assert_eq!(r.method, "GET");
        assert!(r.body.is_none());
        assert!(!r.include_headers);
    }

    #[test]
    fn a_body_makes_it_a_post_without_being_asked() {
        let mut s = spec("issues");
        s.data = Some(r#"{"title":"x"}"#);
        assert_eq!(build(&s, &no_slugs()).unwrap().method, "POST");
    }

    #[test]
    fn an_explicit_method_beats_the_body_default() {
        let mut s = spec("issues/1");
        s.data = Some("{}");
        s.method = Some("PATCH");
        assert_eq!(build(&s, &no_slugs()).unwrap().method, "PATCH");
    }

    #[test]
    fn a_body_that_is_not_json_is_refused_before_anything_is_sent() {
        let mut s = spec("issues");
        s.data = Some("{title: x}");
        assert_eq!(
            build(&s, &no_slugs()).unwrap_err(),
            "--data is not valid JSON"
        );
    }

    #[test]
    fn an_empty_body_is_refused_rather_than_sent_as_nothing() {
        let mut s = spec("issues");
        s.data = Some("");
        assert!(build(&s, &no_slugs()).is_err());
    }

    #[test]
    fn a_json_array_and_a_bare_literal_are_both_valid_bodies() {
        for b in ["[]", "null", "3", r#""s""#] {
            let mut s = spec("issues");
            s.data = Some(b);
            assert!(build(&s, &no_slugs()).is_ok(), "body {b}");
        }
    }

    #[test]
    fn a_header_is_split_on_the_first_colon_and_trimmed() {
        let hs = vec!["X-Trace:  abc ".to_string()];
        let mut s = spec("issues");
        s.headers = &hs;
        assert_eq!(
            build(&s, &no_slugs()).unwrap().headers,
            vec![("X-Trace".into(), "abc".into())]
        );
    }

    // cm:guard split on the FIRST colon only — a value legitimately contains colons (a URL, a timestamp), and splitting on the last or on every colon corrupts it silently, which is worse than refusing
    #[test]
    fn a_value_containing_colons_survives_intact() {
        let hs = vec!["X-Url: https://example.com:8443/a".to_string()];
        let mut s = spec("issues");
        s.headers = &hs;
        assert_eq!(
            build(&s, &no_slugs()).unwrap().headers[0].1,
            "https://example.com:8443/a"
        );
    }

    #[test]
    fn a_header_with_no_colon_is_refused_and_says_which_one() {
        let hs = vec!["nocolon".to_string()];
        let mut s = spec("issues");
        s.headers = &hs;
        assert!(build(&s, &no_slugs()).unwrap_err().contains("nocolon"));
    }

    #[test]
    fn a_header_with_an_empty_name_is_refused() {
        let hs = vec![": v".to_string()];
        let mut s = spec("issues");
        s.headers = &hs;
        assert!(build(&s, &no_slugs()).is_err());
    }

    #[test]
    fn an_empty_path_is_refused() {
        assert!(build(&spec("   "), &no_slugs()).is_err());
    }

    #[test]
    fn explicit_project_wins_over_both_env_and_a_binding() {
        let b = vec!["bound".to_string()];
        let mut s = spec("issues");
        s.project = Some("explicit");
        let slugs = SlugSources {
            env: Some("from-env"),
            bindings: &b,
        };
        assert_eq!(
            build(&s, &slugs).unwrap().project_slug.as_deref(),
            Some("explicit")
        );
    }

    #[test]
    fn the_env_slug_wins_over_a_binding() {
        let b = vec!["bound".to_string()];
        let slugs = SlugSources {
            env: Some("from-env"),
            bindings: &b,
        };
        assert_eq!(
            build(&spec("issues"), &slugs)
                .unwrap()
                .project_slug
                .as_deref(),
            Some("from-env")
        );
    }

    #[test]
    fn a_blank_env_slug_does_not_shadow_the_binding() {
        let b = vec!["bound".to_string()];
        let slugs = SlugSources {
            env: Some("   "),
            bindings: &b,
        };
        assert_eq!(
            build(&spec("issues"), &slugs)
                .unwrap()
                .project_slug
                .as_deref(),
            Some("bound")
        );
    }

    #[test]
    fn a_sole_binding_is_used_without_being_named() {
        let b = vec!["only-one".to_string()];
        let slugs = SlugSources {
            env: None,
            bindings: &b,
        };
        assert_eq!(
            build(&spec("issues"), &slugs)
                .unwrap()
                .project_slug
                .as_deref(),
            Some("only-one")
        );
    }

    // cm:guard TWO bindings must yield None, not a pick. This is the case that would send a call to the wrong project under a token valid for both — core then refuses for want of a slug, which is a message the caller can act on, where a wrong-project answer is one they cannot even detect. Make `default_slug` fall back to `.first()` and only this goes red.
    #[test]
    fn two_bindings_resolve_to_nothing_rather_than_the_first() {
        let b = vec!["alpha".to_string(), "beta".to_string()];
        let slugs = SlugSources {
            env: None,
            bindings: &b,
        };
        assert_eq!(build(&spec("issues"), &slugs).unwrap().project_slug, None);
    }

    #[test]
    fn no_binding_at_all_resolves_to_nothing() {
        assert_eq!(
            build(&spec("issues"), &no_slugs()).unwrap().project_slug,
            None
        );
    }

    #[test]
    fn include_and_path_ride_through_untouched() {
        let mut s = spec("/api/issues?limit=1");
        s.include = true;
        let r = build(&s, &no_slugs()).unwrap();
        assert!(r.include_headers);
        assert_eq!(r.path, "/api/issues?limit=1");
    }
}
