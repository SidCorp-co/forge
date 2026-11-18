//! Which CDP methods an attached session may call while a person holds the box (ISS-1322): the
//! one place the set is named. A read changes nothing a person sees and answers while they hold
//! the box; every other method is a write, refused `BOX_HELD_BY_PERSON` while they hold it and
//! reported into the box's act feed when it passes. The set fails closed, like the act door's
//! `BOX_READ_VERBS`: a method not named here is a write. So `Input.*`, `Page.navigate`,
//! `Page.reload`, `Runtime.evaluate`, `Runtime.callFunctionOn`, `Emulation.*`, `Target.createTarget`
//! and every method a later Chrome adds are writes.

/// Reads named one by one: attaching to targets, screenshots, node lookups, releasing handles.
const READS: &[&str] = &[
    "Target.setDiscoverTargets",
    "Target.setAutoAttach",
    "Target.attachToTarget",
    "Target.attachToBrowserTarget",
    "Target.detachFromTarget",
    // a target auto-attach paused waits for this; it resumes the page as it was
    "Runtime.runIfWaitingForDebugger",
    "Runtime.releaseObject",
    "Runtime.releaseObjectGroup",
    "Page.captureScreenshot",
    "Page.captureSnapshot",
    "Page.setLifecycleEventsEnabled",
    "Page.createIsolatedWorld",
    "DOM.describeNode",
    "DOM.querySelector",
    "DOM.querySelectorAll",
    "DOM.resolveNode",
    "DOM.requestChildNodes",
    "DOM.pushNodesByBackendIdsToFrontend",
    "Accessibility.queryAXTree",
];

/// Methods the name rules below would read as reads that change what the page does: `Fetch.enable`
/// pauses the page's requests until a write continues them.
const NOT_READS: &[&str] = &["Fetch.enable"];

/// Whether `method` only reads: a domain's `enable` or `disable`, a `get…`, or one of [`READS`].
pub fn is_read(method: &str) -> bool {
    if NOT_READS.contains(&method) {
        return false;
    }
    let Some((domain, name)) = method.split_once('.') else {
        return false;
    };
    if domain.is_empty() || name.is_empty() {
        return false;
    }
    name == "enable"
        || name == "disable"
        || (name.starts_with("get") && name[3..].starts_with(|c: char| c.is_ascii_uppercase()))
        || READS.contains(&method)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_navigation_and_script_are_writes_and_an_unknown_method_fails_closed() {
        for w in [
            "Input.dispatchMouseEvent",
            "Input.insertText",
            "Page.navigate",
            "Page.reload",
            "Runtime.evaluate",
            "Runtime.callFunctionOn",
            "Emulation.setDeviceMetricsOverride",
            "Target.createTarget",
            "Fetch.enable",
            "Page.someMethodChromeAddsLater",
            "Page.getaway",
            "nodomain",
            ".enable",
        ] {
            assert!(!is_read(w), "{w} is a write");
        }
        for r in [
            "Page.enable",
            "Network.disable",
            "Runtime.getProperties",
            "Accessibility.getFullAXTree",
            "Target.setAutoAttach",
            "Page.captureScreenshot",
            "DOM.querySelector",
        ] {
            assert!(is_read(r), "{r} is a read");
        }
    }
}
