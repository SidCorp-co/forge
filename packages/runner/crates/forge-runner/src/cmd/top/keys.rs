//! The keys a live view reads: space holds the page shown or lets pages turn
//! again, `n` and `p` turn it at once.
//!
//! A frame taller than the screen is shown a page per redraw, and at 80x24 the
//! box's frame is 23 pages, each replaced after one interval: a question of
//! two hundred words could not be read on screen (judge r3j, finding 78).
//!
//! The terminal's input is read without line buffering or echo while the view
//! runs, and given back as it was on every way out. ISIG is kept, so Ctrl-C is
//! still the interrupt the view ends on: `Interrupt::listen` has replaced its
//! default action before any mode is changed, so it comes back through the
//! loop, and the guard's `Drop` restores the mode. The release profile aborts
//! on a panic, where no `Drop` runs, so a panic hook restores it first.

/// What a key asks of the view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    /// Hold the page shown across redraws, or let pages turn again.
    Hold,
    Next,
    Previous,
}

/// The keys in bytes read off the terminal. Every other byte, an arrow's
/// escape sequence included, asks nothing.
pub fn parse(bytes: &[u8]) -> Vec<Key> {
    bytes
        .iter()
        .filter_map(|b| match b {
            b' ' => Some(Key::Hold),
            b'n' | b'N' => Some(Key::Next),
            b'p' | b'P' => Some(Key::Previous),
            _ => None,
        })
        .collect()
}

/// Keys as they are typed, for as long as the view runs.
pub struct Keys {
    rx: tokio::sync::mpsc::UnboundedReceiver<Key>,
    #[cfg(unix)]
    _raw: raw::Raw,
}

impl Keys {
    /// The next key, or `None` once stdin has ended.
    pub async fn next(&mut self) -> Option<Key> {
        self.rx.recv().await
    }
}

/// Keys read from stdin, or why they cannot be.
pub fn open() -> Result<Keys, String> {
    open_on_stdin()
}

#[cfg(unix)]
fn open_on_stdin() -> Result<Keys, String> {
    use std::io::{IsTerminal, Read};
    if !std::io::stdin().is_terminal() {
        return Err("stdin is not a terminal".into());
    }
    let raw = raw::Raw::enter(libc::STDIN_FILENO)
        .map_err(|e| format!("the terminal's input mode could not be set: {e}"))?;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    // A thread of its own, not tokio's stdin: a read blocked on a terminal
    // nobody types into would hold the runtime's shutdown for ever.
    std::thread::spawn(move || {
        let mut buf = [0u8; 64];
        let mut stdin = std::io::stdin();
        while let Ok(n) = stdin.read(&mut buf) {
            if n == 0 {
                return;
            }
            for key in parse(&buf[..n]) {
                if tx.send(key).is_err() {
                    return;
                }
            }
        }
    });
    Ok(Keys { rx, _raw: raw })
}

#[cfg(not(unix))]
fn open_on_stdin() -> Result<Keys, String> {
    Err("keys are read on a unix terminal only".into())
}

#[cfg(unix)]
mod raw {
    use std::sync::Mutex;

    /// The mode to give back if the process panics while the view runs.
    static SAVED: Mutex<Option<(i32, libc::termios)>> = Mutex::new(None);

    /// The terminal's input read a byte at a time and not echoed, for as long
    /// as this lives.
    pub struct Raw {
        fd: i32,
        saved: libc::termios,
    }

    impl Raw {
        pub fn enter(fd: i32) -> std::io::Result<Self> {
            // SAFETY: tcgetattr and tcsetattr on a descriptor this process
            // holds, with a termios this frame owns.
            let mut saved: libc::termios = unsafe { std::mem::zeroed() };
            if unsafe { libc::tcgetattr(fd, &mut saved) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
            let mut quiet = saved;
            quiet.c_lflag &= !(libc::ICANON | libc::ECHO);
            quiet.c_cc[libc::VMIN] = 1;
            quiet.c_cc[libc::VTIME] = 0;
            *SAVED.lock().unwrap_or_else(|e| e.into_inner()) = Some((fd, saved));
            hook_once();
            if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &quiet) } != 0 {
                let e = std::io::Error::last_os_error();
                *SAVED.lock().unwrap_or_else(|e| e.into_inner()) = None;
                return Err(e);
            }
            Ok(Self { fd, saved })
        }
    }

    impl Drop for Raw {
        fn drop(&mut self) {
            // SAFETY: as in `enter`, restoring the termios read there.
            unsafe { libc::tcsetattr(self.fd, libc::TCSANOW, &self.saved) };
            *SAVED.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }

    fn hook_once() {
        static HOOKED: std::sync::Once = std::sync::Once::new();
        HOOKED.call_once(|| {
            let before = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                if let Some((fd, saved)) = *SAVED.lock().unwrap_or_else(|e| e.into_inner()) {
                    // SAFETY: as in `Drop`.
                    unsafe { libc::tcsetattr(fd, libc::TCSANOW, &saved) };
                }
                before(info);
            }));
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Criteria 32, 34 and 35: space, `n` and `p` in either case are keys,
    /// and every other byte, an arrow's escape included, is none.
    #[test]
    fn space_n_and_p_are_keys_and_nothing_else_is() {
        assert_eq!(
            parse(b" nNpP"),
            vec![
                Key::Hold,
                Key::Next,
                Key::Next,
                Key::Previous,
                Key::Previous
            ]
        );
        assert!(parse(b"\x1b[C\x1b[Dq\r\x03x").is_empty());
    }
}
