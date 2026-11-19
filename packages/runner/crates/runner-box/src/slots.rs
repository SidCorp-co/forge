//! The boxes this runner holds, and each frame core sends about one.
//!
//! The ids held are written beside the runner's config on every change, so the image that follows
//! this one (a handover, a crash) reaps what this one left: a box no runner holds is reported gone
//! by omission from `held`, and core fails it `BOX_GONE`.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use runner_platform::box_settings::BoxSettings;
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::core::Core;
use crate::frames::{self, is_uuid};
use crate::mode::{Ctx, Running, Spec};
use crate::{act, display, health, modes, proc, record};
use recording::recording_failed;

/// How long a box's processes get to stop on TERM before KILL.
const REAP_GRACE: Duration = Duration::from_secs(5);

pub(crate) struct Slot {
    pub(crate) running: Option<Arc<Running>>,
    pub(crate) held: watch::Sender<bool>,
    clock: record::Clock,
    /// Whether its recording runs now: nothing records until core asks (ISS-1321).
    recording: bool,
    /// Started warm and not handed out yet: the health sweep checks its device answers (ISS-1324).
    warm: bool,
    /// Core closed it while it was still opening: the open stops it when it returns.
    closing: bool,
    /// A browser box's CDP proxy, the attach door's endpoint (ISS-1322); gone with the slot.
    attach: Option<crate::cdp::Proxy>,
}

pub(crate) struct Inner {
    pub(crate) ctx: Ctx,
    pub(crate) core: Arc<dyn Core>,
    pub(crate) slots: Mutex<HashMap<String, Slot>>,
    wanted: watch::Sender<bool>,
    record: Option<PathBuf>,
    probe: health::Probe,
    /// A warm sweep runs: a heartbeat's sweep started meanwhile returns at once rather than
    /// checking twice.
    sweeping: std::sync::atomic::AtomicBool,
    unmeasured: Mutex<Option<String>>,
}

/// This runner's boxes, shared by the frame loop, the tunnel and the heartbeat.
#[derive(Clone)]
pub struct Boxes(pub(crate) Arc<Inner>);

impl Boxes {
    /// The boxes of a runner whose `[box]` is `settings`, recording what it holds at `record`;
    /// anything an earlier image recorded there and left running is reaped first.
    pub fn start(core: Arc<dyn Core>, settings: BoxSettings, record: Option<PathBuf>) -> Self {
        let data_dir = settings.data_dir();
        let env = modes::Env::of_host(&settings, &data_dir);
        let ctx = Ctx {
            settings,
            env,
            data_dir: data_dir.clone(),
            x: display::XDirs::default(),
            displays: display::Taken::default(),
            emulator_ports: Default::default(),
        };
        Self::with(core, ctx, record, health::Probe::of_host(&data_dir))
    }

    pub(crate) fn with(
        core: Arc<dyn Core>,
        ctx: Ctx,
        record: Option<PathBuf>,
        probe: health::Probe,
    ) -> Self {
        let left = read_record(record.as_deref());
        if !left.is_empty() {
            tokio::spawn(async move {
                for id in left {
                    let r = proc::reap(&id, REAP_GRACE).await;
                    tracing::info!(
                        "[box] reaped box {id} an earlier runner left: {} process(es)",
                        r.signalled.len()
                    );
                }
            });
        }
        let (wanted, _) = watch::channel(false);
        Self(Arc::new(Inner {
            ctx,
            core,
            slots: Mutex::new(HashMap::new()),
            wanted,
            record,
            probe,
            sweeping: Default::default(),
            unmeasured: Mutex::new(None),
        }))
    }

    /// What the preview tunnel needs to carry this runner's box streams.
    pub fn tunnel(&self) -> runner_preview::BoxTunnel {
        runner_preview::BoxTunnel {
            endpoints: Arc::new(self.clone()),
            wanted: self.0.wanted.subscribe(),
        }
    }

    pub(crate) fn slots(&self) -> std::sync::MutexGuard<'_, HashMap<String, Slot>> {
        self.0.slots.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn changed(&self) {
        let ids: Vec<String> = self.slots().keys().cloned().collect();
        let any = !ids.is_empty();
        self.0
            .wanted
            .send_if_modified(|w| std::mem::replace(w, any) != any);
        if let Some(path) = &self.0.record {
            if let Err(e) = std::fs::write(path, serde_json::to_vec(&ids).unwrap_or_default()) {
                tracing::warn!(
                    "[box] cannot record the boxes held at {}: {e}",
                    path.display()
                );
            }
        }
    }

    pub(crate) async fn report(&self, box_id: &str, body: Value) {
        self.0.core.report(box_id, body).await;
    }

    /// Route one of [`frames::FRAMES`]; each runs off the frame loop.
    pub fn on_frame(&self, event: &str, data: Value) {
        let this = self.clone();
        let event = event.to_string();
        tokio::spawn(async move {
            if let Err(e) = this.handle(&event, data).await {
                tracing::warn!("[box] {event} refused: {e}");
            }
        });
    }

    async fn handle(&self, event: &str, data: Value) -> Result<(), String> {
        let id = data["boxId"].as_str().unwrap_or_default().to_string();
        if !is_uuid(&id) {
            return Err(format!("boxId {id:?} is not a uuid"));
        }
        let read = |e: serde_json::Error| e.to_string();
        match event {
            "box.open" => self.open(serde_json::from_value(data).map_err(read)?).await,
            "box.close" => self.close(&id).await,
            "box.act" => self.act(serde_json::from_value(data).map_err(read)?).await,
            "box.assign" => {
                self.assign(serde_json::from_value(data).map_err(read)?)
                    .await
            }
            "box.take" | "box.release" => self.hold(&id, event == "box.take"),
            "box.span.mark" => self.mark(serde_json::from_value(data).map_err(read)?).await,
            "box.recording.fetch" => {
                self.fetch(serde_json::from_value(data).map_err(read)?)
                    .await
            }
            "box.recording.drop" => self.drop_recording(&id),
            "box.recording.upload" => {
                self.upload_session(serde_json::from_value(data).map_err(read)?)
                    .await
            }
            "box.recording.set" => {
                let f: frames::RecordingSet = serde_json::from_value(data).map_err(read)?;
                let body = self.set_recording(&f.box_id, f.on).await;
                self.report(&f.box_id, body).await;
            }
            other => return Err(format!("not a box frame: {other}")),
        }
        Ok(())
    }

    async fn open(&self, f: frames::Open) {
        let id = f.box_id.clone();
        {
            let mut slots = self.slots();
            if slots.contains_key(&id) {
                tracing::warn!("[box] {id}: box.open for a box this runner already holds");
                return;
            }
            slots.insert(
                id.clone(),
                Slot {
                    running: None,
                    held: watch::channel(f.as_person).0,
                    clock: record::Clock::started_now(),
                    recording: false,
                    warm: f.warm,
                    closing: false,
                    attach: None,
                },
            );
        }
        self.changed();
        let spec = Spec {
            box_id: id.clone(),
            mode: f.mode,
            viewport: f.viewport.map(|v| (v.width, v.height)),
            url: f.url,
            within: Duration::from_secs(f.open_timeout_seconds.clamp(10, 600)),
        };
        let opened = Running::open(&self.0.ctx, &spec).await.map(Arc::new);
        let closing = self.slots().get(&id).is_none_or(|s| s.closing);
        match opened {
            Ok(running) if !closing => {
                // a warm box never records; any other records only when its open asked
                let recorded = if f.record && !f.warm {
                    Some(running.record_on().await)
                } else {
                    None
                };
                let clock = record::Clock::started_now();
                let offer = running.offer();
                let on = matches!(recorded, Some(Ok(())));
                if let Some(slot) = self.slots().get_mut(&id) {
                    slot.running = Some(running.clone());
                    slot.clock = clock;
                    slot.recording = on;
                }
                let mut ready = json!({ "kind": "state", "state": "ready", "offer": offer });
                if let Some(attach) = self.attach_on(&id, &running).await {
                    ready["attach"] = attach;
                }
                if on {
                    record::save_clock(&self.0.ctx.box_dir(&id), &clock);
                    ready["recordingStartedAt"] = record::iso(clock.file_start).into();
                }
                self.report(&id, ready).await;
                if let Some(Err(detail)) = recorded {
                    self.report(&id, recording_failed(&detail)).await;
                }
            }
            Ok(running) => {
                running.stop(false).await;
                self.finish(&id).await;
            }
            Err(detail) => {
                tracing::warn!("[box] {id}: {} box did not start: {detail}", spec.mode);
                self.reap_quietly(&id).await;
                self.slots().remove(&id);
                self.changed();
                self.report(&id, json!({ "kind": "state", "state": "failed", "failure": "START_FAILED", "detail": cut(&detail) })).await;
            }
        }
    }

    async fn reap_quietly(&self, id: &str) -> proc::Reaped {
        let r = proc::reap(id, REAP_GRACE).await;
        if !r.left.is_empty() {
            tracing::error!("[box] {id}: processes outlived the reap: {:?}", r.left);
        }
        for dir in self.0.ctx.socket_dirs(id) {
            if dir.exists() {
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
        r
    }

    /// Stop the box's tools and reap every process it started; the recording stays.
    pub(crate) async fn close(&self, id: &str) {
        let (running, recording) = {
            let mut slots = self.slots();
            match slots.get_mut(id) {
                Some(slot) if slot.running.is_none() => {
                    slot.closing = true;
                    return;
                }
                Some(slot) => (slot.running.take(), slot.recording),
                None => (None, false),
            }
        };
        let adb = match running.as_deref() {
            Some(Running::Android(a)) => Some(a.tools.adb.clone()),
            _ => None,
        };
        if let Some(r) = running {
            r.stop(recording).await;
        }
        self.finish(id).await;
        let android_left = self
            .slots()
            .values()
            .any(|s| matches!(s.running.as_deref(), Some(Running::Android(_)) | None));
        if let (Some(adb), false) = (adb, android_left) {
            self.0.ctx.emulator_ports.stop_adb_if_ours(&adb).await;
        }
    }

    async fn finish(&self, id: &str) {
        let reaped = self.reap_quietly(id).await;
        self.slots().remove(id);
        self.changed();
        let mut body = json!({ "kind": "state", "state": "gone" });
        if !reaped.left.is_empty() {
            body["detail"] = format!("pids still running after the reap: {:?}", reaped.left).into();
        }
        self.report(id, body).await;
    }

    pub(crate) fn running(&self, id: &str) -> Option<Arc<Running>> {
        self.slots().get(id).and_then(|s| s.running.clone())
    }

    async fn act(&self, f: frames::Act) {
        let started = std::time::Instant::now();
        let outcome = match self.running(&f.box_id) {
            Some(r) => act::run(r.driver(&f.command), act::DEADLINE).await,
            None => act::Outcome::failed(
                format!("box {} is not running on this device", f.box_id),
                started,
            ),
        };
        tracing::debug!(
            "[box] {}: {} act {} exited {}",
            f.box_id,
            f.kind,
            f.act_id,
            outcome.exit_code
        );
        self.report(&f.box_id, outcome.report(&f.act_id)).await;
    }

    async fn assign(&self, f: frames::Assign) {
        let Some(running) = self.running(&f.box_id) else {
            return tracing::warn!("[box] {}: box.assign for a box not running here", f.box_id);
        };
        // a warm box is handed out only while its device answers (ISS-1324)
        if let Err(why) = running.alive(&self.0.ctx).await {
            return self.device_gone(&f.box_id, &why).await;
        }
        if let Some(slot) = self.slots().get_mut(&f.box_id) {
            slot.warm = false;
        }
        self.hold(&f.box_id, f.as_person);
        if let Some(url) = f.url.as_deref() {
            if let Err(e) = running.navigate(url).await {
                tracing::warn!("[box] {}: {e}", f.box_id);
            }
        }
        // its evidence starts at the hand-out; a warm box recorded nothing before it (ISS-1321)
        let now = std::time::SystemTime::now();
        if let Some(slot) = self.slots().get_mut(&f.box_id) {
            slot.clock.evidence_start = now;
        }
        let recorded = if f.record {
            Some(self.set_recording(&f.box_id, true).await)
        } else {
            None
        };
        let mut body = json!({ "kind": "state", "state": "ready", "offer": running.offer() });
        if let Some(attach) = self.attach_of(&f.box_id) {
            body["attach"] = attach;
        }
        match &recorded {
            Some(r) if r["state"] == "on" => body["recordingStartedAt"] = r["at"].clone(),
            _ => {}
        }
        self.report(&f.box_id, body).await;
        if let Some(r) = recorded.filter(|r| r["state"] == "failed") {
            self.report(&f.box_id, r).await;
        }
    }

    /// Every warm box whose device no longer answers is failed by name, so none is handed out
    /// (ISS-1324). The heartbeat runs it; one sweep at a time.
    pub async fn sweep_warm(&self) {
        if self
            .0
            .sweeping
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            return;
        }
        let warm: Vec<(String, Arc<Running>)> = self
            .slots()
            .iter()
            .filter(|(_, s)| s.warm)
            .filter_map(|(id, s)| Some((id.clone(), s.running.clone()?)))
            .collect();
        for (id, running) in warm {
            if let Err(why) = running.alive(&self.0.ctx).await {
                self.device_gone(&id, &why).await;
            }
        }
        self.0
            .sweeping
            .store(false, std::sync::atomic::Ordering::Release);
    }

    /// The box's device is gone: said in the log, failed `BOX_DEVICE_GONE` with what the check
    /// found, and reaped. Core never hands it out and starts another in its place.
    async fn device_gone(&self, id: &str, why: &str) {
        tracing::error!("[box] {id}: its device is gone, so it is failed BOX_DEVICE_GONE: {why}");
        self.report(
            id,
            json!({ "kind": "state", "state": "failed", "failure": "BOX_DEVICE_GONE", "detail": cut(why) }),
        )
        .await;
        self.close(id).await;
    }

    fn hold(&self, id: &str, taken: bool) {
        match self.slots().get(id) {
            Some(slot) => {
                slot.held.send_replace(taken);
            }
            None => tracing::warn!("[box] {id}: a hold moved on a box not held here"),
        }
    }

    /// The `box` field of the heartbeat, or none where nothing could be measured (said once).
    pub fn health(&self) -> Option<Value> {
        let ctx = &self.0.ctx;
        let mut modes = modes::all(&ctx.env, &ctx.settings);
        let running: Vec<(String, &'static str)> = self
            .slots()
            .iter()
            .filter_map(|(id, s)| Some((id.clone(), s.running.as_ref()?.mode())))
            .collect();
        for (id, mode) in &running {
            let seen = proc::rss_mb(&proc::pids_of(id));
            if let Some(m) = modes.iter_mut().find(|m| m.mode == *mode) {
                m.cost.memory_mb = m.cost.memory_mb.max(seen);
            }
        }
        let mut held: BTreeSet<String> = self.slots().keys().cloned().collect();
        held.extend(
            read_record(self.0.record.as_deref())
                .into_iter()
                .filter(|id| !proc::pids_of(id).is_empty()),
        );
        let held: Vec<String> = held.into_iter().filter(|id| is_uuid(id)).collect();
        match health::measure(&self.0.probe, &ctx.settings, &modes, &held) {
            Ok(v) => {
                self.0
                    .unmeasured
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take();
                Some(v)
            }
            Err(why) => {
                let mut said = self.0.unmeasured.lock().unwrap_or_else(|p| p.into_inner());
                if said.as_deref() != Some(why.as_str()) {
                    tracing::warn!("[box] no box health this beat: {why}");
                    *said = Some(why);
                }
                None
            }
        }
    }

    /// Close every box: the daemon is stopping, and nothing else would.
    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.slots().keys().cloned().collect();
        for id in ids {
            self.close(&id).await;
        }
    }
}

fn read_record(path: Option<&std::path::Path>) -> Vec<String> {
    path.and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|id| is_uuid(id))
        .collect()
}

pub(super) fn cut(detail: &str) -> String {
    act::cut(detail.as_bytes().to_vec(), 4000)
}

mod attach;
mod recording;

// every test in these two drives tools that are shell scripts, so neither compiles elsewhere
#[cfg(all(test, unix))]
mod recording_tests;
#[cfg(test)]
mod tests;
#[cfg(all(test, unix))]
mod warm_tests;
