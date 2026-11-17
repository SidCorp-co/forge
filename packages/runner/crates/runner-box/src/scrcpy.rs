//! scrcpy's server on an android box, one per viewer and one per input stream (`scid` keeps them
//! apart). The view is watch-only at the source (`control=false`) at the viewer's own `max_fps`;
//! the input session is `control=true` with a 1 fps video whose size the touch events are scaled
//! to, since the server drops an event made for another size. Not ws-scrcpy: the installed scrcpy
//! server jar, spoken to directly over an adb forward.
//!
//! What a viewer receives (`BOX_VIEW_CODECS.android`, `scrcpy-h264`), the dummy byte already read:
//! a 12-byte codec header (`u32` codec id `h264`, `u32` width, `u32` height, big-endian), then per
//! packet a 12-byte header (`u64` pts with the config and key-frame flags in its top bits, `u32`
//! size) and the packet.

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;

use crate::proc;

/// Where the server jar is pushed on the device.
pub const DEVICE_JAR: &str = "/data/local/tmp/scrcpy-server.jar";

/// One server and the adb forward to it; dropping it stops the server and removes the forward.
pub struct Server {
    adb: PathBuf,
    serial: String,
    port: u16,
    _child: tokio::process::Child,
}

impl Drop for Server {
    fn drop(&mut self) {
        let (adb, serial, port) = (self.adb.clone(), self.serial.clone(), self.port);
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                let _ = tokio::process::Command::new(adb)
                    .args(["-s", &serial, "forward", "--remove", &format!("tcp:{port}")])
                    .env_remove(proc::MARK)
                    .output()
                    .await;
            });
        }
    }
}

/// A stream that keeps its server running while it is open.
pub struct Held {
    pub stream: TcpStream,
    pub server: Server,
}

impl AsyncRead for Held {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for Held {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

/// The installed scrcpy's version, which the server jar answers only to.
pub fn version(scrcpy: &Path) -> Option<String> {
    let out = crate::modes::run_within(scrcpy, &["--version"], Duration::from_secs(5))?;
    out.split_whitespace().nth(1).map(String::from)
}

/// Start a server with `options` and connect: the video socket, and the control socket where
/// `control=true` is among them.
pub async fn start(
    adb: &Path,
    serial: &str,
    box_id: &str,
    server_version: &str,
    options: &[String],
) -> Result<(Server, TcpStream, Option<TcpStream>), String> {
    let scid = format!("{:08x}", rand_scid());
    let out = tokio::process::Command::new(adb)
        .args([
            "-s",
            serial,
            "forward",
            "tcp:0",
            &format!("localabstract:scrcpy_{scid}"),
        ])
        .env_remove(proc::MARK)
        .output()
        .await
        .map_err(|e| format!("adb forward: {e}"))?;
    let port: u16 = String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .map_err(|_| {
            format!(
                "adb forward named no port: {}",
                String::from_utf8_lossy(&out.stderr)
            )
        })?;
    let mut shell = proc::command(adb, box_id);
    shell
        .args([
            "-s",
            serial,
            "shell",
            &format!("CLASSPATH={DEVICE_JAR}"),
            "app_process",
            "/",
        ])
        .args(["com.genymobile.scrcpy.Server", server_version])
        .arg(format!("scid={scid}"))
        .args([
            "log_level=warn",
            "tunnel_forward=true",
            "audio=false",
            "cleanup=false",
        ])
        .args([
            "send_device_meta=false",
            "send_dummy_byte=true",
            "video_codec=h264",
        ])
        .args(options)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let child = shell
        .spawn()
        .map_err(|e| format!("adb shell scrcpy server: {e}"))?;
    let server = Server {
        adb: adb.to_path_buf(),
        serial: serial.to_string(),
        port,
        _child: child,
    };
    let video = connect_first(port, Duration::from_secs(10)).await?;
    let control = if options.iter().any(|o| o == "control=true") {
        Some(
            TcpStream::connect(("127.0.0.1", port))
                .await
                .map_err(|e| format!("scrcpy control socket: {e}"))?,
        )
    } else {
        None
    };
    Ok((server, video, control))
}

/// The first socket, once the server behind the forward answers with its dummy byte: the forward
/// accepts and drops connections until the server listens.
async fn connect_first(port: u16, within: Duration) -> Result<TcpStream, String> {
    let until = tokio::time::Instant::now() + within;
    loop {
        if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)).await {
            let mut dummy = [0u8; 1];
            if let Ok(Ok(1)) =
                tokio::time::timeout(Duration::from_secs(2), s.read(&mut dummy)).await
            {
                return Ok(s);
            }
        }
        if tokio::time::Instant::now() >= until {
            return Err(format!(
                "the scrcpy server did not answer on its forward (port {port}) within {} s",
                within.as_secs()
            ));
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// Read the 12-byte codec header: the video's width and height.
pub async fn codec_size(video: &mut TcpStream) -> Result<(u32, u32), String> {
    let mut meta = [0u8; 12];
    tokio::time::timeout(Duration::from_secs(10), video.read_exact(&mut meta))
        .await
        .map_err(|_| "the scrcpy server sent no codec header".to_string())?
        .map_err(|e| format!("scrcpy codec header: {e}"))?;
    let be = |i: usize| u32::from_be_bytes([meta[i], meta[i + 1], meta[i + 2], meta[i + 3]]);
    Ok((be(4), be(8)))
}

fn rand_scid() -> u32 {
    u32::from_le_bytes(
        uuid::Uuid::new_v4().as_bytes()[..4]
            .try_into()
            .unwrap_or([1; 4]),
    ) & 0x7fff_ffff
}
