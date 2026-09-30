//! A live frame, fitted to the terminal it is redrawn on.
//!
//! The view redraws in place, so a frame taller than the screen scrolls its
//! top away on every redraw, and a line wider than the screen wraps into rows
//! nothing counted: at 120x40 the box's 137-line frame took 217 rows, and only
//! its last 25 stayed in view (judge at d7da543). Here every line is wrapped to
//! the screen's width, so nothing is cut, and a frame taller than the screen
//! is shown one page per redraw, the page it is on said under the header.

use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

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

/// The page row's wording, from the page shown and the page count.
type PageRow<'a> = dyn Fn(usize, usize) -> String + 'a;

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
    // Room for the body under the header and a page row, trying the full page
    // row, then a short one, then no header, then the body alone, so every
    // page fits however small the screen is and every row is still shown.
    let full = |at: usize, pages: usize| {
        format!(
            "page {at} of {pages} — {total} rows on this {}x{} screen, one page per redraw; `forge-runner top --once | less` reads it whole",
            size.cols, size.rows
        )
    };
    let short = |at: usize, pages: usize| format!("page {at} of {pages}; --once reads it whole");
    let plans: [(bool, Option<&PageRow>); 4] = [
        (true, Some(&full)),
        (true, Some(&short)),
        (false, Some(&short)),
        (false, None),
    ];
    for (with_header, status) in plans {
        let head: &[String] = if with_header { &header } else { &[] };
        let paged = |status_rows: usize| {
            let room = size.rows.checked_sub(head.len() + status_rows)?;
            (room > 0).then(|| (room, body.len().div_ceil(room).max(1)))
        };
        let Some(status) = status else {
            let (room, pages) = paged(0).expect("a screen of one row holds one row");
            let at = page % pages;
            return Shown {
                rows: body.into_iter().skip(at * room).take(room).collect(),
                next: (at + 1) % pages,
            };
        };
        // The page row's height depends on the page count it states, and the
        // page count on the room the page row leaves: settle it in two passes.
        let mut rows_for_status = 1;
        let mut fitted = None;
        for _ in 0..2 {
            let Some((room, pages)) = paged(rows_for_status) else {
                break;
            };
            let at = page % pages;
            let text = wrap(&status(at + 1, pages), size.cols);
            if text.len() == rows_for_status {
                fitted = Some((room, pages, at, text));
                break;
            }
            rows_for_status = text.len();
        }
        let Some((room, pages, at, text)) = fitted else {
            continue;
        };
        let mut rows = head.to_vec();
        rows.extend(text);
        rows.extend(body.into_iter().skip(at * room).take(room));
        return Shown {
            rows,
            next: (at + 1) % pages,
        };
    }
    unreachable!("the last plan, the body alone, always fits")
}

/// The terminal cells `s` takes: a wide character two, a combining mark none.
pub fn cells(s: &str) -> usize {
    UnicodeWidthStr::width(s)
}

/// `line` as rows no wider than `width` cells, broken at a space where one
/// falls in the row and mid-word where none does, never between a character
/// and the mark combined onto it; a continued row is indented two past the
/// line's own indent. Nothing of the line is dropped but the spaces a break
/// falls on. A character wider than the whole row is set on a row of its own,
/// the one case a row can be wider than `width`.
pub fn wrap(line: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    if cells(line) <= width {
        return vec![line.to_string()];
    }
    let chars: Vec<(char, usize)> = line
        .chars()
        .map(|c| (c, UnicodeWidthChar::width(c).unwrap_or(0)))
        .collect();
    let indent = chars.iter().take_while(|(c, _)| *c == ' ').count();
    let hang = (indent + 2).min(width / 2);
    let text = |from: usize, to: usize| chars[from..to].iter().map(|(c, _)| c).collect::<String>();
    let mut out = Vec::new();
    let (mut start, mut pad) = (0, 0);
    while start < chars.len() {
        let room = width - pad;
        let lead = " ".repeat(pad);
        // `end` is the first character that does not fit in the room.
        let (mut used, mut end) = (0, start);
        while end < chars.len() && used + chars[end].1 <= room {
            used += chars[end].1;
            end += 1;
        }
        if end == chars.len() {
            out.push(format!("{lead}{}", text(start, end)));
            break;
        }
        // A space at `end` itself ends a row that fills the room exactly. The
        // first row never breaks inside its own indent.
        let least = if start == 0 { indent } else { 0 };
        let at_space = (start..=end)
            .rev()
            .find(|&i| chars[i].0 == ' ' && i - start > least);
        let cut = match at_space {
            Some(i) => i,
            None => {
                let mut i = end;
                while i > start + 1 && chars[i].1 == 0 {
                    i -= 1;
                }
                i.max(start + 1)
            }
        };
        out.push(format!("{lead}{}", text(start, cut).trim_end()));
        start = cut;
        while start < chars.len() && chars[start].0 == ' ' {
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
        rows.iter().map(|r| cells(r)).max().unwrap_or(0)
    }

    /// Consult at 38b26e9, F1: a wide character takes two cells, so ten of
    /// them on a ten-column screen are two rows, never one row twenty wide.
    #[test]
    fn wide_characters_are_wrapped_by_the_cells_they_take() {
        let rows = wrap(&"界".repeat(10), 10);
        assert_eq!(
            rows,
            vec![
                "界".repeat(5),
                format!("  {}", "界".repeat(4)),
                "  界".to_string()
            ]
        );
        assert!(widest(&rows) <= 10, "{rows:?}");
        assert_eq!(rows.concat().replace(' ', ""), "界".repeat(10));
    }

    /// A combining mark takes no cell and is never split from its letter: a
    /// line of them fits by cells, and a break mid-word carries both over.
    #[test]
    fn a_combining_mark_stays_with_its_letter() {
        let e = "e\u{301}";
        assert_eq!(wrap(&e.repeat(8), 8), vec![e.repeat(8)], "eight cells");
        let rows = wrap(&e.repeat(9), 8);
        assert!(widest(&rows) <= 8, "{rows:?}");
        assert!(
            rows.iter().all(|r| !r.trim_start().starts_with('\u{301}')),
            "{rows:?}"
        );
        assert_eq!(rows.concat().replace(' ', ""), e.repeat(9));
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

    /// Paging checked against pages written out by hand, not derived from
    /// `wrap`: nine short rows under a header on a screen of five rows are
    /// three pages of three, in order, and then the first again.
    #[test]
    fn short_rows_page_in_order_against_pages_written_out() {
        let mut f = vec!["head".to_string()];
        f.extend((1..=9).map(|i| format!("r{i}")));
        let size = Some(Screen { cols: 200, rows: 5 });
        let expect = [["r1", "r2", "r3"], ["r4", "r5", "r6"], ["r7", "r8", "r9"]];
        for (page, want) in expect.iter().enumerate() {
            let s = screen(&f, size, page);
            assert_eq!(s.rows[0], "head");
            assert!(s.rows[1].starts_with(&format!("page {} of 3 — 10 rows", page + 1)));
            assert_eq!(&s.rows[2..], want, "page {page}");
            assert_eq!(s.next, (page + 1) % 3);
        }
    }

    /// Consult F1: a screen too small for the header and a page row still
    /// gets pages that fit it, and every body row is on one of them.
    #[test]
    fn a_tiny_screen_still_gets_pages_that_fit_it() {
        let f = vec![
            "the header of the frame".to_string(),
            "body".to_string(),
            "more".to_string(),
        ];
        for (cols, rows) in [(1, 1), (10, 4), (10, 2), (3, 3), (40, 3)] {
            let size = Some(Screen { cols, rows });
            let (mut page, mut seen) = (0, String::new());
            loop {
                let s = screen(&f, size, page);
                assert!(s.rows.len() <= rows, "{cols}x{rows}: {:?}", s.rows);
                assert!(
                    s.rows.iter().all(|r| cells(r) <= cols),
                    "{cols}x{rows}: {:?}",
                    s.rows
                );
                seen.push_str(&s.rows.concat().replace(' ', ""));
                page = s.next;
                if page == 0 {
                    break;
                }
            }
            assert!(
                seen.contains("body") && seen.contains("more"),
                "{cols}x{rows}: {seen}"
            );
        }
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
