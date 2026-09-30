//! A live frame, fitted to the terminal it is redrawn on.
//!
//! The view redraws in place, so a frame taller than the screen scrolls its
//! top away on every redraw, and a line wider than the screen wraps into rows
//! nothing counted: at 120x40 the box's 137-line frame took 217 rows, and only
//! its last 25 stayed in view (judge at d7da543). Here every line is wrapped to
//! the screen's width, so nothing is cut, and a frame taller than the screen
//! is shown one page per redraw, the page it is on said under the header.

/// A terminal's size in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Screen {
    pub cols: usize,
    pub rows: usize,
}

/// The size of the terminal stdout is, or `None` where it cannot be read.
#[cfg(unix)]
pub fn size() -> Option<Screen> {
    // SAFETY: TIOCGWINSZ writes one `winsize` through the pointer, which
    // points at a zeroed one this frame owns.
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) };
    (rc == 0 && ws.ws_col > 0 && ws.ws_row > 0).then_some(Screen {
        cols: usize::from(ws.ws_col),
        rows: usize::from(ws.ws_row),
    })
}

#[cfg(not(unix))]
pub fn size() -> Option<Screen> {
    None
}

/// What one redraw shows, and the page the next one starts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shown {
    pub rows: Vec<String>,
    pub next: usize,
}

/// One screenful of `frame`, whose first line is its header. `page` counts
/// redraws, so it is taken modulo however many pages this frame needs.
pub fn screen(frame: &[String], size: Option<Screen>, page: usize) -> Shown {
    let Some(size) = size else {
        let mut rows = frame.to_vec();
        rows.insert(
            1.min(rows.len()),
            "the screen's size could not be read, so this frame is not fitted to it".into(),
        );
        return Shown { rows, next: 0 };
    };
    let (header, body) = match frame.split_first() {
        Some((h, b)) => (wrap(h, size.cols), b),
        None => (Vec::new(), frame),
    };
    let body: Vec<String> = body.iter().flat_map(|l| wrap(l, size.cols)).collect();
    let total = header.len() + body.len();
    if total <= size.rows {
        let mut rows = header;
        rows.extend(body);
        return Shown { rows, next: 0 };
    }
    // The status row's height depends on the page count it states, and the
    // page count on the room the status row leaves: settle it in two passes.
    let (mut status, mut room, mut pages) = (Vec::new(), 1, 1);
    let mut status_rows = 1;
    for _ in 0..2 {
        room = size.rows.saturating_sub(header.len() + status_rows).max(1);
        pages = body.len().div_ceil(room).max(1);
        status = wrap(
            &format!(
                "page {} of {pages} — {total} rows on this {}x{} screen, one page per redraw; `forge-runner top --once | less` reads it whole",
                page % pages + 1,
                size.cols,
                size.rows
            ),
            size.cols,
        );
        if status.len() == status_rows {
            break;
        }
        status_rows = status.len();
    }
    let at = page % pages;
    let mut rows = header;
    rows.extend(status);
    rows.extend(body.into_iter().skip(at * room).take(room));
    Shown {
        rows,
        next: (at + 1) % pages,
    }
}

/// `line` as rows no wider than `width`, broken at a space where one falls in
/// the row and mid-word where none does; a continued row is indented two past
/// the line's own indent. Nothing of the line is dropped but the spaces a
/// break falls on.
pub fn wrap(line: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= width {
        return vec![line.to_string()];
    }
    let indent = chars.iter().take_while(|c| **c == ' ').count();
    let hang = (indent + 2).min(width / 2);
    let mut out = Vec::new();
    let (mut start, mut pad) = (0, 0);
    while start < chars.len() {
        let room = width - pad;
        let lead = " ".repeat(pad);
        if chars.len() - start <= room {
            out.push(format!(
                "{lead}{}",
                chars[start..].iter().collect::<String>()
            ));
            break;
        }
        // One past the room: a space there ends a row that fills it exactly.
        let window = &chars[start..=start + room];
        // The first row never breaks inside its own indent.
        let least = if start == 0 { indent } else { 0 };
        let cut = window
            .iter()
            .rposition(|c| *c == ' ')
            .filter(|&i| i > least)
            .unwrap_or(room);
        let row: String = chars[start..start + cut].iter().collect();
        out.push(format!("{lead}{}", row.trim_end()));
        start += cut;
        while start < chars.len() && chars[start] == ' ' {
            start += 1;
        }
        pad = hang;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn widest(rows: &[String]) -> usize {
        rows.iter().map(|r| r.chars().count()).max().unwrap_or(0)
    }

    fn words(rows: &[String]) -> String {
        rows.iter().map(|r| r.trim()).collect::<Vec<_>>().join(" ")
    }

    /// A line wider than the screen is wrapped, never cut: every word it held
    /// is on some row, and no row is wider than the screen.
    #[test]
    fn a_wide_line_wraps_whole_and_within_the_width() {
        let line = format!(
            "      human blocker, asked 3h ago, question q-1: {}waiting for ISS-45",
            "the prompt runs on ".repeat(12)
        );
        let rows = wrap(&line, 40);
        assert!(rows.len() > 1, "{rows:?}");
        assert!(widest(&rows) <= 40, "{rows:?}");
        assert_eq!(
            words(&rows),
            line.split_whitespace().collect::<Vec<_>>().join(" ")
        );
        assert!(
            rows[1].starts_with("        "),
            "hangs past its indent: {rows:?}"
        );
        assert!(rows.last().unwrap().ends_with("ISS-45"), "{rows:?}");
    }

    /// A word longer than the room is broken inside itself rather than let
    /// past the edge.
    #[test]
    fn a_word_longer_than_the_width_is_broken_inside_itself() {
        let rows = wrap(&"x".repeat(25), 10);
        assert_eq!(rows.concat().replace(' ', ""), "x".repeat(25));
        assert!(widest(&rows) <= 10, "{rows:?}");
    }

    /// Boundary: a line exactly the width is one row, one past it is two.
    #[test]
    fn a_line_of_exactly_the_width_is_one_row() {
        assert_eq!(wrap(&"a".repeat(12), 12).len(), 1);
        assert_eq!(wrap("aaaaa bbbbbb", 12), vec!["aaaaa bbbbbb".to_string()]);
        assert_eq!(
            wrap("aaaaa bbbbbbb", 12),
            vec!["aaaaa".to_string(), "  bbbbbbb".to_string()]
        );
    }

    fn frame(lines: usize, width: usize) -> Vec<String> {
        let mut f = vec!["forge-runner top — box, read-only".to_string()];
        f.extend((1..lines).map(|i| format!("  line {i:03} {}", "w ".repeat(width / 2))));
        f
    }

    /// A frame that fits is drawn as it is, with no page row.
    #[test]
    fn a_frame_that_fits_is_one_page() {
        let f = frame(10, 5);
        let s = screen(&f, Some(Screen { cols: 80, rows: 24 }), 7);
        assert_eq!(s.rows, f);
        assert_eq!(s.next, 0);
    }

    /// The judge's shape: a frame of many over-wide lines on 120x40 is drawn
    /// a page at a time, every page within 40 rows of 120 columns, and the
    /// pages together hold every row of the frame once.
    #[test]
    fn a_frame_taller_than_the_screen_is_paged_and_every_row_is_shown_once() {
        let f = frame(137, 150);
        let size = Some(Screen {
            cols: 120,
            rows: 40,
        });
        let body: Vec<String> = f[1..].iter().flat_map(|l| wrap(l, 120)).collect();
        let (mut page, mut seen) = (0, Vec::new());
        loop {
            let s = screen(&f, size, page);
            assert!(s.rows.len() <= 40, "{} rows", s.rows.len());
            assert!(widest(&s.rows) <= 120);
            assert_eq!(s.rows[0], f[0], "the header heads every page");
            assert!(
                s.rows[1].starts_with(&format!("page {} of ", page + 1)),
                "{}",
                s.rows[1]
            );
            assert!(s.rows[1].contains("--once"), "{}", s.rows[1]);
            seen.extend(s.rows.into_iter().skip(2));
            page = s.next;
            if page == 0 {
                break;
            }
        }
        assert_eq!(seen, body);
    }

    /// A page number from a frame that had more pages is taken round, never
    /// past the end into an empty screen.
    #[test]
    fn a_page_past_the_last_comes_round() {
        let f = frame(30, 5);
        let s = screen(&f, Some(Screen { cols: 80, rows: 12 }), 99);
        assert!(s.rows.len() > 2, "{:?}", s.rows);
        assert!(s.rows.len() <= 12);
    }

    /// A screen whose size cannot be read is not guessed at: the frame goes
    /// out whole, saying why it is not fitted.
    #[test]
    fn an_unread_screen_size_is_said_and_not_guessed() {
        let f = frame(3, 5);
        let s = screen(&f, None, 0);
        assert_eq!(s.rows.len(), 4);
        assert!(s.rows[1].contains("size could not be read"), "{:?}", s.rows);
    }
}
