//! A box's recording on this device (ISS-1321): nothing records until core asks, by `box.open` or
//! `box.assign` naming `record`, `box.recording.set`, or a span's mark that begins or ends it. A
//! span's clip is cut from what was recorded, sealed into segments (see `record`), and a recording a
//! person asked for is sent whole once its box ended, when core says (`box.recording.upload`).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{cut, Boxes};
use crate::{frames, record};

/// How long a send waits for the box's close to seal its recording.
const CLOSE_WAIT: std::time::Duration = std::time::Duration::from_secs(120);

impl Boxes {
    /// Start or stop the box's recording, and the `recording` report saying what came of it. A
    /// recording that runs already is not started twice; one not running is not stopped.
    pub(crate) async fn set_recording(&self, id: &str, on: bool) -> Value {
        let now = || record::iso(std::time::SystemTime::now());
        let Some((running, clock, was)) = self
            .slots()
            .get(id)
            .and_then(|s| Some((s.running.clone()?, s.clock, s.recording)))
        else {
            return recording_failed(&format!("box {id} is not running on this device"));
        };
        if was == on {
            let at = if on {
                record::iso(clock.file_start)
            } else {
                now()
            };
            return json!({ "kind": "recording", "state": if on { "on" } else { "off" }, "at": at });
        }
        let dir = self.0.ctx.box_dir(id);
        if on {
            if let Err(e) = running.record_on().await {
                return recording_failed(&e);
            }
            let started = std::time::SystemTime::now();
            let saved = self.slots().get_mut(id).map(|slot| {
                slot.recording = true;
                slot.clock.file_start = started;
                slot.clock
            });
            if let Some(c) = saved {
                record::save_clock(&dir, &c);
            }
            return json!({ "kind": "recording", "state": "on", "at": record::iso(started) });
        }
        let stopped = running.record_off(clock.file_start).await;
        if let Some(slot) = self.slots().get_mut(id) {
            slot.recording = false;
        }
        match stopped {
            Ok(()) => json!({ "kind": "recording", "state": "off", "at": now() }),
            Err(e) => recording_failed(&e),
        }
    }

    /// A span's mark. A span begun with the box not recording starts its recording before the
    /// start's mark, and the end of the span that began it stops it after the end's (ISS-1321).
    pub(super) async fn mark(&self, f: frames::Mark) {
        if !self.slots().contains_key(&f.box_id) {
            return tracing::warn!("[box] {}: a mark on a box not held here", f.box_id);
        }
        if f.edge == "start" && f.recording.as_deref() == Some("start") {
            let r = self.set_recording(&f.box_id, true).await;
            self.report(&f.box_id, r).await;
        }
        let Some(offset) = self.slots().get(&f.box_id).map(|s| s.clock.mark_now()) else {
            return tracing::warn!("[box] {}: a mark on a box not held here", f.box_id);
        };
        tracing::debug!(
            "[box] {}: criterion {} span {} at {offset} ms",
            f.box_id,
            f.criterion,
            f.edge
        );
        self.report(
            &f.box_id,
            json!({ "kind": "mark", "spanId": f.span_id, "edge": f.edge, "offsetMs": offset }),
        )
        .await;
        if f.edge == "end" && f.recording.as_deref() == Some("stop") {
            let r = self.set_recording(&f.box_id, false).await;
            self.report(&f.box_id, r).await;
        }
    }

    pub(super) async fn fetch(&self, f: frames::Fetch) {
        let dir = self.0.ctx.box_dir(&f.box_id);
        let made = match self.recording_at(&f.box_id, &dir, f.from_ms).await {
            Ok((rec, clock)) => match self.0.ctx.env.which("ffmpeg") {
                Some(ff) => {
                    let work = dir.join("cuts").join(&f.span_id);
                    let c = record::cut(
                        &ff,
                        (&rec.0, rec.1),
                        &clock,
                        (f.from_ms, f.to_ms),
                        (f.max_seconds, f.max_bytes),
                        &work,
                    )
                    .await;
                    let _ = std::fs::remove_dir_all(&work);
                    c
                }
                None => Err("this device has no ffmpeg to cut the clip with".into()),
            },
            Err(e) => Err(e),
        };
        let sent = match made {
            Ok(c) => {
                self.0
                    .core
                    .clip(&f.box_id, &f.span_id, c.clip, c.still)
                    .await
            }
            Err(e) => Err(e),
        };
        if let Err(detail) = sent {
            self.report(
                &f.box_id,
                json!({ "kind": "clip_failed", "spanId": f.span_id, "detail": cut(&detail) }),
            )
            .await;
        }
    }

    /// The recording segment a span starting at `from_ms` is in, and the box's clock. A running
    /// box first closes its recording so far into a segment (see `record`).
    async fn recording_at(
        &self,
        id: &str,
        dir: &Path,
        from_ms: u64,
    ) -> Result<((PathBuf, std::time::SystemTime), record::Clock), String> {
        let slot = self.slots().get(id).map(|s| (s.clock, s.recording));
        let mut clock = slot
            .map(|(c, _)| c)
            .or_else(|| record::load_clock(dir))
            .ok_or_else(|| format!("box {id} has no recording on this device"))?;
        // a recording that runs is closed so far into a segment; a stopped one is sealed already
        let recording = self.running(id).filter(|_| slot.is_some_and(|(_, on)| on));
        if let Some(r) = recording {
            clock.file_start = r.rotate(clock.file_start).await?;
            if let Some(slot) = self.slots().get_mut(id) {
                slot.clock.file_start = clock.file_start;
            }
            record::save_clock(dir, &clock);
        }
        let at = clock.at(from_ms);
        let rec = record::pick(dir, &clock, at).ok_or_else(|| {
            format!(
                "box {id} has no recording holding {} on this device",
                record::iso(at)
            )
        })?;
        Ok((rec, clock))
    }

    /// Send the box's whole kept recording to core through the span clip's own upload, `session` in
    /// the span's place (ISS-1338), once its close has sealed it; what stops it is said as a
    /// `session_failed` report naming why.
    pub(super) async fn upload_session(&self, f: frames::Upload) {
        if let Err((fault, detail)) = self.send_session(&f.box_id, f.max_bytes).await {
            let body = json!({ "kind": "session_failed", "fault": fault, "detail": cut(&detail) });
            self.report(&f.box_id, body).await;
        }
    }

    async fn send_session(&self, id: &str, max_bytes: u64) -> Result<(), record::WholeFault> {
        // core sends this after `box.close`, but each frame runs on its own: the close seals first
        let until = tokio::time::Instant::now() + CLOSE_WAIT;
        while self.slots().contains_key(id) {
            if tokio::time::Instant::now() >= until {
                let why = format!(
                    "box {id} still runs on this device, so its recording is not closed to send"
                );
                return Err(("CUT_FAILED", why));
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        let dir = self.0.ctx.box_dir(id);
        let files: Vec<PathBuf> = record::load_clock(&dir)
            .map(|c| {
                record::recorded(&dir, &c)
                    .into_iter()
                    .map(|(p, _)| p)
                    .collect()
            })
            .unwrap_or_default();
        if files.is_empty() {
            return Err((
                "DEVICE_GONE",
                format!("box {id} has no recording on this device"),
            ));
        }
        let ffmpeg = self.0.ctx.env.which("ffmpeg").ok_or((
            "CUT_FAILED",
            "this device has no ffmpeg to encode the recording with".to_string(),
        ))?;
        let work = dir.join("cuts").join(frames::SESSION_CLIP);
        let made = record::whole(&ffmpeg, &files, max_bytes, &work).await;
        let _ = std::fs::remove_dir_all(&work);
        let c = made?;
        self.0
            .core
            .clip(id, frames::SESSION_CLIP, c.clip, c.still)
            .await
            .map_err(|e| ("SEND_FAILED", e))
    }

    pub(super) fn drop_recording(&self, id: &str) {
        if self.slots().contains_key(id) {
            return tracing::warn!("[box] {id}: its recording is not dropped while the box runs");
        }
        let dir = self.0.ctx.box_dir(id);
        if dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(&dir) {
                tracing::warn!("[box] {id}: cannot drop {}: {e}", dir.display());
            }
        }
    }
}

pub(super) fn recording_failed(detail: &str) -> Value {
    json!({
        "kind": "recording",
        "state": "failed",
        "at": record::iso(std::time::SystemTime::now()),
        "detail": cut(detail),
    })
}
