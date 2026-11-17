//! One running box of any mode: how it opens, the driver an act runs, and where its view and input
//! streams connect. Each mode's own file says how it does its part.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use futures_util::SinkExt;
use runner_platform::box_settings::BoxSettings;
use runner_preview::codec::ResetCode;
use runner_preview::tunnel::Conn;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::watch;

use crate::android::{self, Android};
use crate::browser::Browser;
use crate::desktop::{self, Desktop};
use crate::{display, input, modes, scrcpy};

/// What every box on this device shares: its settings, where its tools are, what is taken.
pub struct Ctx {
    pub settings: BoxSettings,
    pub env: modes::Env,
    pub data_dir: PathBuf,
    pub x: display::XDirs,
    pub displays: display::Taken,
    pub emulator_ports: android::Ports,
}

impl Ctx {
    /// The directory a box's recording and state live in.
    pub fn box_dir(&self, box_id: &str) -> PathBuf {
        self.data_dir.join("boxes").join(box_id)
    }

    /// The short directories a box's sockets live in (agent-browser's, a desktop's runtime dir),
    /// under `[box] socket_root`: a socket path holds at most 103 bytes. Removed on close.
    pub fn socket_dirs(&self, box_id: &str) -> [PathBuf; 2] {
        let short: String = box_id
            .chars()
            .filter(|c| c.is_ascii_hexdigit())
            .take(8)
            .collect();
        let root = &self.settings.socket_root;
        [root.join(&short), root.join(format!("{short}-x"))]
    }
}

pub struct Spec {
    pub box_id: String,
    pub mode: String,
    pub viewport: Option<(u32, u32)>,
    pub url: Option<String>,
    pub within: Duration,
}

pub enum Running {
    Browser(Browser),
    Android(Android),
    Desktop(Desktop),
}

/// The tool a mode needs, or the refusal naming it.
fn tool(found: Option<PathBuf>, what: &str) -> Result<PathBuf, String> {
    found.ok_or_else(|| format!("this device lacks {what}: run `forge-runner doctor`"))
}

impl Running {
    /// Start a box of `spec.mode`, or say why it could not start.
    pub async fn open(ctx: &Ctx, spec: &Spec) -> Result<Self, String> {
        let dir = ctx.box_dir(&spec.box_id);
        let (s, env) = (&ctx.settings, &ctx.env);
        match spec.mode.as_str() {
            "browser" => {
                let bin = tool(
                    env.pinned("agent-browser", &s.agent_browser),
                    "agent-browser",
                )?;
                let b = Browser::new(
                    &spec.box_id,
                    bin,
                    s,
                    spec.viewport,
                    dir.join("session.webm"),
                )?;
                b.open(spec.url.as_deref(), spec.within).await?;
                Ok(Self::Browser(b))
            }
            "android" => {
                let scrcpy_bin = tool(env.which("scrcpy"), "scrcpy")?;
                let tools = android::Tools {
                    emulator: tool(env.sdk_bin("emulator/emulator"), "the Android emulator")?,
                    adb: tool(env.adb(), "adb")?,
                    agent_device: tool(
                        env.pinned("agent-device", &s.agent_device),
                        "agent-device",
                    )?,
                    sdk: tool(env.sdk.clone(), "an Android SDK")?,
                    scrcpy_server: env.scrcpy_server.clone(),
                    scrcpy_version: scrcpy::version(&scrcpy_bin)
                        .ok_or("scrcpy names no version")?,
                    node_dir: env
                        .which("node")
                        .and_then(|n| n.parent().map(Path::to_path_buf)),
                    avd_home: env.avd_home.clone(),
                };
                ctx.emulator_ports.start_adb(&tools.adb).await;
                let port = ctx.emulator_ports.pick()?;
                let a = Android::new(
                    &spec.box_id,
                    tools,
                    port,
                    dir.join("session.webm"),
                    dir.join("device"),
                );
                let opened = a
                    .open(
                        &s.android_avd,
                        &s.android_snapshot,
                        spec.url.as_deref(),
                        spec.within,
                    )
                    .await;
                ctx.emulator_ports.release(port);
                opened.map(|()| Self::Android(a))
            }
            "desktop" => {
                let need = |b: &str| tool(env.which(b), b);
                let tools = desktop::Tools {
                    xvfb: need("Xvfb")?,
                    dbus_run_session: need("dbus-run-session")?,
                    openbox: need("openbox")?,
                    atspi_launcher: env.atspi_launcher.clone(),
                    x11vnc: need("x11vnc")?,
                    xdotool: need("xdotool")?,
                    ffmpeg: need("ffmpeg")?,
                    agent_desktop: tool(
                        env.pinned("agent-desktop", &s.agent_desktop),
                        "agent-desktop",
                    )?,
                };
                let n = display::pick(s.display_first, s.display_last, &ctx.x, &ctx.displays)?;
                let d = Desktop::new(
                    &spec.box_id,
                    tools,
                    n,
                    spec.viewport,
                    dir.join("session.mkv"),
                    ctx.socket_dirs(&spec.box_id)[1].clone(),
                );
                let opened = d.open(&ctx.x).await;
                ctx.displays.release(n);
                opened.map(|()| Self::Desktop(d))
            }
            other => Err(format!("this runner serves no `{other}` box")),
        }
    }

    pub fn mode(&self) -> &'static str {
        match self {
            Self::Browser(_) => "browser",
            Self::Android(_) => "android",
            Self::Desktop(_) => "desktop",
        }
    }

    /// The driver command an agent's act runs.
    pub fn driver(&self, args: &[String]) -> tokio::process::Command {
        match self {
            Self::Browser(b) => b.driver(args),
            Self::Android(a) => a.driver(args),
            Self::Desktop(d) => d.driver(args),
        }
    }

    /// What a viewer is offered: the codec and the view's size.
    pub fn offer(&self) -> serde_json::Value {
        let (codec, (w, h)) = match self {
            Self::Browser(b) => ("jpeg-frames", b.size),
            Self::Android(a) => ("scrcpy-h264", a.size()),
            Self::Desktop(d) => ("rfb", d.size),
        };
        serde_json::json!({ "codec": codec, "width": w, "height": h })
    }

    pub fn recording(&self) -> &Path {
        match self {
            Self::Browser(b) => &b.recording,
            Self::Android(a) => &a.recording,
            Self::Desktop(d) => &d.recording,
        }
    }

    /// Close the recording so far into a segment and start the next: no mode's recorder has
    /// written what a cut needs until it stops (see `record`).
    pub async fn rotate(&self, file_start: SystemTime) -> Result<SystemTime, String> {
        match self {
            Self::Browser(b) => b.rotate(file_start).await,
            Self::Android(a) => a.rotate(file_start).await,
            Self::Desktop(d) => d.rotate(file_start).await,
        }
    }

    pub async fn navigate(&self, url: &str) -> Result<(), String> {
        match self {
            Self::Browser(b) => b.navigate(url).await,
            Self::Android(a) => a.navigate(url).await,
            Self::Desktop(_) => Err("a desktop box opens no url".into()),
        }
    }

    /// End the recording and the tools gracefully; the reap takes what is left.
    pub async fn stop(&self) {
        match self {
            Self::Browser(b) => b.stop().await,
            Self::Android(a) => a.stop().await,
            Self::Desktop(d) => d.stop().await,
        }
    }

    /// A viewer's stream: the mode's native screen bytes at `fps` where the source sets a rate.
    /// `Err(Lost)` where a browser's stream port is gone, which fails the box.
    pub async fn view(&self, box_id: &str, fps: u32) -> Result<Conn, ViewFault> {
        match self {
            Self::Browser(b) => {
                let port = b.stream_port().map_err(|l| ViewFault::Lost(l.0))?;
                loopback(port).await
            }
            Self::Android(a) => {
                let opts = vec!["control=false".to_string(), format!("max_fps={fps}")];
                let t = &a.tools;
                let (server, video, _) =
                    scrcpy::start(&t.adb, &a.serial, box_id, &t.scrcpy_version, &opts)
                        .await
                        .map_err(ViewFault::Refused)?;
                Ok(Box::new(scrcpy::Held {
                    stream: video,
                    server,
                }))
            }
            Self::Desktop(d) => match d.view_port() {
                Some(port) => loopback(port).await,
                None => Err(ViewFault::Refused("the desktop's view is not up".into())),
            },
        }
    }

    /// The holder's input stream: `BoxInput` lines in, translated for the mode, until the stream
    /// ends or the hold does.
    pub async fn input(
        self: &Arc<Self>,
        box_id: &str,
        held: watch::Receiver<bool>,
    ) -> Result<Conn, String> {
        let (ours, theirs) = tokio::io::duplex(64 * 1024);
        let sink = Sink::open(self, box_id).await?;
        tokio::spawn(feed(ours, sink, held, box_id.to_string()));
        Ok(Box::new(theirs))
    }
}

pub enum ViewFault {
    /// The browser's stream port is gone: the box fails `STREAM_LOST`.
    Lost(String),
    Refused(String),
}

impl ViewFault {
    pub fn reset(&self) -> ResetCode {
        ResetCode::ConnectRefused
    }
}

async fn loopback(port: u16) -> Result<Conn, ViewFault> {
    tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .map(|s| Box::new(s) as Conn)
        .map_err(|e| ViewFault::Refused(format!("the view on loopback port {port} refused: {e}")))
}

/// Where translated input goes for one mode.
enum Sink {
    Browser {
        ws: Box<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        >,
        size: (u32, u32),
    },
    Android {
        control: tokio::net::TcpStream,
        size: (u32, u32),
        _server: Box<scrcpy::Server>,
    },
    Desktop(Arc<Running>),
}

impl Sink {
    async fn open(running: &Arc<Running>, box_id: &str) -> Result<Self, String> {
        match running.as_ref() {
            Running::Browser(b) => {
                let port = b.stream_port().map_err(|l| l.0)?;
                // a server-side client sends no Origin, which agent-browser's socket accepts
                let (ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
                    .await
                    .map_err(|e| format!("agent-browser's stream socket: {e}"))?;
                Ok(Self::Browser {
                    ws: Box::new(ws),
                    size: b.size,
                })
            }
            Running::Android(a) => {
                let opts = vec!["control=true".to_string(), "max_fps=1".to_string()];
                let t = &a.tools;
                let (server, mut video, control) =
                    scrcpy::start(&t.adb, &a.serial, box_id, &t.scrcpy_version, &opts).await?;
                let size = scrcpy::codec_size(&mut video).await?;
                // the video only says the size touches are made for; it is read and dropped
                tokio::spawn(async move {
                    let _ = tokio::io::copy(&mut video, &mut tokio::io::sink()).await;
                });
                let control = control.ok_or("scrcpy opened no control socket")?;
                Ok(Self::Android {
                    control,
                    size,
                    _server: Box::new(server),
                })
            }
            Running::Desktop(_) => Ok(Self::Desktop(running.clone())),
        }
    }

    async fn send(&mut self, line: &input::BoxInput) -> Result<(), String> {
        match self {
            Self::Browser { ws, size } => {
                for m in input::browser(line, size.0, size.1) {
                    ws.send(tokio_tungstenite::tungstenite::Message::Text(
                        m.to_string().into(),
                    ))
                    .await
                    .map_err(|e| format!("agent-browser's socket: {e}"))?;
                }
            }
            Self::Android { control, size, .. } => {
                for m in input::android(line, size.0, size.1) {
                    control
                        .write_all(&m)
                        .await
                        .map_err(|e| format!("scrcpy control: {e}"))?;
                }
            }
            Self::Desktop(running) => {
                let Running::Desktop(d) = running.as_ref() else {
                    return Ok(());
                };
                for argv in input::desktop(line, d.size.0, d.size.1) {
                    let _ = crate::act::run(d.xdotool(&argv), Duration::from_secs(10)).await;
                }
            }
        }
        Ok(())
    }
}

async fn feed(
    ours: tokio::io::DuplexStream,
    mut sink: Sink,
    mut held: watch::Receiver<bool>,
    box_id: String,
) {
    let mut lines = BufReader::new(ours).lines();
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) if line.trim().is_empty() => {}
                Ok(Some(line)) => match input::parse(&line) {
                    Ok(i) => if let Err(e) = sink.send(&i).await {
                        tracing::warn!("[box] {box_id}: input stopped: {e}");
                        return;
                    },
                    Err(e) => tracing::warn!("[box] {box_id}: input line dropped: {e}"),
                },
                _ => return,
            },
            r = held.changed() => if r.is_err() || !*held.borrow() { return },
        }
    }
}
