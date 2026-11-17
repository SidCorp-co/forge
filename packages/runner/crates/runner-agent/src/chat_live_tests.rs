//! The live items read off real Claude Code 2.1.322 frames (`fixtures/stream-json/*.jsonl`, captured
//! from throwaway `claude -p --output-format stream-json --include-partial-messages` runs) and off
//! a planted status stream in the shapes 2.1.322's own schemas declare.
use super::*;

fn fixture(name: &str) -> Vec<Value> {
    let path = format!(
        "{}/fixtures/stream-json/{name}.jsonl",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{path}: {e}"))
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn items_of(lines: &[Value]) -> Vec<Value> {
    let mut batch = LiveBatch::default();
    for line in lines {
        live_items(line).into_iter().for_each(|i| batch.push(i));
    }
    batch.take().unwrap_or_default()
}

fn of_kind<'a>(items: &'a [Value], kind: &str) -> Vec<&'a Value> {
    items.iter().filter(|i| i["kind"] == kind).collect()
}

#[test]
fn a_reply_streams_as_its_deltas_joined_into_the_text_the_stored_line_keeps() {
    let lines = fixture("partial");
    let items = items_of(&lines);
    let stored = lines
        .iter()
        .find(|l| l["type"] == "assistant")
        .and_then(|l| l.pointer("/message/content/0/text"))
        .and_then(Value::as_str)
        .unwrap();
    let texts = of_kind(&items, "text");
    assert_eq!(
        texts.len(),
        1,
        "four deltas of one message join into one item: {items:?}"
    );
    assert_eq!(texts[0]["text"], stored);
    assert_eq!(texts[0]["parent"], Value::Null);
    assert_eq!(of_kind(&items, "message").len(), 1);
    assert_eq!(of_kind(&items, "messageEnd").len(), 1);
    let used = of_kind(&items, "context")[0]["used"].as_u64().unwrap();
    assert_eq!(
        used,
        2 + 11884 + 18857,
        "the context a request filled: fresh, cache read, cache written"
    );
    // the whole `assistant` line is the transcript's, never a live item
    assert!(lines
        .iter()
        .filter(|l| l["type"] == "assistant")
        .all(|l| live_items(l).is_empty()));
}

#[test]
fn a_planted_retry_compaction_and_rate_limit_each_say_what_the_status_line_shows() {
    let items = items_of(&fixture("planted-status"));
    let retry = of_kind(&items, "retry");
    assert_eq!(retry.len(), 1);
    assert_eq!(
        (
            retry[0]["attempt"].as_u64(),
            retry[0]["maxRetries"].as_u64()
        ),
        (Some(2), Some(10))
    );
    assert_eq!(retry[0]["errorStatus"], 529);
    let statuses: Vec<_> = of_kind(&items, "status")
        .iter()
        .map(|s| s["status"].clone())
        .collect();
    assert_eq!(
        statuses,
        vec![json!("requesting"), json!("compacting"), Value::Null]
    );
    let compacted = of_kind(&items, "compacted");
    assert_eq!(
        (
            compacted[0]["preTokens"].as_u64(),
            compacted[0]["postTokens"].as_u64()
        ),
        (Some(167_000), Some(21_000))
    );
    let limit = of_kind(&items, "rateLimit");
    assert_eq!(
        (limit[0]["status"].as_str(), limit[0]["resetsAt"].as_u64()),
        (Some("rejected"), Some(1_794_904_200))
    );
    assert_eq!(of_kind(&items, "ended")[0]["reason"], "completed");
    assert_eq!(of_kind(&items, "context")[0]["window"], 1_000_000);
    assert_eq!(
        of_kind(&items, "suggestion")[0]["text"],
        "Run the tests again"
    );
}

#[test]
fn an_allowed_rate_limit_says_nothing() {
    // every real turn ends with one; it holds nothing back
    let items = items_of(&fixture("partial"));
    assert!(of_kind(&items, "rateLimit").is_empty(), "{items:?}");
}

#[test]
fn text_of_two_messages_or_two_callers_is_never_joined() {
    let mut batch = LiveBatch::default();
    batch.push(json!({ "kind": "text", "text": "a", "parent": null }));
    batch.push(json!({ "kind": "text", "text": "b", "parent": "toolu_1" }));
    batch.push(json!({ "kind": "message", "id": "m2", "parent": null }));
    batch.push(json!({ "kind": "text", "text": "c", "parent": null }));
    batch.push(json!({ "kind": "text", "text": "d", "parent": null }));
    let items = batch.take().unwrap();
    let texts: Vec<_> = items.iter().filter_map(|i| i["text"].as_str()).collect();
    assert_eq!(texts, vec!["a", "b", "cd"]);
    assert!(batch.take().is_none(), "a taken batch is empty");
}
