//! The reading taken against a real filesystem, not a fixture.
//!
//! Every other test of this module plants a `Headroom` and judges the verdict,
//! which proves the arithmetic and nothing about the syscall under it. A box
//! whose `statvfs` answers an error, or answers in units this code multiplies
//! wrongly, passes all of them and still tells an operator that a full disk is
//! clear (ISS-1260).

#![cfg(unix)]

use forge_runner_core::daemon::headroom::{read, said, Reading, Report, Verdict};

#[test]
fn the_box_this_runs_on_answers_with_both_axes_and_a_line_naming_the_path() {
    let at = std::env::current_dir().expect("a working directory");
    let reading = read(&at);

    let Reading::Took(room) = &reading else {
        panic!("a unix box answers statvfs for its own working directory: {reading:?}");
    };
    assert!(
        room.bytes_total > 0,
        "a filesystem this test is running from states a byte total: {room:?}"
    );
    assert!(
        room.bytes_free <= room.bytes_total,
        "free over total is the block-size multiplication gone wrong, which reads as a clear box \
         whatever the disk holds: {room:?}"
    );
    assert!(
        room.inodes_free <= room.inodes_total || room.inodes_total == 0,
        "{room:?}"
    );

    let verdict = reading.verdict();
    assert!(
        !matches!(verdict, Verdict::Unmeasurable(_)),
        "a real filesystem states at least one total: {verdict:?}"
    );

    let line = said(&at, &reading, &Report::Entered(verdict));
    assert!(line.contains(&at.display().to_string()), "{line}");
    assert!(line.contains("bytes free"), "{line}");
    assert!(line.contains("inodes free"), "{line}");
    println!("{line}");
}
