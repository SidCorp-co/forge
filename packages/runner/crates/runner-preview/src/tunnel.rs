//! The box's half of the preview tunnel (BC-5): a WebSocket this box dials to core's
//! `/ws/preview-tunnel` while it holds a preview, carrying one stream per browser connection. Core
//! opens every stream; the box connects it to the preview's port on its own loopback, from its own
//! record of the preview and never from the frame, and copies bytes both ways without reading them.
//! A stream to a Forge Box's channel (ISS-1276) goes to whatever that box's endpoints connect it to:
//! the box's own loopback stream for `view`, its input translator for `input`.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, watch, Notify};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::header, Message};

use crate::codec::{self, Channel, Frame, ResetCode, Target};

/// The ports of the previews this box serves now, by preview id.
pub type Ports = Arc<Mutex<HashMap<String, u16>>>;

/// One end of a stream on this box: a loopback socket, or a box's own pipe.
pub trait Duplex: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Duplex for T {}
pub type Conn = Box<dyn Duplex>;
pub type Connecting = Pin<Box<dyn Future<Output = Result<Conn, ResetCode>> + Send>>;

/// The Forge Boxes this device runs, as the tunnel reaches them (ISS-1276). The box is named by
/// core's frame; the endpoint is the runner's own record of it, never anything the frame carries.
pub trait BoxEndpoints: Send + Sync + 'static {
    /// Connect one stream to a box's channel, or the reason it cannot be.
    fn connect(&self, box_id: &str, channel: Channel) -> Connecting;
}

/// What an open can reach: the previews' ports, and the boxes where this runner runs them.
#[derive(Clone)]
pub struct Targets {
    pub ports: Ports,
    pub boxes: Option<Arc<dyn BoxEndpoints>>,
}

pub struct TunnelConfig {
    /// `wss://<core>/ws/preview-tunnel`.
    pub url: String,
    pub device_token: String,
}

/// How long the tunnel stays up once no preview needs it, so a reopen does not redial.
const LINGER: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const OUTBOUND_FRAMES: usize = 256;
const PING_EVERY: Duration = Duration::from_secs(25);

/// Keep the tunnel up while `wanted` says a preview needs it, redialling with the control socket's
/// backoff (1 s to 30 s), until `cancel`.
pub async fn run(
    cfg: TunnelConfig,
    targets: Targets,
    mut wanted: watch::Receiver<bool>,
    mut cancel: watch::Receiver<bool>,
) {
    let mut backoff = 1u64;
    loop {
        while !*wanted.borrow() {
            tokio::select! {
                r = wanted.changed() => if r.is_err() { return },
                r = cancel.changed() => if r.is_err() || *cancel.borrow() { return },
            }
        }
        match connect(&cfg).await {
            Ok(ws) => {
                backoff = 1;
                tracing::info!("[preview] tunnel connected");
                if serve(ws, &targets, &mut wanted, &mut cancel).await {
                    return;
                }
                tracing::info!("[preview] tunnel closed");
            }
            Err(e) => tracing::warn!("[preview] tunnel connect failed: {e}"),
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(backoff)) => {}
            r = cancel.changed() => if r.is_err() || *cancel.borrow() { return },
        }
        backoff = (backoff * 2).min(30);
    }
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(cfg: &TunnelConfig) -> Result<Socket, String> {
    let mut request = cfg
        .url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("bad tunnel url {}: {e}", cfg.url))?;
    let bearer = format!("Bearer {}", cfg.device_token)
        .parse()
        .map_err(|_| "the device token is not a header value".to_string())?;
    request.headers_mut().insert(header::AUTHORIZATION, bearer);
    let (ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| e.to_string())?;
    Ok(ws)
}

/// One frame for the writer, refused by the codec only for a bug in this file.
fn wire(frame: &Frame) -> Vec<u8> {
    codec::encode(frame).unwrap_or_else(|e| panic!("preview tunnel: encoding {frame:?}: {e}"))
}

enum Inbound {
    Data(Vec<u8>),
    Window(u32),
    Close,
    Reset,
}

struct Streams {
    by_id: HashMap<u32, (String, mpsc::UnboundedSender<Inbound>)>,
}

impl Streams {
    fn count_of(&self, preview: &str) -> usize {
        self.by_id.values().filter(|(p, _)| p == preview).count()
    }
}

/// One connected tunnel, until it drops (`false`: redial) or `cancel` (`true`: stop).
async fn serve(
    ws: Socket,
    targets: &Targets,
    wanted: &mut watch::Receiver<bool>,
    cancel: &mut watch::Receiver<bool>,
) -> bool {
    let (mut sink, mut source) = ws.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(OUTBOUND_FRAMES);
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let (done_tx, mut done_rx) = mpsc::unbounded_channel::<u32>();
    let mut streams = Streams {
        by_id: HashMap::new(),
    };
    let mut idle_since: Option<tokio::time::Instant> = None;
    let mut ping = tokio::time::interval(PING_EVERY);
    let stop = loop {
        let linger = async {
            match idle_since {
                Some(at) => tokio::time::sleep_until(at + LINGER).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            msg = source.next() => match msg {
                Some(Ok(Message::Binary(bytes))) => {
                    on_message(&bytes, &mut streams, targets, &out_tx, &done_tx);
                }
                Some(Ok(Message::Ping(data))) => { let _ = out_tx.try_send(Message::Pong(data)); }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break false,
                Some(Ok(_)) => {}
            },
            Some(id) = done_rx.recv() => { streams.by_id.remove(&id); }
            _ = ping.tick() => { let _ = out_tx.try_send(Message::Ping(Vec::new().into())); }
            r = wanted.changed() => {
                if r.is_err() { break true; }
                idle_since = if *wanted.borrow() { None } else { Some(tokio::time::Instant::now()) };
            }
            _ = linger => break false,
            r = cancel.changed() => if r.is_err() || *cancel.borrow() { break true },
        }
    };
    for (_, (_, tx)) in streams.by_id.drain() {
        let _ = tx.send(Inbound::Reset);
    }
    drop(out_tx);
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
    stop
}

fn on_message(
    bytes: &[u8],
    streams: &mut Streams,
    targets: &Targets,
    out: &mpsc::Sender<Message>,
    done: &mpsc::UnboundedSender<u32>,
) {
    let reset = |stream: u32, code: ResetCode| {
        let _ = out.try_send(Message::Binary(wire(&Frame::Reset { stream, code }).into()));
    };
    let frame = match codec::decode(bytes) {
        Ok(frame) => frame,
        Err(fault) => {
            tracing::warn!("[preview] bad tunnel frame: {}", fault.detail);
            if let Some(stream) = fault.stream {
                if let Some((_, tx)) = streams.by_id.remove(&stream) {
                    let _ = tx.send(Inbound::Reset);
                }
                reset(stream, ResetCode::Protocol);
            }
            return;
        }
    };
    let stream = frame.stream();
    let inbound = match frame {
        Frame::Open { target, .. } => {
            return open(stream, target, streams, targets, out, done, reset);
        }
        Frame::Data { bytes, .. } => Inbound::Data(bytes),
        Frame::Window { delta, .. } => Inbound::Window(delta),
        Frame::Close { .. } => Inbound::Close,
        Frame::Reset { .. } => {
            if let Some((_, tx)) = streams.by_id.remove(&stream) {
                let _ = tx.send(Inbound::Reset);
            }
            return;
        }
    };
    match streams.by_id.get(&stream) {
        Some((_, tx)) => {
            let _ = tx.send(inbound);
        }
        None => reset(stream, ResetCode::Protocol),
    }
}

fn open(
    stream: u32,
    target: Target,
    streams: &mut Streams,
    targets: &Targets,
    out: &mpsc::Sender<Message>,
    done: &mpsc::UnboundedSender<u32>,
    reset: impl Fn(u32, ResetCode),
) {
    if streams.by_id.contains_key(&stream) {
        return reset(stream, ResetCode::Protocol);
    }
    let key = target.key();
    if streams.by_id.len() >= codec::MAX_STREAMS_PER_TUNNEL
        || streams.count_of(&key) >= codec::MAX_STREAMS_PER_PREVIEW
    {
        return reset(stream, ResetCode::StreamLimit);
    }
    let connecting: Connecting = match target {
        Target::Preview(preview) => {
            let port = targets
                .ports
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&preview)
                .copied();
            let Some(port) = port else {
                return reset(stream, ResetCode::PreviewNotRunning);
            };
            Box::pin(async move {
                match tokio::time::timeout(
                    CONNECT_TIMEOUT,
                    crate::devserver::connect_loopback(port),
                )
                .await
                {
                    Ok(Ok(tcp)) => Ok(Box::new(tcp) as Conn),
                    _ => Err(ResetCode::ConnectRefused),
                }
            })
        }
        Target::Box { box_id, channel } => match &targets.boxes {
            Some(boxes) => boxes.connect(&box_id, channel),
            None => return reset(stream, ResetCode::PreviewNotRunning),
        },
    };
    let (tx, rx) = mpsc::unbounded_channel();
    streams.by_id.insert(stream, (key, tx));
    let (out, done) = (out.clone(), done.clone());
    tokio::spawn(async move {
        match connecting.await {
            Ok(conn) => pipe(stream, conn, rx, &out).await,
            Err(code) => {
                send(&out, Frame::Reset { stream, code }).await;
            }
        }
        let _ = done.send(stream);
    });
}

/// The credit the box may still send on one stream, and the wake when core grants more.
#[derive(Default)]
struct Credit {
    left: Mutex<u32>,
    more: Notify,
}

impl Credit {
    fn add(&self, delta: u32) {
        let mut left = self.left.lock().unwrap_or_else(|p| p.into_inner());
        *left = left.saturating_add(delta);
        self.more.notify_one();
    }

    /// Wait for credit, and take up to `want` of it.
    async fn take(&self, want: u32) -> u32 {
        loop {
            {
                let mut left = self.left.lock().unwrap_or_else(|p| p.into_inner());
                if *left > 0 {
                    let n = want.min(*left);
                    *left -= n;
                    return n;
                }
            }
            self.more.notified().await;
        }
    }

    fn give_back(&self, unused: u32) {
        self.add(unused);
    }
}

async fn send(out: &mpsc::Sender<Message>, frame: Frame) -> bool {
    out.send(Message::Binary(wire(&frame).into())).await.is_ok()
}

/// One stream: copy both ways between core and the connected end within the credit.
async fn pipe(
    stream: u32,
    conn: Conn,
    mut inbound: mpsc::UnboundedReceiver<Inbound>,
    out: &mpsc::Sender<Message>,
) {
    let (rd, mut wr) = tokio::io::split(conn);
    let credit = Arc::new(Credit::default());
    credit.add(codec::INITIAL_WINDOW);
    let activity = Arc::new(Mutex::new(tokio::time::Instant::now()));
    let mut upload = tokio::spawn(upload(
        stream,
        rd,
        credit.clone(),
        out.clone(),
        activity.clone(),
    ));
    let mut uploaded = false;
    let mut remote_closed = false;
    let mut allowance = codec::INITIAL_WINDOW;
    let mut consumed = 0u32;
    let idle = Duration::from_secs(codec::STREAM_IDLE_SECONDS);
    let mut check = tokio::time::interval(Duration::from_secs(15));
    loop {
        if uploaded && remote_closed {
            break;
        }
        tokio::select! {
            m = inbound.recv() => match m {
                Some(Inbound::Data(bytes)) => {
                    *activity.lock().unwrap_or_else(|p| p.into_inner()) = tokio::time::Instant::now();
                    let n = bytes.len() as u32;
                    if n > allowance {
                        send(out, Frame::Reset { stream, code: ResetCode::WindowExceeded }).await;
                        break;
                    }
                    allowance -= n;
                    if wr.write_all(&bytes).await.is_err() {
                        send(out, Frame::Reset { stream, code: ResetCode::Cancelled }).await;
                        break;
                    }
                    consumed += n;
                    if consumed >= codec::WINDOW_UPDATE_AT {
                        send(out, Frame::Window { stream, delta: consumed }).await;
                        allowance += consumed;
                        consumed = 0;
                    }
                }
                Some(Inbound::Window(delta)) => credit.add(delta),
                Some(Inbound::Close) => { remote_closed = true; let _ = wr.shutdown().await; }
                Some(Inbound::Reset) | None => break,
            },
            r = &mut upload, if !uploaded => {
                uploaded = true;
                if !matches!(r, Ok(true)) { break; }
            }
            _ = check.tick() => {
                let last = *activity.lock().unwrap_or_else(|p| p.into_inner());
                if last.elapsed() >= idle {
                    send(out, Frame::Reset { stream, code: ResetCode::Idle }).await;
                    break;
                }
            }
        }
    }
    upload.abort();
}

/// The connected end's bytes to core, as data frames within the credit; `true` once it half-closed.
async fn upload(
    stream: u32,
    mut rd: tokio::io::ReadHalf<Conn>,
    credit: Arc<Credit>,
    out: mpsc::Sender<Message>,
    activity: Arc<Mutex<tokio::time::Instant>>,
) -> bool {
    let mut buf = vec![0u8; codec::MAX_DATA_BYTES];
    loop {
        let n = credit.take(codec::MAX_DATA_BYTES as u32).await;
        let read = match rd.read(&mut buf[..n as usize]).await {
            Ok(read) => read,
            Err(_) => {
                send(
                    &out,
                    Frame::Reset {
                        stream,
                        code: ResetCode::Cancelled,
                    },
                )
                .await;
                return false;
            }
        };
        if read == 0 {
            return send(&out, Frame::Close { stream }).await;
        }
        credit.give_back(n - read as u32);
        *activity.lock().unwrap_or_else(|p| p.into_inner()) = tokio::time::Instant::now();
        if !send(
            &out,
            Frame::Data {
                stream,
                bytes: buf[..read].to_vec(),
            },
        )
        .await
        {
            return false;
        }
    }
}

#[cfg(test)]
mod tests;
