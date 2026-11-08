//! A Strapi sign-in, as SidDesk's `/api/auth/login` reads it (ISS-1083, ISS-1094): the account
//! under `identifier`, and the token answered as `data.jwt`.

use super::*;

/// The stub's `/api/auth/login`; none for another route.
pub(super) fn respond(line: &str, body: &str) -> Option<String> {
    if !line.starts_with("POST /api/auth/login ") {
        return None;
    }
    let sent: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if sent != json!({ "identifier": EMAIL, "password": PASSWORD }) {
        let refused = json!({ "error": { "message": "identifier and password are required" } });
        return Some(http("400 Bad Request", &[], &refused.to_string()));
    }
    // SidDesk answers its token as `data.jwt` (ISS-1094), not a top-level `token`.
    Some(http(
        "200 OK",
        &[],
        &json!({ "data": { "jwt": TOKEN, "user": { "id": 1 } } }).to_string(),
    ))
}

/// A product whose sign-in reads `identifier` (Strapi; SidDesk's `/api/auth/login`) is signed in
/// with the account sent under that name, and the same account under `email` is not (ISS-1083).
#[tokio::test]
async fn an_account_named_identifier_signs_in_under_that_name() {
    let (api, seen) = stub(Answers::TokenAndCookies).await;
    let root = Scratch::new("identifier");
    let value = secret(json!({
        "loginRoute": format!("POST {api}/api/auth/login"),
        "identifier": EMAIL,
        "password": PASSWORD,
    }));
    let (files, _) = login_into(
        &answer(&api, &value),
        &root.0.join("strapi"),
        "dev",
        "member",
    )
    .await
    .unwrap_or_else(|e| panic!("identifier: {e}"));
    assert_eq!(
        std::fs::read_to_string(&files.header).unwrap(),
        format!("Authorization: Bearer {TOKEN}\n")
    );
    let sent = seen.lock().unwrap().clone();
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert!(
        sent[0].line.starts_with("POST /api/auth/login "),
        "{sent:?}"
    );
    let body: Value = serde_json::from_str(&sent[0].body).unwrap();
    assert_eq!(body, json!({ "identifier": EMAIL, "password": PASSWORD }));

    let as_email = secret(json!({
        "loginRoute": format!("POST {api}/api/auth/login"),
        "email": EMAIL,
        "password": PASSWORD,
    }));
    let Err(refused) = login_into(
        &answer(&api, &as_email),
        &root.0.join("email"),
        "dev",
        "member",
    )
    .await
    else {
        panic!("the account under `email` signed in where the route reads `identifier`");
    };
    assert!(refused.contains("400"), "{refused}");

    let both = secret(json!({
        "loginRoute": format!("POST {api}/api/auth/login"),
        "identifier": EMAIL,
        "email": EMAIL,
        "password": PASSWORD,
    }));
    let Err(refused) =
        login_into(&answer(&api, &both), &root.0.join("both"), "dev", "member").await
    else {
        panic!("a secret naming two accounts signed in");
    };
    assert!(
        refused.contains("names `email` and `identifier` at once"),
        "{refused}"
    );
    assert_eq!(
        seen.lock().unwrap().len(),
        2,
        "a refused shape sends nothing"
    );
}
