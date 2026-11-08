//! A sign-in the secret describes (ISS-1141): epod's admin, whose sign-in is a GraphQL mutation at
//! `/graphql` and whose token sits at `/data/login/access_token`, as the stub answers it, and each
//! way such a secret is no sign-in.

use super::*;

/// epod's sign-in mutation (ISS-1141), whose `$email` is GraphQL's own variable, never a placeholder.
const MUTATION: &str = "mutation Login($email: String!, $password: String!) { login(email: $email, password: $password) { access_token } }";

/// epod's sign-in mutation as its admin's own login sends it (ISS-1145, epod `AuthContext.tsx`
/// `LOGIN_MUTATION`): the token, its expiry, the user and the organization.
const EPOD_MUTATION: &str = "mutation Login($email: String!, $password: String!) { login(email: $email, password: $password) { access_token expires_at user { id email name role } organization { id code name email phone status } } }";
const EXPIRES_AT: &str = "2026-11-09T13:21:00Z";
const ORG_ID: &str = "org-1145-test-store";
const USER_ID: &str = "user-1145-owner";

/// What epod's `login` answers to `EPOD_MUTATION`: every key its admin restores a session from.
fn epod_payload() -> Value {
    json!({ "data": { "login": {
        "access_token": TOKEN,
        "token_type": "Bearer",
        "expires_at": EXPIRES_AT,
        "expires_in": 86400,
        "user": { "id": USER_ID, "email": "owner@test-store.epod.test", "name": "Owner", "role": "admin" },
        "organization": { "id": ORG_ID, "code": "TS", "name": "Test Store", "email": "store@epod.test", "phone": "0900", "status": "active" },
    } } })
}

/// The storage map epod's secrets carry (ISS-1145): the five keys its admin's `login()` writes.
fn epod_storage() -> Value {
    json!({
        "auth_token": "/data/login/access_token",
        "auth_token_expires_at": "/data/login/expires_at",
        "user": "/data/login/user",
        "organization": "/data/login/organization",
        "organization_id": "/data/login/organization/id",
    })
}

/// epod's admin restores a session only when `auth_token`, `user` and `organization` are all
/// present and `organization.id` equals `organization_id` (epod `AuthContext.tsx`); the reason
/// it would not, else nothing.
fn epod_restores(state: &Value) -> Result<(), String> {
    let origins = state["origins"].as_array().ok_or("no origins")?;
    let web = origins
        .iter()
        .find(|o| o["origin"] == "https://web.forge.test")
        .ok_or_else(|| format!("no localStorage for the app's origin: {origins:?}"))?;
    let item = |k: &str| {
        web["localStorage"]
            .as_array()
            .and_then(|a| a.iter().find(|i| i["name"] == k))
            .and_then(|i| i["value"].as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("no `{k}` in localStorage"))
    };
    let token = item("auth_token")?;
    let user: Value = serde_json::from_str(&item("user")?).map_err(|e| format!("user: {e}"))?;
    let org: Value =
        serde_json::from_str(&item("organization")?).map_err(|e| format!("organization: {e}"))?;
    if token.is_empty() || !user.is_object() || org["id"] != json!(item("organization_id")?) {
        return Err("the session does not restore".into());
    }
    Ok(())
}

/// The stub's `/graphql`: the mutation with the right account answers its token, a wrong account
/// answers 200 with `errors` (as GraphQL does), any other body 422; none for another route.
pub(super) fn respond(line: &str, body: &str) -> Option<String> {
    if !line.starts_with("POST /graphql ") {
        return None;
    }
    let sent: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if sent["query"] == json!(EPOD_MUTATION) && sent["variables"]["password"] == json!(PASSWORD) {
        return Some(http("200 OK", &[], &epod_payload().to_string()));
    }
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

#[tokio::test]
async fn the_browser_session_the_secret_describes_is_written_and_restores() {
    let (api, _) = stub(Answers::TokenAndCookies).await;
    let root = Scratch::new("storage");
    let value = graphql_secret(
        &api,
        json!({
            "loginBody": { "query": EPOD_MUTATION, "variables": { "email": "$account", "password": "$password" } },
            "storage": epod_storage(),
        }),
    );
    let (files, signed_in) = login_into(&answer(&api, &value), &root.0.join("epod"), "dev", "owner")
        .await
        .unwrap_or_else(|e| panic!("epod: {e}"));
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(&files.state).unwrap()).unwrap();
    epod_restores(&state).unwrap_or_else(|e| panic!("{e}: {state}"));
    // a string is written as it is, an object as JSON text, each for the app's origin
    let login = &epod_payload()["data"]["login"];
    let mut want: Vec<(&str, String)> = vec![
        ("auth_token", TOKEN.to_string()),
        ("auth_token_expires_at", EXPIRES_AT.to_string()),
        ("user", login["user"].to_string()),
        ("organization", login["organization"].to_string()),
        ("organization_id", ORG_ID.to_string()),
    ];
    want.sort();
    let items: Vec<Value> = want
        .iter()
        .map(|(k, v)| json!({ "name": k, "value": v }))
        .collect();
    assert_eq!(
        state["origins"],
        json!([{ "origin": "https://web.forge.test", "localStorage": items }])
    );
    // the line printed names the keys and no value
    let said = said("dev", "owner", &files, &signed_in, "removed by the run's close");
    assert!(said.contains("`auth_token`") && said.contains("`organization_id`"), "{said}");
    for v in [TOKEN, EXPIRES_AT, ORG_ID, USER_ID, PASSWORD, EMAIL] {
        assert!(!said.contains(v), "{v} in {said}");
        assert!(!format!("{signed_in:?}").contains(v), "{v} in the Debug");
    }
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
        (
            "a storage pointer the answer does not hold (ISS-1145)",
            answer(
                api,
                &graphql_secret(api, json!({ "storage": { "auth_token": "/data/login/access_token", "user": "/data/login/user" } })),
            ),
            "with nothing at `/data/login/user` for the storage key `user`",
        ),
        (
            "a storage map that is no object",
            answer(api, &graphql_secret(api, json!({ "storage": "auth_token" }))),
            "`storage` is a JSON object",
        ),
        (
            "a storage value that is no JSON pointer",
            answer(api, &graphql_secret(api, json!({ "storage": { "user": "data.login.user" } }))),
            "`storage` at `user` is no JSON pointer",
        ),
        (
            "a storageKey that is no string",
            answer(api, &graphql_secret(api, json!({ "storageKey": 7 }))),
            "`storageKey` is the localStorage key",
        ),
        (
            "one key under storageKey and storage both",
            answer(
                api,
                &graphql_secret(api, json!({ "storageKey": "auth_token", "storage": { "auth_token": "/data/login/access_token" } })),
            ),
            "`storageKey` and `storage` both name `auth_token`",
        ),
    ]
}
