// Which commit a build names (ISS-866), shared by build.rs (through `include!`) and the crate, so
// the order is tested where it runs. Plain items only: build.rs includes this file as a module body.

/// What a build names when neither its checkout nor the release workflow says which commit it is.
pub const UNKNOWN_COMMIT: &str = "unknown commit";

/// The commit a build names: the checkout's `HEAD` where git reads one, `-dirty` where the tree held
/// uncommitted changes as it was built; else the commit the release workflow stamped
/// (`FORGE_RUNNER_COMMIT`); else [`UNKNOWN_COMMIT`], never a stale value.
pub fn chosen_commit(head: Option<&str>, dirty: bool, stamped: Option<&str>) -> String {
    let clean = |s: Option<&str>| {
        s.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    match (clean(head), clean(stamped)) {
        (Some(sha), _) if dirty => format!("{sha}-dirty"),
        (Some(sha), _) => sha,
        (None, Some(stamp)) => stamp,
        (None, None) => UNKNOWN_COMMIT.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
    const STAMP: &str = "fedcba9876543210fedcba9876543210fedcba98";

    /// The order: the checkout's HEAD, marked dirty where it was; then the release stamp; then
    /// `unknown commit` by name, never empty and never the bare `unknown` of before.
    #[test]
    fn a_build_names_its_head_then_the_stamp_then_unknown_commit() {
        assert_eq!(chosen_commit(Some(SHA), false, Some(STAMP)), SHA);
        assert_eq!(
            chosen_commit(Some(SHA), true, Some(STAMP)),
            format!("{SHA}-dirty")
        );
        assert_eq!(chosen_commit(None, false, Some(STAMP)), STAMP);
        assert_eq!(chosen_commit(Some("  "), true, Some(STAMP)), STAMP);
        assert_eq!(chosen_commit(None, false, None), "unknown commit");
        assert_eq!(chosen_commit(None, true, Some("")), UNKNOWN_COMMIT);
    }

    #[test]
    fn an_unknown_commit_is_read_as_no_commit() {
        assert_eq!(crate::commit_or_none(UNKNOWN_COMMIT), None);
        assert_eq!(crate::commit_or_none("unknown"), None);
        assert_eq!(
            crate::commit_or_none(&format!("{SHA}-dirty")),
            Some(&*format!("{SHA}-dirty"))
        );
    }
}
