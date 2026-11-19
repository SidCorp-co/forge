//! The capability map across the builds that share it (ISS-1306).

use super::*;

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("forge-tokens-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("control-tokens.json")
}

fn pane_of(store: &SessionTokens, token: &str) -> Option<String> {
    match store.resolve(token) {
        Ok(Holder::Minted(m)) => Some(m.pane),
        _ => None,
    }
}

fn done(path: &Path) {
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

/// A token the map does not hold is told apart from a map that cannot be read,
/// and each names the map and the way back.
#[test]
fn an_absent_token_and_an_unreadable_map_are_two_refusals_naming_the_map() {
    let path = scratch();
    let store = SessionTokens::at(path.clone());
    store
        .mint("s-1", "p-1", "proj", "forge-master-proj")
        .unwrap();
    let absent = store.resolve("no-such-token").unwrap_err();
    assert_eq!(absent, Unresolved::Absent { map: path.clone() });
    let said = absent.refusal();
    assert!(
        said.starts_with(&format!("[{CAPABILITY_ABSENT}]")),
        "{said}"
    );
    assert!(said.contains(&path.display().to_string()), "{said}");
    assert!(said.contains("forge-runner master kill"), "{said}");

    std::fs::write(&path, "{ not a map").unwrap();
    let unreadable = store.resolve("no-such-token").unwrap_err();
    assert!(
        matches!(&unreadable, Unresolved::Unreadable { map, .. } if map == &path),
        "{unreadable:?}"
    );
    let said = unreadable.refusal();
    assert!(
        said.starts_with(&format!("[{CAPABILITY_MAP_UNREADABLE}]")),
        "{said}"
    );
    assert!(said.contains(&path.display().to_string()), "{said}");
    assert_ne!(said, absent.refusal());
    done(&path);
}

/// The incident: a build that cannot see a running tmux pane places a master
/// under that pane's name, under the very session core still serves the pane,
/// and the start fails. The running pane keeps its capability.
#[test]
fn a_placement_over_a_running_panes_name_that_never_starts_leaves_its_capability() {
    let path = scratch();
    let older = SessionTokens::at(path.clone());
    let running = older
        .mint("s-1", "p-1", "proj", "forge-master-proj")
        .unwrap();
    older.settle(&running).unwrap();

    let newer = SessionTokens::at(path.clone());
    let unused = newer
        .mint("s-1", "p-1", "proj", "forge-master-proj")
        .unwrap();
    newer.withdraw(&unused).unwrap();

    assert_eq!(
        pane_of(&older, &running).as_deref(),
        Some("forge-master-proj"),
        "the running pane lost its capability to a placement that never started"
    );
    assert!(!newer.holds_token(&unused).unwrap());
    done(&path);
}

/// A placement that did start replaces the pane it was placed over: that
/// pane's entry, and every other entry for its session, go once it is up.
#[test]
fn a_settled_placement_retires_what_it_replaced_and_nothing_else() {
    let path = scratch();
    let store = SessionTokens::at(path.clone());
    let old = store
        .mint("s-1", "p-1", "proj", "forge-master-proj")
        .unwrap();
    let other = store.mint("s-9", "p-2", "two", "forge-master-two").unwrap();
    let same_session = store.mint("s-2", "p-3", "three", "forge-job-x").unwrap();
    let new = store
        .mint("s-2", "p-1", "proj", "forge-master-proj")
        .unwrap();
    assert!(store.holds_token(&old).unwrap(), "a mint dropped an entry");
    store.settle(&new).unwrap();
    assert!(matches!(
        store.resolve(&old),
        Err(Unresolved::Absent { .. })
    ));
    assert!(matches!(
        store.resolve(&same_session),
        Err(Unresolved::Absent { .. })
    ));
    assert_eq!(pane_of(&store, &other).as_deref(), Some("forge-master-two"));
    assert_eq!(pane_of(&store, &new).as_deref(), Some("forge-master-proj"));
    done(&path);
}

/// A map another build wrote: an entry in a shape this build does not read, a
/// record carrying a field it does not know, and one from before the record.
/// Every pane this build can read keeps its capability, the unread entry is
/// honoured for nothing, and a write here keeps every entry as it was written.
#[test]
fn a_map_another_build_wrote_keeps_every_live_panes_capability() {
    let path = scratch();
    let written = serde_json::json!({
        "t-later": {"box": "b-1", "kind": "forge-box", "grants": ["view"]},
        "t-master": {"session": "s-1", "project": "p-1", "slug": "proj",
                     "pane": "forge-master-proj", "incarnation": "c-1:42:7"},
        "t-legacy": "s-0"
    });
    std::fs::write(&path, written.to_string()).unwrap();
    let store = SessionTokens::at(path.clone());

    assert_eq!(
        pane_of(&store, "t-master").as_deref(),
        Some("forge-master-proj")
    );
    assert!(matches!(
        store.resolve("t-legacy"),
        Ok(Holder::Legacy { session }) if session == "s-0"
    ));
    assert!(matches!(
        store.resolve("t-later"),
        Err(Unresolved::Absent { .. })
    ));
    assert!(store
        .answers_for("s-1", "p-1", "forge-master-proj")
        .unwrap());

    let job = store.mint("s-7", "p-2", "two", "forge-job-1").unwrap();
    store.settle(&job).unwrap();
    store.retire("s-0");
    let after: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(after["t-later"], written["t-later"]);
    assert_eq!(after["t-master"], written["t-master"]);
    assert!(after.get("t-legacy").is_none());
    assert_eq!(pane_of(&store, &job).as_deref(), Some("forge-job-1"));
    done(&path);
}

/// A map whose entries carry an empty value is still refused whole, as
/// ISS-1099 left it: a blank is damage, not another build's shape.
#[test]
fn an_entry_with_an_empty_value_still_refuses_the_map() {
    let path = scratch();
    std::fs::write(&path, r#"{"t-1": "  "}"#).unwrap();
    let store = SessionTokens::at(path.clone());
    assert!(matches!(
        store.resolve("t-1"),
        Err(Unresolved::Unreadable { .. })
    ));
    assert!(store
        .mint("s-1", "p-1", "proj", "forge-master-proj")
        .is_err());
    done(&path);
}
