//! Deep-merge for `serde_json::Value`. Used by `save_config` so that
//! Zustand-snapshot saves preserve keys a user added by hand to
//! `~/.config/forge-beta/config.json` (see ISS-282).
//!
//! Semantics — mirrors lodash `merge` with one twist:
//! - Object ⊕ Object → recurse per-key (existing keys not in patch survive).
//! - Array → replace.
//! - Scalar → replace.
//! - **null in patch → skip** (treat as "no-op"). The Zustand snapshot
//!   serializes absent `Option` fields as `null`; treating them as a no-op
//!   prevents wiping a value the user may have set on disk.
//!
//! Removing keys is therefore not expressible via UI saves — that is the
//! explicit tradeoff for preserving hand-added keys.

use serde_json::Value;

pub fn deep_merge(target: &mut Value, patch: Value) {
    match patch {
        Value::Null => {}
        Value::Object(patch_map) => {
            if !matches!(target, Value::Object(_)) {
                *target = Value::Object(Default::default());
            }
            let target_map = target.as_object_mut().expect("ensured Object above");
            for (k, v) in patch_map {
                match target_map.get_mut(&k) {
                    Some(existing) => deep_merge(existing, v),
                    None => {
                        if !v.is_null() {
                            target_map.insert(k, v);
                        }
                    }
                }
            }
        }
        other => *target = other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_unknown_top_level_key() {
        let mut target = json!({ "customField": "x", "coreUrl": "old" });
        deep_merge(&mut target, json!({ "coreUrl": "new" }));
        assert_eq!(target["customField"], "x");
        assert_eq!(target["coreUrl"], "new");
    }

    #[test]
    fn preserves_unknown_nested_key() {
        let mut target = json!({
            "projects": { "apiflow": { "path": "/foo" }, "old": { "path": "/bar" } }
        });
        deep_merge(&mut target, json!({
            "projects": { "old": { "path": "/baz" } }
        }));
        assert_eq!(target["projects"]["apiflow"]["path"], "/foo");
        assert_eq!(target["projects"]["old"]["path"], "/baz");
    }

    #[test]
    fn null_in_patch_is_no_op() {
        let mut target = json!({ "projectsRoot": "/keep" });
        deep_merge(&mut target, json!({ "projectsRoot": null }));
        assert_eq!(target["projectsRoot"], "/keep");
    }

    #[test]
    fn arrays_are_replaced_not_merged() {
        let mut target = json!({ "list": [1, 2, 3] });
        deep_merge(&mut target, json!({ "list": [9] }));
        assert_eq!(target["list"], json!([9]));
    }

    #[test]
    fn adds_new_field() {
        let mut target = json!({ "coreUrl": "http://x" });
        deep_merge(&mut target, json!({ "claudeMode": "max" }));
        assert_eq!(target["claudeMode"], "max");
    }

    #[test]
    fn scalar_replaces_object() {
        let mut target = json!({ "x": { "nested": true } });
        deep_merge(&mut target, json!({ "x": "scalar" }));
        assert_eq!(target["x"], "scalar");
    }
}
