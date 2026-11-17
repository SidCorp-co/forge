//! The X display a desktop box takes: the first free one in `[box]`'s range, never :99, which
//! `~/agent-display` serves a person's live desktop on. A display is free when neither its socket
//! nor its lock file exists; one this runner is starting is held in [`Taken`] until its Xvfb owns
//! the socket, so two boxes opening at once never pick the same one.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Mutex;

use runner_platform::box_settings::FORBIDDEN_DISPLAY;

/// The displays this runner is between choosing and starting.
#[derive(Default)]
pub struct Taken(Mutex<BTreeSet<u32>>);

/// Where X keeps a display's socket and lock: `/tmp` on a real host.
pub struct XDirs {
    pub sockets: PathBuf,
    pub locks: PathBuf,
}

impl Default for XDirs {
    fn default() -> Self {
        Self {
            sockets: PathBuf::from("/tmp/.X11-unix"),
            locks: PathBuf::from("/tmp"),
        }
    }
}

impl XDirs {
    fn in_use(&self, n: u32) -> bool {
        self.sockets.join(format!("X{n}")).exists()
            || self.locks.join(format!(".X{n}-lock")).exists()
    }
}

impl Taken {
    /// Give a chosen display back: its Xvfb holds it now, or it never started.
    pub fn release(&self, n: u32) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).remove(&n);
    }
}

/// The first display in `first..=last` that is free, never [`FORBIDDEN_DISPLAY`]; or why none is.
/// It stays taken until [`Taken::release`].
pub fn pick(first: u32, last: u32, x: &XDirs, taken: &Taken) -> Result<u32, String> {
    let mut held = taken.0.lock().unwrap_or_else(|p| p.into_inner());
    let number = (first..=last)
        .filter(|n| allowed(*n))
        .find(|n| !held.contains(n) && !x.in_use(*n))
        .ok_or_else(|| {
            format!(
                "no free X display in :{first}..:{last} (:{FORBIDDEN_DISPLAY} is never used): every one has a socket or lock under {}",
                x.sockets.display()
            )
        })?;
    held.insert(number);
    Ok(number)
}

/// Whether a box may ever take display `n`.
pub fn allowed(n: u32) -> bool {
    n != FORBIDDEN_DISPLAY
}

/// Whether display `n`'s socket is up.
pub fn is_up(x: &XDirs, n: u32) -> bool {
    x.sockets.join(format!("X{n}")).exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Scratch;
    use std::path::Path;

    fn plant(dir: &Path, n: u32) {
        std::fs::write(dir.join(format!(".X{n}-lock")), b"").unwrap();
    }

    fn dirs(root: &Path) -> XDirs {
        let sockets = root.join(".X11-unix");
        std::fs::create_dir_all(&sockets).unwrap();
        XDirs {
            sockets,
            locks: root.to_path_buf(),
        }
    }

    #[test]
    fn display_99_is_never_chosen_even_when_it_is_the_only_free_one_in_range() {
        let root = Scratch::new("display");
        let x = dirs(root.path());
        let taken = Taken::default();
        for n in 95..=103 {
            if n != 99 {
                plant(&x.locks, n);
            }
        }
        assert!(
            !x.in_use(99),
            ":99 is free here, so only the rule keeps a box off it"
        );
        let err = pick(95, 103, &x, &taken).expect_err("no display is free but :99");
        assert!(err.contains(":99 is never used"), "{err}");
        // a range of :99 alone is no range at all
        assert!(pick(99, 99, &x, &taken).is_err());
    }

    #[test]
    fn the_first_free_display_is_taken_and_a_second_box_gets_the_next() {
        let root = Scratch::new("display");
        let x = dirs(root.path());
        let taken = Taken::default();
        plant(&x.locks, 98);
        std::fs::write(x.sockets.join("X100"), b"").unwrap();
        let a = pick(98, 102, &x, &taken).unwrap();
        assert_eq!(a, 101, ":98 locked, :99 forbidden, :100 has a socket");
        assert_eq!(pick(98, 102, &x, &taken).unwrap(), 102);
        taken.release(a);
        assert_eq!(pick(98, 102, &x, &taken).unwrap(), 101);
    }
}
