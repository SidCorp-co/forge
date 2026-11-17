//! The two things the permissions builder (ISS-1268 B3, B4) owns that this transport carries: the
//! `PermissionRequest` relay hook block a session's settings take, and the framing a relayed
//! owner's word is sent in. The transport calls these and nothing else of theirs.

/// The `hooks` block of a background session's settings ([`super::launch::settings_doc`]), or
/// `None` where no relay is installed.
///
/// PLACEHOLDER until B3 lands it: no hook block, so a prompt that still appears is left to the
/// project's own `PermissionRequest` hook (`runner_core::dialog_answer`) and the watcher.
pub fn relay_hooks() -> Option<serde_json::Value> {
    None
}

/// An owner's word relayed to a session, framed with the authority it carries (B4).
///
/// PLACEHOLDER until B4 lands its measured text: the orchestrator's framing that was acted on 6 of
/// 6 times for a harmless act (ISS-1268 comment f095f341).
pub fn owner_word(text: &str) -> String {
    format!("Forge runner relaying the owner's instruction: {text}")
}

/// Canary checks 4 and 5 (ISS-1268 C1): a planted dangerous-rm relayed, allowed and denied, and a
/// relay that times out answered loudly. Run in the canary's trusted scratch checkout `work` on
/// `model`.
///
/// PLACEHOLDER until B3 lands them: both fail by name, so no canary passes without them.
pub async fn canary_checks(work: &std::path::Path, model: &str) -> Vec<super::canary::Check> {
    let _ = (work, model);
    ["relay allow/deny", "relay timeout"]
        .into_iter()
        .map(|name| super::canary::Check::fail(name, "not supplied yet (ISS-1268 B3)"))
        .collect()
}
