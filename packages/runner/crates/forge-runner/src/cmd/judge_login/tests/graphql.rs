//! A sign-in the secret describes (ISS-1141): epod's admin, whose sign-in is a GraphQL mutation at
//! `/graphql` and whose token sits at `/data/login/access_token`, as the stub answers it, and each
//! way such a secret is no sign-in.

use super::*;

/// epod's sign-in mutation (ISS-1141), whose `$email` is GraphQL's own variable, never a placeholder.
const MUTATION: &str = "mutation Login($email: String!, $password: String!) { login(email: $email, password: $password) { access_token } }";

/// The stub's `/graphql`: the mutation with the right account answers its token, a wrong account
/// answers 200 with `errors` (as GraphQL does), any other body 422; none for another route.
pub(super) fn respond(line: &str, body: &str) -> Option<String> {
    if !line.starts_with("POST /graphql ") {
        return None;
    }
    let sent: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if sent["query"] != json!(MUTATION) {
        let refused = json!({ "errors": [{ "message": "Must provide query string." }] });
        return Some(http("422 Unprocessable Entity", &[], &refused.to_string()));
    }
    if sent["variables"] != json!({ "email": EMAIL, "password": PASSWORD }) {
        let refused = json!({ "errors": [{ "message": format!("no user {}", sent["variables"]["email"]) }], "data": null });
        return Some(http("200 OK", &[], &refused.to_string()));
    }
    Some(http(
        "200 OK",
        &[],
        &json!({ "data": { "login": { "access_token": TOKEN } } }).to_string(),
    ))
}

/// The secret of an app whose sign-in is a GraphQL mutation (ISS-1141): epod's shape, an account
/// under `username`, the route, the body it sends and where its answer holds the token.
fn graphql_secret(api: &str, extra: Value) -> String {
    let mut o = json!({
        "username": EMAIL,
        "password": PASSWORD,
        "loginRoute": format!("{api}/graphql"),
        "loginBody": { "query": MUTATION, "variables": { "email": "$account", "password": "$password" } },
        "tokenPath": "/data/login/access_token",
    });
    for (k, v) in extra.as_object().unwrap() {
        if v.is_null() {
            o.as_object_mut().unwrap().remove(k);
        } else {
            o[k] = v.clone();
        }
    }
    o.to_string()
}

#[tokio::test]
async fn a_graphql_sign_in_the_secret_describes_signs_in() {
    let (api, seen) = stub(Answers::TokenAndCookies).await;
    let root = Scratch::new("graphql");
    let (files, _) = login_into(
        &answer(&api, &graphql_secret(&api, json!({}))),
        &root.0.join("gql"),
        "dev",
        "member",
    )
    .await
    .unwrap_or_else(|e| panic!("graphql: {e}"));
    assert_eq!(
        std::fs::read_to_string(&files.header).unwrap(),
        format!("Authorization: Bearer {TOKEN}\n")
    );
    let sent = seen.lock().unwrap().clone();
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert!(sent[0].line.starts_with("POST /graphql "), "{sent:?}");
    // only whole leaves are substituted: the `$email` inside the query string is left as it was
    let body: Value = serde_json::from_str(&sent[0].body).unwrap();
    assert_eq!(
        body,
        json!({ "query": MUTATION, "variables": { "email": EMAIL, "password": PASSWORD } })
    );
}

/// Each GraphQL secret `judge-login` cannot sign in with, and what its refusal says.
pub(super) fn refusals(api: &str) -> Vec<(&'static str, Value, &'static str)> {
    vec![
        (
            "a GraphQL answer carrying `errors`, which echoes the account",
            answer(
                api,
                &graphql_secret(api, json!({ "password": "not-the-password" })),
            ),
            "answered 200 OK with a GraphQL `errors` array, so it signed nobody in",
        ),
        (
            "no token at the secret's tokenPath",
            answer(
                api,
                &graphql_secret(api, json!({ "tokenPath": "/data/login/token" })),
            ),
            "with no token at `/data/login/token`",
        ),
        (
            "a tokenPath that is no JSON pointer",
            answer(
                api,
                &graphql_secret(api, json!({ "tokenPath": "data.login" })),
            ),
            "`tokenPath` is a JSON pointer",
        ),
        (
            "a $-word that is no placeholder",
            answer(
                api,
                &graphql_secret(
                    api,
                    json!({ "loginBody": { "query": MUTATION, "variables": { "email": "$email", "password": "$password" } } }),
                ),
            ),
            "`loginBody` at /variables/email is `$email`",
        ),
        (
            "a body that never sends the password",
            answer(
                api,
                &graphql_secret(
                    api,
                    json!({ "loginBody": { "query": MUTATION, "variables": { "email": "$account", "password": "Password $password" } } }),
                ),
            ),
            "has no leaf that is exactly `$password`",
        ),
        (
            "a body that is no object",
            answer(api, &graphql_secret(api, json!({ "loginBody": MUTATION }))),
            "`loginBody` is a JSON object",
        ),
    ]
}
