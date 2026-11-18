//! A box's recording as evidence: where a span's mark lands on it, and the clip and opening still
//! cut from it at core's order (`box.recording.fetch`), on this device where ffmpeg is. Core chose
//! the span and the ceiling; a cut over the ceiling is said, never sent.
//!
//! Nothing records until asked (ISS-1321): an open or a hand-out naming `record`, a
//! `box.recording.set`, or a span begun while the box was not recording. A mark's offset counts
//! from the evidence's start (the open, or the hand-out of a warm box, which never records), and a
//! recording begun later starts its own file, so a cut reads the segment its span starts in.
//!
//! A recording is kept as segments on disk: the live file (`session.<ext>`), whose start is in
//! `clock.json` beside it, and closed ones (`seg-<start ms>.<ext>`). No recorder has written what
//! a cut needs until it stops (agent-browser writes nothing before, the emulator's console and
//! ffmpeg buffer), so a running box closes its segment before every cut, and its close ends the
//! last; the cut reads the segment its span starts in. Everything a cut needs is on disk, so a
//! clip is still cut after the box closed, until its recording is dropped.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::act;

/// When the live file began, and when the evidence did (the open, or the assignment of a warm box).
#[derive(Debug, Clone, Copy)]
pub struct Clock {
    pub file_start: SystemTime,
    pub evidence_start: SystemTime,
}

impl Clock {
    pub fn started_now() -> Self {
        let now = SystemTime::now();
        Self {
            file_start: now,
            evidence_start: now,
        }
    }

    /// The offset a mark made now lands at, from the evidence's start, rounded up to the next
    /// millisecond: a span that began its own recording marks after the recording's start, and a
    /// floored offset could land before it, where no segment holds it (ISS-1321).
    pub fn mark_now(&self) -> u64 {
        let micros = SystemTime::now()
            .duration_since(self.evidence_start)
            .unwrap_or_default()
            .as_micros();
        micros.div_ceil(1000) as u64
    }

    /// The instant an evidence offset names.
    pub fn at(&self, evidence_ms: u64) -> SystemTime {
        self.evidence_start + Duration::from_millis(evidence_ms)
    }
}

fn ms(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn of_ms(ms: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_millis(ms)
}

/// Write the clock beside the recording, so a cut after close still finds its offsets.
pub fn save_clock(dir: &Path, c: &Clock) {
    let body = serde_json::json!({ "fileStartMs": ms(c.file_start), "evidenceStartMs": ms(c.evidence_start) });
    let _ = std::fs::create_dir_all(dir);
    if let Err(e) = std::fs::write(dir.join("clock.json"), body.to_string()) {
        tracing::warn!("[box] cannot write {}/clock.json: {e}", dir.display());
    }
}

pub fn load_clock(dir: &Path) -> Option<Clock> {
    let v: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("clock.json")).ok()?).ok()?;
    Some(Clock {
        file_start: of_ms(v["fileStartMs"].as_u64()?),
        evidence_start: of_ms(v["evidenceStartMs"].as_u64()?),
    })
}

/// Close the live file into a segment named for its start.
pub fn seal(live: &Path, file_start: SystemTime) -> Result<PathBuf, String> {
    let ext = live.extension().and_then(|e| e.to_str()).unwrap_or("webm");
    let seg = live.with_file_name(format!("seg-{}.{ext}", ms(file_start)));
    std::fs::rename(live, &seg)
        .map_err(|e| format!("cannot close {} into a segment: {e}", live.display()))?;
    Ok(seg)
}

/// The recording that holds instant `at`: the latest segment, or the live file, begun by then.
pub fn pick(dir: &Path, clock: &Clock, at: SystemTime) -> Option<(PathBuf, SystemTime)> {
    let mut found: Vec<(PathBuf, SystemTime)> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?.to_string();
            if let Some(rest) = name.strip_prefix("seg-") {
                let start = rest.split('.').next()?.parse().ok()?;
                return Some((p, of_ms(start)));
            }
            let live =
                name.starts_with("session.") && std::fs::metadata(&p).is_ok_and(|m| m.len() > 0);
            live.then_some((p, clock.file_start))
        })
        .filter(|(_, start)| *start <= at)
        .collect();
    found.sort_by_key(|(_, start)| *start);
    found.pop()
}

/// An ISO-8601 instant in UTC with milliseconds, as core reads one.
pub fn iso(t: SystemTime) -> String {
    let ms = t
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    jiff::Timestamp::from_millisecond(ms)
        .map(|ts| ts.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

pub struct Cut {
    pub clip: Vec<u8>,
    pub still: Vec<u8>,
}

/// The span `from..to` (evidence offsets) cut to an mp4 of at most `max_seconds` and `max_bytes`,
/// and its opening frame as a png. A cut over the byte ceiling is tried once more smaller.
pub async fn cut(
    ffmpeg: &Path,
    (recording, file_start): (&Path, SystemTime),
    clock: &Clock,
    (from_ms, to_ms): (u64, u64),
    (max_seconds, max_bytes): (u64, u64),
    work: &Path,
) -> Result<Cut, String> {
    if to_ms <= from_ms {
        return Err(format!(
            "the span ends at {to_ms} ms, before its start at {from_ms} ms"
        ));
    }
    if !recording.is_file() {
        return Err(format!(
            "the box's recording {} is gone",
            recording.display()
        ));
    }
    std::fs::create_dir_all(work).map_err(|e| format!("cannot make {}: {e}", work.display()))?;
    let start = clock
        .at(from_ms)
        .duration_since(file_start)
        .unwrap_or_default();
    let length = Duration::from_millis(to_ms - from_ms).min(Duration::from_secs(max_seconds));
    let (clip_path, still_path) = (work.join("clip.mp4"), work.join("still.png"));
    let mut clip = Vec::new();
    for (crf, scale) in [
        ("28", "scale='min(1280,iw)':-2"),
        ("36", "scale='min(720,iw)':-2"),
    ] {
        ffmpeg_run(
            ffmpeg,
            &[
                "-ss",
                &secs(start),
                "-i",
                &recording.to_string_lossy(),
                "-t",
                &secs(length),
                "-an",
                "-vf",
                scale,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                crf,
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                &clip_path.to_string_lossy(),
            ],
        )
        .await?;
        clip = std::fs::read(&clip_path).map_err(|e| format!("the cut clip: {e}"))?;
        if (clip.len() as u64) <= max_bytes {
            break;
        }
    }
    if clip.len() as u64 > max_bytes {
        return Err(format!(
            "the clip is {} bytes at its smallest, over the {max_bytes} the release page takes",
            clip.len()
        ));
    }
    ffmpeg_run(
        ffmpeg,
        &[
            "-ss",
            &secs(start),
            "-i",
            &recording.to_string_lossy(),
            "-frames:v",
            "1",
            &still_path.to_string_lossy(),
        ],
    )
    .await?;
    let still = std::fs::read(&still_path).map_err(|e| format!("the cut still: {e}"))?;
    Ok(Cut { clip, still })
}

fn secs(d: Duration) -> String {
    format!("{:.3}", d.as_secs_f64())
}

async fn ffmpeg_run(ffmpeg: &Path, args: &[&str]) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(["-y", "-nostdin", "-loglevel", "error"])
        .args(args)
        .kill_on_drop(true);
    let o = act::run(cmd, Duration::from_secs(180)).await;
    if o.exit_code == 0 {
        Ok(())
    } else {
        Err(format!(
            "ffmpeg exited {}: {}",
            o.exit_code,
            o.stderr.trim()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mark_made_after_its_recording_began_lands_inside_it() {
        let root = crate::testkit::Scratch::new("record");
        for _ in 0..200 {
            let evidence = SystemTime::now();
            std::thread::sleep(Duration::from_micros(300));
            let file_start = SystemTime::now();
            let clock = Clock {
                file_start,
                evidence_start: evidence,
            };
            let at = clock.at(clock.mark_now());
            assert!(at >= file_start, "{at:?} lands before {file_start:?}");
            std::fs::write(root.path().join("session.webm"), b"x").unwrap();
            let seg = seal(&root.path().join("session.webm"), file_start).unwrap();
            assert!(pick(root.path(), &clock, at).is_some_and(|(p, _)| p == seg));
            std::fs::remove_file(seg).unwrap();
        }
    }

    #[test]
    fn a_warm_boxs_evidence_counts_from_its_assignment_not_its_file() {
        let file_start = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
        let clock = Clock {
            file_start,
            evidence_start: file_start + Duration::from_secs(90),
        };
        let at = clock.at(2_500);
        assert_eq!(
            at.duration_since(file_start).unwrap(),
            Duration::from_millis(92_500)
        );
        assert_eq!(iso(file_start), "1970-01-01T00:16:40.000Z");
    }

    #[test]
    fn a_cut_reads_the_segment_its_span_starts_in_and_never_an_unwritten_live_file() {
        let root = crate::testkit::Scratch::new("record");
        let dir = root.path();
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let clock = Clock {
            file_start: t0,
            evidence_start: t0,
        };
        std::fs::write(dir.join("session.webm"), b"").unwrap();
        assert!(
            pick(dir, &clock, t0 + Duration::from_secs(5)).is_none(),
            "agent-browser has not written it yet"
        );

        let first = seal(&dir.join("session.webm"), t0).unwrap();
        let t1 = t0 + Duration::from_secs(60);
        std::fs::write(dir.join("session.webm"), b"live").unwrap();
        let clock = Clock {
            file_start: t1,
            ..clock
        };
        save_clock(dir, &clock);
        let back = load_clock(dir).unwrap();
        assert_eq!((back.file_start, back.evidence_start), (t1, t0));

        assert_eq!(
            pick(dir, &back, t0 + Duration::from_secs(30)),
            Some((first, t0))
        );
        assert_eq!(
            pick(dir, &back, t1 + Duration::from_secs(1)),
            Some((dir.join("session.webm"), t1))
        );
        assert!(
            pick(dir, &back, t0 - Duration::from_secs(1)).is_none(),
            "before the recording began"
        );
    }
}
