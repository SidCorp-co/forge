//! The proxy against a fake Chrome: a tiny local server answering `/json/version` and a CDP
//! WebSocket that records every call it gets and answers each with an empty result.

use std::sync::Mutex;

use super::*;

/// A stand-in for core: every report the proxy made.
#[derive(Default)]
pub(crate) struct Reports(pub(crate) Mutex<Vec<(String, Value)>>);

impl Core for Reports {
    fn report<'a>(&'a self, box_id: &'a str, body: Value) -> Fut<'a, ()> {
        self.0.lock().unwrap().push((box_id.to_string(), body));
        Box::pin(async {})
    }
    fn clip<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: Vec<u8>,
        _: Vec<u8>,
    ) -> Fut<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

impl Reports {
    /// Every feed line reported, in order: (method, count, refused).
    pub(crate) fn acts(&self) -> Vec<(String, u64, bool)> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, b)| b["kind"] == "cdp")
            .flat_map(|(_, b)| b["acts"].as_array().cloned().unwrap_or_default())
            .map(|a| {
                (
                    a["method"].as_str().unwrap().to_string(),
                    a["count"].as_u64().unwrap(),
                    a["refused"].as_bool().unwrap(),
                )
            })
            .collect()
    }
}

/// A fake Chrome on a loopback port: the calls its CDP socket got, by method.
pub(crate) struct FakeChrome {
    pub(crate) addr: String,
    pub(crate) got: Arc<Mutex<Vec<String>>>,
}

pub(crate) async fn fake_chrome() -> FakeChrome {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let got = Arc::new(Mutex::new(Vec::new()));
    let (a, g) = (addr.clone(), got.clone());
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let (a, g) = (a.clone(), g.clone());
            tokio::spawn(async move {
                let head = read_head(&sock).await.unwrap();
                if !parse_head(&head).unwrap().1 {
                    let body = json!({
                        "Browser": "Chrome/142.0",
                        "webSocketDebuggerUrl": format!("ws://{a}/devtools/browser/b1"),
                    })
                    .to_string();
                    let mut skip = vec![0u8; head.len()];
                    sock.read_exact(&mut skip).await.unwrap();
                    respond(&mut sock, "200 OK", "application/json", &body)
                        .await
                        .unwrap();
                    return;
                }
                let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
                while let Some(Ok(Message::Text(t))) = ws.next().await {
                    let call: Value = serde_json::from_str(&t).unwrap();
                    g.lock()
                        .unwrap()
                        .push(call["method"].as_str().unwrap().to_string());
                    let mut answer = json!({ "id": call["id"], "result": {} });
                    if let Some(s) = call.get("sessionId") {
                        answer["sessionId"] = s.clone();
                    }
                    ws.send(Message::Text(answer.to_string().into()))
                        .await
                        .unwrap();
                }
            });
        }
    });
    FakeChrome { addr, got }
}

pub(crate) fn upstream_at(addr: &str) -> Upstream {
    let addr = addr.to_string();
    Arc::new(move || {
        let a = addr.clone();
        Box::pin(async move { Ok(a) })
    })
}

const ID: &str = "0b8e7a52-3c4d-4e6f-8a1b-2c3d4e5f6a7b";

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

/// Send one call and read its answer.
pub(crate) async fn call(ws: &mut Ws, id: u64, method: &str, session: Option<&str>) -> Value {
    let mut c = json!({ "id": id, "method": method, "params": {} });
    if let Some(s) = session {
        c["sessionId"] = s.into();
    }
    ws.send(Message::Text(c.to_string().into())).await.unwrap();
    loop {
        let m = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("an answer")
            .unwrap()
            .unwrap();
        let v: Value = serde_json::from_str(m.to_text().unwrap()).unwrap();
        if v["id"] == id {
            return v;
        }
    }
}

/// The browser socket an agent reaches through the proxy, found as Playwright finds it.
pub(crate) async fn attach(url: &str) -> Ws {
    let version: Value = reqwest::get(format!("{url}/json/version"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let ws = version["webSocketDebuggerUrl"].as_str().unwrap();
    let port = url.rsplit(':').next().unwrap();
    assert_eq!(
        ws,
        format!("ws://127.0.0.1:{port}/devtools/browser/b1"),
        "discovery points at the proxy, never Chrome's own port"
    );
    tokio_tungstenite::connect_async(ws).await.unwrap().0
}

pub(crate) async fn acts_settled(reports: &Reports, n: usize) -> Vec<(String, u64, bool)> {
    for _ in 0..60 {
        if reports.acts().iter().map(|a| a.1 as usize).sum::<usize>() >= n {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    reports.acts()
}

#[tokio::test]
async fn a_navigate_passes_while_free_is_refused_by_name_while_held_and_passes_after_release() {
    let chrome = fake_chrome().await;
    let reports = Arc::new(Reports::default());
    let (hold, held) = watch::channel(false);
    let proxy = serve(ID, upstream_at(&chrome.addr), held, reports.clone())
        .await
        .unwrap();
    let mut ws = attach(&proxy.url()).await;

    let free = call(&mut ws, 1, "Page.navigate", None).await;
    assert_eq!(free["result"], json!({}), "{free}");

    hold.send_replace(true);
    let refused = call(&mut ws, 2, "Page.navigate", Some("S1")).await;
    assert_eq!(refused["error"]["code"], REFUSED);
    let said = refused["error"]["message"].as_str().unwrap();
    assert!(
        said.starts_with("BOX_HELD_BY_PERSON:") && said.contains("Page.navigate"),
        "{said}"
    );
    assert_eq!(
        refused["sessionId"], "S1",
        "answered on the session it came on"
    );
    let click = call(&mut ws, 3, "Input.dispatchMouseEvent", Some("S1")).await;
    assert!(click["error"]["message"]
        .as_str()
        .unwrap()
        .contains("BOX_HELD_BY_PERSON"));
    let read = call(&mut ws, 4, "Accessibility.getFullAXTree", Some("S1")).await;
    assert_eq!(
        read["result"],
        json!({}),
        "a read answers while held: {read}"
    );

    hold.send_replace(false);
    let again = call(&mut ws, 5, "Page.navigate", None).await;
    assert_eq!(again["result"], json!({}), "{again}");

    assert_eq!(
        *chrome.got.lock().unwrap(),
        [
            "Page.navigate",
            "Accessibility.getFullAXTree",
            "Page.navigate"
        ],
        "a refused call never reaches the browser, so the page does not move"
    );
    assert_eq!(
        acts_settled(&reports, 4).await,
        [
            ("Page.navigate".to_string(), 1, false),
            ("Page.navigate".to_string(), 1, true),
            ("Input.dispatchMouseEvent".to_string(), 1, true),
            ("Page.navigate".to_string(), 1, false),
        ],
        "every write reaches the feed by its method, a read never does"
    );
    assert!(reports.0.lock().unwrap().iter().all(|(b, _)| b == ID));
}

#[tokio::test]
async fn a_run_of_one_method_is_one_feed_line_with_its_count() {
    let chrome = fake_chrome().await;
    let reports = Arc::new(Reports::default());
    let proxy = serve(
        ID,
        upstream_at(&chrome.addr),
        watch::channel(false).1,
        reports.clone(),
    )
    .await
    .unwrap();
    let mut ws = attach(&proxy.url()).await;
    for id in 1..=3 {
        call(&mut ws, id, "Input.dispatchMouseEvent", None).await;
    }
    call(&mut ws, 4, "Page.enable", None).await;
    call(&mut ws, 5, "Runtime.evaluate", None).await;
    assert_eq!(
        acts_settled(&reports, 4).await,
        [
            ("Input.dispatchMouseEvent".to_string(), 3, false),
            ("Runtime.evaluate".to_string(), 1, false),
        ]
    );
}

#[tokio::test]
async fn a_path_the_proxy_does_not_serve_and_a_browser_gone_are_refused_by_name() {
    let chrome = fake_chrome().await;
    let reports = Arc::new(Reports::default());
    let proxy = serve(
        ID,
        upstream_at(&chrome.addr),
        watch::channel(false).1,
        reports.clone(),
    )
    .await
    .unwrap();
    let new_page = reqwest::get(format!("{}/json/new?about:blank", proxy.url()))
        .await
        .unwrap();
    assert_eq!(new_page.status().as_u16(), 404);
    assert!(new_page
        .text()
        .await
        .unwrap()
        .contains("Target.createTarget"));

    let gone: Upstream =
        Arc::new(|| Box::pin(async { Err("agent-browser's daemon is gone".to_string()) }));
    let proxy = serve(ID, gone, watch::channel(false).1, reports)
        .await
        .unwrap();
    let answer = reqwest::get(format!("{}/json/version", proxy.url()))
        .await
        .unwrap();
    assert_eq!(answer.status().as_u16(), 502);
    assert!(answer.text().await.unwrap().contains("daemon is gone"));
}

#[tokio::test]
async fn dropping_the_proxy_ends_its_attached_sessions() {
    let chrome = fake_chrome().await;
    let proxy = serve(
        ID,
        upstream_at(&chrome.addr),
        watch::channel(false).1,
        Arc::new(Reports::default()),
    )
    .await
    .unwrap();
    let url = proxy.url();
    let mut ws = attach(&url).await;
    drop(proxy);
    let ended = tokio::time::timeout(Duration::from_secs(5), ws.next()).await;
    assert!(
        matches!(ended, Ok(None | Some(Err(_)) | Some(Ok(Message::Close(_))))),
        "{ended:?}"
    );
    assert!(
        reqwest::get(format!("{url}/json/version")).await.is_err(),
        "nothing listens"
    );
}
