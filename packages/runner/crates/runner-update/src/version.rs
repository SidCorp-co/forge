//! How release versions order, and which release a build came from.
//!
//! The dev line (ISS-1358) is cut as `X.Y.Z-dev.N` where X.Y.Z is `main`'s newest
//! release on the line: a dev build is that release plus what landed on `dev`
//! since, so it sorts ABOVE X.Y.Z and below the next release. Core orders the
//! versions it serves the same way (`fetch-release.ts`'s `cmpVersion`).

/// `latest` sorts above `current`: X.Y.Z compared as numbers, then a dev-line
/// build (`-dev.N`) above the same X.Y.Z released, and any other pre-release
/// (`-rc.1`) below it, then the pre-release identifiers one by one, numeric ones
/// as numbers and below any alphanumeric one. Build metadata (`+…`) is ignored.
/// So a box on `0.9.10-rc.1` takes `0.9.10`, a box on `0.18.0-dev.5` never takes
/// `main`'s `0.18.0`, a box on `0.18.0` takes `0.18.0-dev.1`, and `-dev.10` is
/// newer than `-dev.9`.
pub fn is_newer(latest: &str, current: &str) -> bool {
    precedence(latest) > precedence(current)
}

/// One pre-release identifier: numeric sorts below alphanumeric.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Ident {
    Num(u64),
    Alpha(String),
}

/// Where a build sorts among builds of one X.Y.Z.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Rank {
    /// `-rc.1` and every pre-release but the dev line's: below the release.
    PreRelease,
    Release,
    /// `-dev.N`: the release plus what landed on `dev` since.
    Dev,
}

/// The ordering key of a version.
fn precedence(v: &str) -> ((u64, u64, u64), Rank, Vec<Ident>) {
    let v = v.trim().trim_start_matches('v');
    let v = v.split('+').next().unwrap_or("");
    let (core, pre) = match v.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (v, None),
    };
    let mut it = core.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
    let xyz = (
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
    );
    let idents: Vec<Ident> = pre
        .unwrap_or("")
        .split('.')
        .filter(|p| !p.is_empty())
        .map(|p| match p.parse::<u64>() {
            Ok(n) => Ident::Num(n),
            Err(_) => Ident::Alpha(p.to_string()),
        })
        .collect();
    let rank = match (pre, idents.first()) {
        (None, _) => Rank::Release,
        (Some(_), Some(Ident::Alpha(a))) if a == "dev" => Rank::Dev,
        (Some(_), _) => Rank::PreRelease,
    };
    (xyz, rank, idents)
}

/// The release this build came from, or `None` for a build no release made.
pub fn release() -> Option<&'static str> {
    release_of(crate::BUILD_RELEASE)
}

fn release_of(raw: &str) -> Option<&str> {
    Some(raw.trim()).filter(|r| !r.is_empty())
}

/// What `forge-runner status` says of the release a binary came from: its tag
/// and line, or that no release made it, which is the truth about a hand build.
pub fn release_line(release: Option<&str>) -> String {
    match release {
        Some(tag) if tag.contains("-dev.") => format!("{tag} (dev channel)"),
        Some(tag) => format!("{tag} (main channel)"),
        None => "none — no release built this binary; it is a hand build".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ISS-1358: a dev-channel build `X.Y.Z-dev.N` is release X.Y.Z plus what landed on `dev`
    /// since, so it sorts above X.Y.Z and below the next release. Each pair reads (served,
    /// running, whether the box takes it).
    #[test]
    fn a_dev_build_sorts_above_its_release_and_below_the_next() {
        let pairs = [
            // a hand-built box on Cargo's 0.18.0 takes the first dev build
            ("0.18.0-dev.1", "0.18.0", true),
            // a box on the dev line never goes back to main's build of the same number
            ("0.18.0", "0.18.0-dev.5", false),
            // nor to an older main line
            ("0.17.143", "0.18.0-dev.1", false),
            // and never skips a newer dev build, counted as a number
            ("0.18.0-dev.10", "0.18.0-dev.9", true),
            ("0.18.1-dev.1", "0.18.0-dev.10", true),
            // main's next release is above every dev build of the one before
            ("0.18.1", "0.18.0-dev.10", true),
            // other pre-releases stay below their release
            ("0.9.10", "0.9.10-rc.1", true),
            ("0.9.10-rc.1", "0.9.10", false),
            ("0.18.0-dev.3", "0.18.0-dev.3", false),
        ];
        for (latest, current, newer) in pairs {
            assert_eq!(
                is_newer(latest, current),
                newer,
                "is_newer({latest:?}, {current:?})"
            );
        }
    }

    #[test]
    fn a_build_names_the_release_it_came_from_and_its_line() {
        assert_eq!(release_of("  "), None);
        assert_eq!(
            release_of("runner-v0.18.0-dev.3\n"),
            Some("runner-v0.18.0-dev.3")
        );
        assert_eq!(
            release_line(Some("runner-v0.18.0-dev.3")),
            "runner-v0.18.0-dev.3 (dev channel)"
        );
        assert_eq!(
            release_line(Some("runner-v0.17.143")),
            "runner-v0.17.143 (main channel)"
        );
        assert!(release_line(None).contains("hand build"));
    }
}
