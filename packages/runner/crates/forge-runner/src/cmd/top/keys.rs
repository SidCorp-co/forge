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

/// Keys out of the bytes a terminal sends, read by read. Space, `n` and `p`
/// are keys; every other byte asks nothing, and so does every byte of an
/// escape sequence, since a function key's ends in a letter (F1 is `ESC O P`)
/// and a sequence can be split across two reads (whole-set read at 2afe197,
/// F1). Alt and a letter comes as `ESC` and the letter, and is not that key.
#[derive(Debug, Default)]
pub struct Parser {
    within: Within,
}

/// Where a parser stands inside an escape sequence.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Within {
    #[default]
    Nothing,
    /// After `ESC`: the next byte says what the sequence is.
    Escape,
    /// After `ESC [`: parameters, up to the final byte `@` to `~`.
    Csi,
    /// After `ESC O`: one byte more ends it.
    Ss3,
}

impl Parser {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Key> {
        let mut keys = Vec::new();
        for &b in bytes {
            self.within = match (self.within, b) {
                (Within::Nothing, 0x1b) => Within::Escape,
                (Within::Nothing, b) => {
                    keys.extend(match b {
                        b' ' => Some(Key::Hold),
                        b'n' | b'N' => Some(Key::Next),
                        b'p' | b'P' => Some(Key::Previous),
                        _ => None,
                    });
                    Within::Nothing
                }
                (Within::Escape, b'[') => Within::Csi,
                (Within::Escape, b'O') => Within::Ss3,
                (Within::Escape, 0x1b) => Within::Escape,
                (Within::Escape, _) | (Within::Ss3, _) => Within::Nothing,
                (Within::Csi, 0x40..=0x7e) => Within::Nothing,
                (Within::Csi, _) => Within::Csi,
            };
        }
        keys
    }
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
        let mut parser = Parser::default();
        while let Ok(n) = stdin.read(&mut buf) {
            if n == 0 {
                return;
            }
            for key in parser.feed(&buf[..n]) {
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
            Parser::default().feed(b" nNpP"),
            vec![
                Key::Hold,
                Key::Next,
                Key::Next,
                Key::Previous,
                Key::Previous
            ]
        );
        assert!(Parser::default().feed(b"\x1b[C\x1b[Dq\r\x03x").is_empty());
    }

    /// Whole-set read at 2afe197, F1: a function key's sequence ends in a
    /// letter (F1 is `ESC O P`, a modified arrow `ESC [ 1 ; 5 P`), and none of
    /// its bytes is a key, whole or split across two reads; a key after it is.
    #[test]
    fn no_byte_of_an_escape_sequence_is_a_key() {
        let mut keys = Parser::default();
        assert!(keys.feed(b"\x1bOP\x1bOQ\x1bOR\x1bOS").is_empty());
        assert!(keys.feed(b"\x1b[1;5P\x1b[15~\x1b[2;3N").is_empty());
        assert!(keys.feed(b"\x1bO").is_empty());
        assert_eq!(keys.feed(b"Pp"), vec![Key::Previous]);
        assert!(keys.feed(b"\x1b[1;").is_empty());
        assert_eq!(keys.feed(b"2Pn "), vec![Key::Next, Key::Hold]);
        // Alt and a letter is ESC and the letter, and is not that key.
        assert!(keys.feed(b"\x1bn\x1bp").is_empty());
        assert_eq!(keys.feed(b"n"), vec![Key::Next]);
    }
}
