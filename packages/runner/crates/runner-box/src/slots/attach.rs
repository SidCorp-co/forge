//! A box's attach door on this device (ISS-1322): a browser box gets a CDP proxy when it opens,
//! bound by the hold core says (`box.take`/`box.release`) and reporting into the act feed; its URL
//! rides the `ready` report, and core hands it only to an agent on this device. An android box's
//! adb serial and a desktop's display cannot be taken back when a person takes the box, so they are
//! never handed out: core refuses their attach `BOX_ATTACH_UNAVAILABLE` by name.

use super::*;
use crate::cdp;

impl Boxes {
    /// Start a browser box's CDP proxy, kept in its slot until the box goes; the `attach` its
    /// `ready` report carries. None for another mode, or where the proxy could not start (said).
    pub(super) async fn attach_on(&self, id: &str, running: &Arc<Running>) -> Option<Value> {
        if !matches!(running.as_ref(), Running::Browser(_)) {
            return None;
        }
        let held = self.slots().get(id)?.held.subscribe();
        let r = running.clone();
        let upstream: cdp::Upstream = Arc::new(move || {
            let r = r.clone();
            Box::pin(async move {
                match r.as_ref() {
                    Running::Browser(b) => b.cdp_upstream().await,
                    _ => Err("not a browser box".to_string()),
                }
            })
        });
        match cdp::serve(id, upstream, held, self.0.core.clone()).await {
            Ok(proxy) => {
                let said = json!({ "cdp": proxy.url() });
                self.slots().get_mut(id)?.attach = Some(proxy);
                Some(said)
            }
            Err(why) => {
                tracing::error!("[box] {id}: no attach door for this box: {why}");
                None
            }
        }
    }

    /// The `attach` a box's proxy answers at, for a `ready` after its hand-out.
    pub(super) fn attach_of(&self, id: &str) -> Option<Value> {
        let slots = self.slots();
        let proxy = slots.get(id)?.attach.as_ref()?;
        Some(json!({ "cdp": proxy.url() }))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::tests::{boxes, Said};
    use super::*;
    use crate::browser::Browser;
    use crate::cdp::tests::{attach, call, fake_chrome};
    use crate::testkit::{box_id, Scratch};

    /// A browser box `id` whose agent-browser is a script naming the fake Chrome's CDP URL.
    async fn browser_box(b: &Boxes, root: &Scratch, id: &str, chrome: &str) -> Arc<Running> {
        let bin = root.script(
            "bin/agent-browser",
            &format!("[ \"$1 $2\" = \"get cdp-url\" ] && echo ws://{chrome}/devtools/browser/b1"),
        );
        let browser = Browser::new(id, bin, &b.0.ctx.settings, None, root.path().join("r.webm"));
        let running = Arc::new(Running::Browser(browser.unwrap()));
        b.slots().insert(
            id.into(),
            Slot {
                running: Some(running.clone()),
                held: watch::channel(false).0,
                clock: record::Clock::started_now(),
                recording: false,
                warm: false,
                closing: false,
                attach: None,
            },
        );
        running
    }

    #[tokio::test]
    async fn a_browser_boxs_attach_follows_the_hold_core_sends_and_goes_with_the_box() {
        let id = box_id();
        let root = Scratch::new("attach");
        let b = boxes(&root, Arc::new(Said::default()));
        let chrome = fake_chrome().await;
        let running = browser_box(&b, &root, id, &chrome.addr).await;

        let said = b
            .attach_on(id, &running)
            .await
            .expect("a browser box attaches");
        let url = said["cdp"].as_str().unwrap().to_string();
        assert!(url.starts_with("http://127.0.0.1:"), "{url}");
        assert_eq!(b.attach_of(id), Some(said));

        let mut ws = attach(&url).await;
        assert_eq!(
            call(&mut ws, 1, "Page.navigate", None).await["result"],
            json!({})
        );
        b.handle(
            "box.take",
            json!({ "boxId": id, "userId": id, "name": "An" }),
        )
        .await
        .unwrap();
        let refused = call(&mut ws, 2, "Page.navigate", None).await;
        assert!(refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("BOX_HELD_BY_PERSON"));
        b.handle("box.release", json!({ "boxId": id, "why": "released" }))
            .await
            .unwrap();
        assert_eq!(
            call(&mut ws, 3, "Page.navigate", None).await["result"],
            json!({})
        );
        assert_eq!(
            *chrome.got.lock().unwrap(),
            ["Page.navigate", "Page.navigate"]
        );

        b.slots().remove(id);
        assert!(
            reqwest::get(format!("{url}/json/version")).await.is_err(),
            "the proxy goes with its box"
        );
    }
}
