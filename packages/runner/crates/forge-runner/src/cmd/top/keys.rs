//! The keys a live view reads: the arrows, `j` and `k` move the table's
//! selection, Enter opens the selected row's detail and Esc leaves it, `s`
//! shows each row's sources, `l` switches the legend between its full and
//! short forms, `q` ends the view; in a detail, space holds the
//! page shown or lets pages turn again, `n` and `p` turn it at once.
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

// Keys are read on unix alone; elsewhere the view says so, and the parser and
// the keys it makes are the unix reader's only.
#![cfg_attr(not(unix), allow(dead_code))]

/// What a key asks of the view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    /// Hold the page shown across redraws, or let pages turn again.
    Hold,
    Next,
    Previous,
    Up,
    Down,
    /// Open the selected row's detail.
    Open,
    /// Leave a detail for the table: a lone Esc.
    Back,
    /// Show or hide each row's sources.
    Sources,
    /// The legend's other form: the full one, or the short one.
    Legend,
    Quit,
}

/// Keys out of the bytes a terminal sends, read by read. Space, `n`, `p`,
/// `j`, `k`, `s`, `l`, `q` and Enter are keys, and so are the up and down arrows
/// (`ESC [ A`, `ESC O A` and their modified forms); every other byte asks
/// nothing, and so does every other byte of an escape sequence, since a
/// function key's ends in a letter (F1 is `ESC O P`) and a sequence can be
/// split across two reads (whole-set read at 2afe197, F1). Alt and a letter
/// comes as `ESC` and the letter, and is not that key. A lone `ESC` is told
/// from the start of a sequence by nothing following it: `idle` says so.
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
                        b'k' | b'K' => Some(Key::Up),
                        b'j' | b'J' => Some(Key::Down),
                        b'\r' | b'\n' => Some(Key::Open),
                        b's' | b'S' => Some(Key::Sources),
                        b'l' | b'L' => Some(Key::Legend),
                        b'q' | b'Q' => Some(Key::Quit),
                        _ => None,
                    });
                    Within::Nothing
                }
                (Within::Escape, b'[') => Within::Csi,
                (Within::Escape, b'O') => Within::Ss3,
                // A second ESC: the first was a lone one.
                (Within::Escape, 0x1b) => {
                    keys.push(Key::Back);
                    Within::Escape
                }
                (Within::Escape, _) => Within::Nothing,
                (Within::Ss3, b) | (Within::Csi, b @ 0x40..=0x7e) => {
                    keys.extend(arrow(b));
                    Within::Nothing
                }
                (Within::Csi, _) => Within::Csi,
            };
        }
        keys
    }

    /// Whether the last byte fed left an `ESC` with nothing after it yet.
    pub fn after_escape(&self) -> bool {
        self.within == Within::Escape
    }

    /// Nothing followed the bytes fed so far within the wait a sequence's
    /// bytes arrive in: an `ESC` standing alone is the Esc key, and a
    /// sequence left unfinished asks nothing.
    pub fn idle(&mut self) -> Option<Key> {
        let lone = self.within == Within::Escape;
        self.within = Within::Nothing;
        lone.then_some(Key::Back)
    }
}

/// The key a cursor sequence's final byte names: up and down, and no other.
fn arrow(last: u8) -> Option<Key> {
    match last {
        b'A' => Some(Key::Up),
        b'B' => Some(Key::Down),
        _ => None,
    }
}

/// How long a lone `ESC` waits for the rest of a sequence before it is the
/// Esc key: a terminal writes a sequence's bytes in one write.
#[cfg(unix)]
const ESCAPE_WAIT_MS: i32 = 40;

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
            let mut keys = parser.feed(&buf[..n]);
            if parser.after_escape() && !input_within(ESCAPE_WAIT_MS) {
                keys.extend(parser.idle());
            }
            for key in keys {
                if tx.send(key).is_err() {
                    return;
                }
            }
        }
    });
    Ok(Keys { rx, _raw: raw })
}

/// Whether stdin has a byte to read within `ms`.
#[cfg(unix)]
fn input_within(ms: i32) -> bool {
    let mut fd = libc::pollfd {
        fd: libc::STDIN_FILENO,
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: poll on one pollfd this frame owns, for a descriptor the
    // process holds.
    unsafe { libc::poll(&mut fd, 1, ms) > 0 }
}

#[cfg(not(unix))]
fn open_on_stdin() -> Result<Keys, String> {
    Err("keys are read on a unix terminal only".into())
}

#[cfg(unix)]
mod raw {
    use std::sync::Mutex;

    /// The value that turns a terminal's control character off.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const DISABLED: libc::cc_t = libc::_POSIX_VDISABLE;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    const DISABLED: libc::cc_t = 0xff;

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
            // Ctrl-C stays the interrupt; Ctrl-\ and Ctrl-Z would quit or stop
            // the view past the loop that gives the mode back, leaving the
            // shell a terminal that neither echoes nor edits a line (whole-set
            // read at 2b6a996, F1), so while the view runs they send nothing.
            quiet.c_cc[libc::VQUIT] = DISABLED;
            quiet.c_cc[libc::VSUSP] = DISABLED;
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

    /// ISS-1341's criteria 32, 34 and 35 and ISS-1369's 17, 19, 21 and 24:
    /// space, `n`, `p`, `j`, `k`, `s`, `q` and Enter are keys in either case,
    /// the up and down arrows are keys in every form a terminal sends, and
    /// every other byte, the left and right arrows' included, is none.
    #[test]
    fn the_view_s_keys_are_keys_and_nothing_else_is() {
        use Key::*;
        assert_eq!(
            Parser::default().feed(b" nNpPkKjJsSqQ\r\n"),
            vec![
                Hold, Next, Next, Previous, Previous, Up, Up, Down, Down, Sources, Sources, Quit,
                Quit, Open, Open
            ]
        );
        assert_eq!(
            Parser::default().feed(b"\x1b[A\x1b[B\x1bOA\x1bOB\x1b[1;5A"),
            vec![Up, Down, Up, Down, Up]
        );
        assert!(Parser::default()
            .feed(b"\x1b[C\x1b[D\x1bOC\x03x\t")
            .is_empty());
    }

    /// Criterion 20: an `ESC` nothing follows is Esc; one a sequence follows,
    /// or Alt and a letter, is not; two in a row are one Esc and a start.
    #[test]
    fn a_lone_escape_is_esc_and_a_sequence_is_not() {
        let mut keys = Parser::default();
        assert!(keys.feed(b"\x1b").is_empty());
        assert!(keys.after_escape());
        assert_eq!(keys.idle(), Some(Key::Back));
        assert!(!keys.after_escape());
        assert_eq!(keys.idle(), None, "nothing pending");
        assert_eq!(keys.feed(b"\x1b\x1b"), vec![Key::Back]);
        assert_eq!(keys.idle(), Some(Key::Back));
        // A sequence split after its ESC is still the sequence.
        assert!(keys.feed(b"\x1b").is_empty());
        assert_eq!(keys.feed(b"[A"), vec![Key::Up]);
        // One cut before its end asks nothing, and the next key is a key.
        assert!(keys.feed(b"\x1b[1;").is_empty());
        assert_eq!(keys.idle(), None);
        assert_eq!(keys.feed(b"q"), vec![Key::Quit]);
        assert!(keys.feed(b"\x1bq").is_empty(), "Alt and q is not q");
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
