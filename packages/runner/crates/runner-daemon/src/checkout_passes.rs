//! The passes over every bound checkout that run after the daemon's start: the start's own
//! again where core did not answer it, and the orientation refresh for as long as the daemon
//! runs, so project knowledge edited after a start reaches the checkout.

use std::sync::Arc;

use runner_core::agent_activity;
use runner_platform::config::Config;
use runner_platform::error::Result;
use runner_transport::runners::{self, MeRunner};
use runner_transport::CoreClient;
use runner_workspace::orientation_record::Point;
use tokio::sync::watch;

use crate::{actors, converge_orientations, reconcile_checkouts, repair_installed_hooks};

/// Where a start's pass reads the bindings again and records what it did.
pub(crate) struct StartPlaces {
    /// config.toml as it stands now, so the census covers a binding made since start.
    reload: Box<dyn Fn() -> Result<Config> + Send + Sync>,
    record_dir: Option<std::path::PathBuf>,
    lock_dir: Option<std::path::PathBuf>,
}

impl StartPlaces {
    pub(crate) fn this_box() -> Self {
        let record_dir = runner_platform::config::config_dir();
        let lock_dir = record_dir.as_deref().map(|d| d.join("locks"));
        Self {
            reload: Box::new(Config::load),
            record_dir,
            lock_dir,
        }
    }
}

/// The start's pass over every checkout this box is bound to: the hooks the daemon it replaced
/// installed, then the forge-master skill and the orientation core served. `server` is `None`
/// where core did not answer which projects are assigned here.
pub(crate) async fn start_pass(
    server: Option<&[MeRunner]>,
    cfg: &Config,
    when: &str,
    places: &StartPlaces,
) {
    repair_installed_hooks(server, cfg, when);
    let census_from = agent_activity::now_ms();
    let (fresh, census_from) = match (places.reload)() {
        Ok(fresh) => (fresh, Some(census_from)),
        Err(e) => {
            tracing::warn!(
                "[skill] config.toml could not be read again ({e}), so the forge-master install covers the bindings read at start and prunes no line of its record"
            );
            (cfg.clone(), None)
        }
    };
    reconcile_checkouts(
        server,
        &fresh,
        census_from,
        places.record_dir.as_deref(),
        places.lock_dir.as_deref(),
    )
    .await;
}

/// How long a start core did not answer waits before asking again: the first wait, doubled on
/// each failure up to the second.
const START_RETRY: (std::time::Duration, std::time::Duration) = (
    std::time::Duration::from_secs(5),
    std::time::Duration::from_secs(300),
);

/// A start whose `me/runners` read failed wrote no orientation and swept only config.toml's
/// checkouts, and no later point owes that pass: a provision writes only the checkout it
/// provisions. So the read is asked again until core answers, and the start's whole pass runs
/// then over what it served. On 2026-10-15 and 2026-10-20 the dev box's daemon started 14 s
/// after the host booted, before name resolution worked, and every checkout kept an
/// orientation older than the project knowledge core was serving until the next restart.
/// Answers whether the pass ran; `false` where the daemon stopped first.
pub(crate) async fn start_pass_once_core_answers(
    client: &CoreClient,
    cfg: &Config,
    places: &StartPlaces,
    (first, cap): (std::time::Duration, std::time::Duration),
    mut cancel: watch::Receiver<bool>,
) -> bool {
    let mut wait = first;
    let mut failed: u32 = 1;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = cancel.changed() => {
                tracing::warn!(
                    "[me/runners] this daemon stopped before core answered which projects are assigned to it, so the start's orientation, forge-master skill and hook pass never ran over what core serves"
                );
                return false;
            }
        }
        match runners::list_me(client).await {
            Ok(rows) => {
                tracing::info!(
                    "[me/runners] core answered after {failed} failed read(s) since this daemon started — the start's orientation, forge-master skill and hook pass runs now over the {} assignment(s) it served",
                    rows.len()
                );
                start_pass(Some(&rows), cfg, "once core answered", places).await;
                return true;
            }
            Err(e) => {
                failed += 1;
                wait = (wait * 2).min(cap);
                tracing::warn!(
                    "[me/runners] still unanswered ({e}) — {failed} failed read(s) since start; every checkout keeps the orientation it held before this start, and the read is asked again in {}s",
                    wait.as_secs()
                );
            }
        }
    }
}

/// How often a running daemon converges every checkout's orientation again.
const ORIENTATION_REFRESH: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// The orientation core serves carries the project's knowledge, which a person edits while this
/// daemon runs, and a start or a provision of that checkout were the only writes of it: a rule
/// added on 2026-10-09 had reached no checkout on this box by 2026-10-22. So every `period` the
/// assignment read is made again and every checkout converged over it, as the start does: one
/// already holding what core serves is left untouched and recorded current, and a read core did
/// not answer writes nothing, records why on each checkout, and waits for the next tick. Ends
/// when `cancel` says stop.
async fn refresh_orientations(
    client: &CoreClient,
    cfg: &Config,
    places: &StartPlaces,
    period: std::time::Duration,
    cancel: watch::Receiver<bool>,
) {
    let mut ticks = actors::Ticks::new(period, cancel);
    // The interval's first tick completes at once, and the start has just converged.
    if ticks.next().await.is_none() {
        return;
    }
    while ticks.next().await.is_some() {
        let server = match runners::list_me(client).await {
            Ok(rows) => Some(rows),
            Err(e) => {
                tracing::warn!(
                    "[orientation] at refresh: me/runners failed ({e}) — every checkout keeps the orientation it holds, and the next refresh in {}s asks again",
                    period.as_secs()
                );
                None
            }
        };
        let census_from = agent_activity::now_ms();
        let (fresh, census_from) = match (places.reload)() {
            Ok(fresh) => (fresh, Some(census_from)),
            Err(e) => {
                tracing::warn!(
                    "[orientation] at refresh: config.toml could not be read again ({e}), so this pass covers the bindings read at start and prunes no line of its record"
                );
                (cfg.clone(), None)
            }
        };
        converge_orientations(
            Point::Refresh,
            server.as_deref(),
            &fresh,
            census_from,
            places.record_dir.as_deref(),
            places.lock_dir.as_deref(),
        )
        .await;
    }
}

/// The passes over every checkout that run after the start: the start's own again where core
/// did not `answer` it, and the orientation refresh for as long as the daemon runs.
pub(crate) fn spawn_checkout_passes(
    answered: bool,
    client: &Arc<CoreClient>,
    cfg: &Config,
    cancel_rx: &watch::Receiver<bool>,
) {
    if !answered {
        let (client, cfg, cancel) = (client.clone(), cfg.clone(), cancel_rx.clone());
        tokio::spawn(async move {
            let places = StartPlaces::this_box();
            start_pass_once_core_answers(&client, &cfg, &places, START_RETRY, cancel).await
        });
    }
    let (client, cfg, cancel) = (client.clone(), cfg.clone(), cancel_rx.clone());
    tokio::spawn(async move {
        let places = StartPlaces::this_box();
        refresh_orientations(&client, &cfg, &places, ORIENTATION_REFRESH, cancel).await
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::start_tests::{git, outcomes, DEV};
    use runner_platform::config::Binding;
    use runner_workspace::orientation_record::{self, Outcome};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// How many times the core below was asked which projects are assigned to the box.
    static ASKED: AtomicUsize = AtomicUsize::new(0);

    /// A core that cannot answer `me/runners` the first two times it is asked, as a host that
    /// booted before name resolution worked, and serves the forge orientation after.
    fn answers_on_the_third_read(path: &str) -> (u16, &'static str) {
        if path != "/api/devices/me/runners" {
            return (200, "{}");
        }
        if ASKED.fetch_add(1, Ordering::SeqCst) < 2 {
            return (503, r#"{"error":"starting"}"#);
        }
        (
            200,
            r##"[{"projectId":"d1bb4907-74d9-4228-85ff-76121523af7d","runnerId":"r","slug":"forge","status":"online","orientation":"# Forge orientation — forge\n\n<!-- Generated by Forge on device provision. Forge-owned; manual edits are overwritten. -->\n\n- **projectId:** `d1bb4907-74d9-4228-85ff-76121523af7d`\n\n## ui-copy-rule\n"}]"##,
        )
    }

    #[tokio::test]
    async fn a_start_core_did_not_answer_writes_the_orientation_once_core_answers() {
        let root = std::env::temp_dir().join(format!("forge-start-late-{}", uuid::Uuid::new_v4()));
        let co = root.join("co");
        std::fs::create_dir_all(&co).unwrap();
        git(&co, &["init", "-q"]);
        let records = root.join("config");
        let mut cfg = Config::default();
        cfg.bindings.insert(
            "forge".into(),
            Binding {
                repo_path: co.clone(),
                branch: None,
                project_id: Some(DEV.into()),
            },
        );
        let reloaded = cfg.clone();
        let places = StartPlaces {
            reload: Box::new(move || Ok(reloaded.clone())),
            record_dir: Some(records.clone()),
            lock_dir: Some(records.join("locks")),
        };
        let (client, _seen) = crate::test_core::fake_core(answers_on_the_third_read).await;
        let (_stop, cancel) = watch::channel(false);
        let quick = (
            std::time::Duration::from_millis(5),
            std::time::Duration::from_millis(20),
        );

        // The start itself: core does not answer, so nothing is written and the refusal is recorded.
        assert!(runners::list_me(&client).await.is_err());
        start_pass(None, &cfg, "boot", &places).await;
        assert!(!co.join("CLAUDE.local.md").exists());

        let ran = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            start_pass_once_core_answers(&client, &cfg, &places, quick, cancel),
        )
        .await
        .expect("START_PASS_NEVER_RETRIED: the start's pass waited past 10 s for a core that answers on its third read");
        assert!(ran, "START_PASS_NEVER_RETRIED: core answered on its third read and the start's pass was never run again over what it served");
        assert_eq!(
            ASKED.load(Ordering::SeqCst),
            3,
            "asked until core answered, and no more"
        );
        let local = std::fs::read_to_string(co.join("CLAUDE.local.md")).unwrap_or_else(|e| {
            panic!("START_ORIENTATION_NOT_WRITTEN_ONCE_CORE_ANSWERED: core answered on its third read and the checkout holds no CLAUDE.local.md ({e})")
        });
        assert!(local.contains("## ui-copy-rule"), "{local}");
        let said = outcomes(&records);
        assert!(
            matches!(&said[0], (s, o) if s == "forge" && o.oriented()),
            "the record still says the start's refusal: {said:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_start_pass_waiting_on_core_ends_when_the_daemon_stops() {
        let (client, _seen) = crate::test_core::fake_core(|_| (503, r#"{"error":"down"}"#)).await;
        let places = StartPlaces {
            reload: Box::new(|| Ok(Config::default())),
            record_dir: None,
            lock_dir: None,
        };
        let (stop, cancel) = watch::channel(false);
        let waiting = tokio::spawn(async move {
            start_pass_once_core_answers(
                &client,
                &Config::default(),
                &places,
                (
                    std::time::Duration::from_millis(5),
                    std::time::Duration::from_millis(20),
                ),
                cancel,
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        let _ = stop.send(true);
        let ran = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
            .await
            .expect("a stopped daemon's start pass kept asking core")
            .unwrap();
        assert!(!ran, "a pass core never answered is not reported as run");
    }

    /// The forge rows core serves before a knowledge entry is added.
    const BEFORE_THE_RULE: &str = r##"[{"projectId":"d1bb4907-74d9-4228-85ff-76121523af7d","runnerId":"r","slug":"forge","status":"online","orientation":"# Forge orientation — forge\n\n<!-- Generated by Forge on device provision. Forge-owned; manual edits are overwritten. -->\n\n- **projectId:** `d1bb4907-74d9-4228-85ff-76121523af7d`\n"}]"##;
    /// The same rows once a person has added an `injection: always` entry.
    const AFTER_THE_RULE: &str = r##"[{"projectId":"d1bb4907-74d9-4228-85ff-76121523af7d","runnerId":"r","slug":"forge","status":"online","orientation":"# Forge orientation — forge\n\n<!-- Generated by Forge on device provision. Forge-owned; manual edits are overwritten. -->\n\n- **projectId:** `d1bb4907-74d9-4228-85ff-76121523af7d`\n\n## ui-copy-rule\n"}]"##;

    static EDITED_READS: AtomicUsize = AtomicUsize::new(0);

    /// A core whose knowledge is edited after the box's start read.
    fn knowledge_edited_after_start(path: &str) -> (u16, &'static str) {
        if path != "/api/devices/me/runners" {
            return (200, "{}");
        }
        match EDITED_READS.fetch_add(1, Ordering::SeqCst) {
            0 => (200, BEFORE_THE_RULE),
            _ => (200, AFTER_THE_RULE),
        }
    }

    static UNREACHED_READS: AtomicUsize = AtomicUsize::new(0);

    /// A core that answers the start read and none after it.
    fn unanswered_after_start(path: &str) -> (u16, &'static str) {
        if path != "/api/devices/me/runners" {
            return (200, "{}");
        }
        match UNREACHED_READS.fetch_add(1, Ordering::SeqCst) {
            0 => (200, BEFORE_THE_RULE),
            _ => (503, r#"{"error":"down"}"#),
        }
    }

    /// A bound forge checkout, the places its passes record into, and its config.
    fn bound_forge(tag: &str) -> (PathBuf, PathBuf, Config, StartPlaces) {
        let root = std::env::temp_dir().join(format!("forge-{tag}-{}", uuid::Uuid::new_v4()));
        let co = root.join("co");
        std::fs::create_dir_all(&co).unwrap();
        git(&co, &["init", "-q"]);
        let records = root.join("config");
        let mut cfg = Config::default();
        cfg.bindings.insert(
            "forge".into(),
            Binding {
                repo_path: co.clone(),
                branch: None,
                project_id: Some(DEV.into()),
            },
        );
        let reloaded = cfg.clone();
        let places = StartPlaces {
            reload: Box::new(move || Ok(reloaded.clone())),
            record_dir: Some(records.clone()),
            lock_dir: Some(records.join("locks")),
        };
        (root, co, cfg, places)
    }

    /// The forge checkout's record line, once `done` holds of it, within 5 s.
    async fn forge_line_once(
        records: &Path,
        done: impl Fn(&orientation_record::Entry) -> bool,
    ) -> Option<orientation_record::Entry> {
        let until = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while tokio::time::Instant::now() < until {
            if let orientation_record::Read::Record(r) = orientation_record::read(records) {
                if let Some(e) = r.entries.into_iter().find(|e| e.slug == "forge" && done(e)) {
                    return Some(e);
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        None
    }

    #[tokio::test]
    async fn knowledge_core_serves_after_start_reaches_the_checkout_within_the_refresh_interval() {
        let (root, co, cfg, places) = bound_forge("refresh");
        let records = places.record_dir.clone().unwrap();
        let (client, _seen) = crate::test_core::fake_core(knowledge_edited_after_start).await;
        let rows = runners::list_me(&client).await.unwrap();
        start_pass(Some(&rows), &cfg, "boot", &places).await;
        let local = co.join("CLAUDE.local.md");
        assert!(!std::fs::read_to_string(&local)
            .unwrap()
            .contains("## ui-copy-rule"));

        let (stop, cancel) = watch::channel(false);
        let period = std::time::Duration::from_millis(20);
        let refreshing = tokio::spawn(async move {
            refresh_orientations(&client, &cfg, &places, period, cancel).await
        });

        let written = forge_line_once(&records, |e| {
            e.point == Point::Refresh && e.outcome == Outcome::Written
        })
        .await;
        assert!(
            written.is_some(),
            "ORIENTATION_NOT_REFRESHED: core served a new orientation after start and no refresh wrote it within 5 s at a 20 ms interval"
        );
        assert!(
            std::fs::read_to_string(&local)
                .unwrap()
                .contains("## ui-copy-rule"),
            "ORIENTATION_NOT_REFRESHED: the checkout does not hold what core serves now"
        );
        let current = forge_line_once(&records, |e| {
            e.point == Point::Refresh && e.outcome == Outcome::Current
        })
        .await;
        assert!(
            current.is_some(),
            "a refresh over an orientation already on disk records it current"
        );
        let held = std::fs::metadata(&local).unwrap().modified().unwrap();
        tokio::time::sleep(period * 5).await;
        assert_eq!(
            std::fs::metadata(&local).unwrap().modified().unwrap(),
            held,
            "a refresh rewrote an orientation that had not changed"
        );

        let _ = stop.send(true);
        tokio::time::timeout(std::time::Duration::from_secs(5), refreshing)
            .await
            .expect("REFRESH_OUTLIVED_STOP: the refresh loop kept running after the daemon stopped")
            .unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_refresh_core_did_not_answer_keeps_the_checkout_and_records_why() {
        let (root, co, cfg, places) = bound_forge("refresh-unanswered");
        let records = places.record_dir.clone().unwrap();
        let (client, _seen) = crate::test_core::fake_core(unanswered_after_start).await;
        let rows = runners::list_me(&client).await.unwrap();
        start_pass(Some(&rows), &cfg, "boot", &places).await;
        let local = co.join("CLAUDE.local.md");
        let before = std::fs::read_to_string(&local).unwrap();

        let (stop, cancel) = watch::channel(false);
        let refreshing = tokio::spawn(async move {
            refresh_orientations(
                &client,
                &cfg,
                &places,
                std::time::Duration::from_millis(20),
                cancel,
            )
            .await
        });
        let refused = forge_line_once(&records, |e| {
            e.point == Point::Refresh
                && matches!(&e.outcome, Outcome::Refused { detail } if detail.starts_with("PROVISION_ORIENTATION_NOT_SERVED"))
        })
        .await;
        assert!(
            refused.is_some(),
            "REFRESH_FAILURE_UNRECORDED: a refresh whose read core did not answer recorded no refusal within 5 s"
        );
        assert_eq!(
            std::fs::read_to_string(&local).unwrap(),
            before,
            "a refresh core did not answer changed the checkout"
        );
        let _ = stop.send(true);
        tokio::time::timeout(std::time::Duration::from_secs(5), refreshing)
            .await
            .expect("REFRESH_OUTLIVED_STOP")
            .unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }
}
