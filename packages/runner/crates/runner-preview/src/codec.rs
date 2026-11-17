//! The preview tunnel's frames, mirroring `packages/contracts/src/preview-tunnel.ts` byte for byte:
//! a 12-byte big-endian header (version 1, type, flags 0, stream id, length) and, for `open` and
//! `data`, the payload. An `open` names a preview, or a Forge Box's channel (ISS-1276): its `view`
//! at the viewer's frame rate, or its holder's `input`. The fixtures both sides read
//! (`packages/contracts/fixtures/preview-tunnel-frames.json`) hold the two to one encoding.

/// The protocol version; yamux's 0 is refused so the two are never mistaken for each other.
pub const VERSION: u8 = 1;
pub const HEADER_BYTES: usize = 12;
pub const MAX_DATA_BYTES: usize = 65_536;
pub const MAX_OPEN_BYTES: usize = 1024;
pub const INITIAL_WINDOW: u32 = 262_144;
pub const WINDOW_UPDATE_AT: u32 = 131_072;
/// The box's backstop: twice core's limits (`boxStreamsPerPreview`, `boxStreamsPerTunnel`), because
/// core queues what passes its own and forgets a stream when it sends the reset, the box when it
/// reads it.
pub const MAX_STREAMS_PER_PREVIEW: usize = 128;
pub const MAX_STREAMS_PER_TUNNEL: usize = 1024;
pub const STREAM_IDLE_SECONDS: u64 = 300;
/// The frame rates a box view stream is opened at (`TUNNEL_BOX_FPS`).
pub const BOX_FPS: std::ops::RangeInclusive<u32> = 1..=30;

/// Why a stream was torn down; the wire carries the number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetCode {
    ConnectRefused = 1,
    PreviewNotRunning = 2,
    StreamLimit = 3,
    Protocol = 4,
    WindowExceeded = 5,
    Cancelled = 6,
    Idle = 7,
}

impl ResetCode {
    pub fn of(code: u32) -> Option<Self> {
        Some(match code {
            1 => Self::ConnectRefused,
            2 => Self::PreviewNotRunning,
            3 => Self::StreamLimit,
            4 => Self::Protocol,
            5 => Self::WindowExceeded,
            6 => Self::Cancelled,
            7 => Self::Idle,
            _ => return None,
        })
    }

    /// The contract's name for the code.
    pub fn name(self) -> &'static str {
        match self {
            Self::ConnectRefused => "CONNECT_REFUSED",
            Self::PreviewNotRunning => "PREVIEW_NOT_RUNNING",
            Self::StreamLimit => "STREAM_LIMIT",
            Self::Protocol => "PROTOCOL",
            Self::WindowExceeded => "WINDOW_EXCEEDED",
            Self::Cancelled => "CANCELLED",
            Self::Idle => "IDLE",
        }
    }
}

/// What an `open` asks the box to connect: a preview's dev server, or one channel of a Forge Box.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Preview(String),
    Box { box_id: String, channel: Channel },
}

/// A Forge Box stream's channel (`TunnelBoxTarget`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    /// The box's screen, at the viewer's own rate.
    View { fps: u32 },
    /// The holder's `BoxInput` lines.
    Input,
}

impl Target {
    /// The key the per-target stream limit counts under.
    pub fn key(&self) -> String {
        match self {
            Self::Preview(id) => id.clone(),
            Self::Box { box_id, .. } => format!("box:{box_id}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Open { stream: u32, target: Target },
    Data { stream: u32, bytes: Vec<u8> },
    Window { stream: u32, delta: u32 },
    Close { stream: u32 },
    Reset { stream: u32, code: ResetCode },
}

/// Why bytes are not a frame: the stream they named, where the header got that far, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fault {
    pub stream: Option<u32>,
    pub detail: String,
}

impl Frame {
    pub fn stream(&self) -> u32 {
        match self {
            Self::Open { stream, .. }
            | Self::Data { stream, .. }
            | Self::Window { stream, .. }
            | Self::Close { stream }
            | Self::Reset { stream, .. } => *stream,
        }
    }
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// The frame as one binary WebSocket message. A frame the contract forbids is refused by name.
pub fn encode(frame: &Frame) -> Result<Vec<u8>, String> {
    let stream = frame.stream();
    if stream == 0 {
        return Err("tunnel frame streamId 0 is not 1..4294967295".into());
    }
    let (kind, length, payload): (u8, u32, Vec<u8>) = match frame {
        Frame::Open { target, .. } => {
            let body = open_body(target)?.to_string();
            (1, body.len() as u32, body.into_bytes())
        }
        Frame::Data { bytes, .. } => {
            if bytes.is_empty() || bytes.len() > MAX_DATA_BYTES {
                return Err(format!(
                    "tunnel data frame carries {} bytes; one carries 1..{MAX_DATA_BYTES}",
                    bytes.len()
                ));
            }
            (2, bytes.len() as u32, bytes.clone())
        }
        Frame::Window { delta, .. } => {
            if *delta == 0 {
                return Err("tunnel window delta 0 is not 1..4294967295".into());
            }
            (3, *delta, Vec::new())
        }
        Frame::Close { .. } => (4, 0, Vec::new()),
        Frame::Reset { code, .. } => (5, *code as u32, Vec::new()),
    };
    let mut out = Vec::with_capacity(HEADER_BYTES + payload.len());
    out.push(VERSION);
    out.push(kind);
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&stream.to_be_bytes());
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn fault(stream: Option<u32>, detail: String) -> Fault {
    Fault { stream, detail }
}

/// One binary WebSocket message read back into its frame, or the fault that stops it being one.
pub fn decode(message: &[u8]) -> Result<Frame, Fault> {
    if message.len() < HEADER_BYTES {
        return Err(fault(
            None,
            format!(
                "a tunnel frame is at least {HEADER_BYTES} bytes; this message is {}",
                message.len()
            ),
        ));
    }
    let stream = be32(message, 4);
    if message[0] != VERSION {
        return Err(fault(
            None,
            format!(
                "tunnel frame version {}; this side speaks {VERSION}",
                message[0]
            ),
        ));
    }
    let kind = message[1];
    if !(1..=5).contains(&kind) {
        return Err(fault(
            Some(stream),
            format!("tunnel frame type {kind} is not one of 1..5"),
        ));
    }
    if message[2] != 0 || message[3] != 0 {
        return Err(fault(
            Some(stream),
            "tunnel frame flags are reserved and must be 0".into(),
        ));
    }
    if stream == 0 {
        return Err(fault(None, "tunnel stream 0 is reserved".into()));
    }
    let length = be32(message, 8);
    let payload = &message[HEADER_BYTES..];
    decode_body(kind, stream, length, payload)
}

fn decode_body(kind: u8, stream: u32, length: u32, payload: &[u8]) -> Result<Frame, Fault> {
    let carries = kind == 1 || kind == 2;
    if carries && payload.len() as u64 != u64::from(length) {
        return Err(fault(
            Some(stream),
            format!(
                "tunnel {} frame says {length} bytes and carries {}",
                if kind == 1 { "open" } else { "data" },
                payload.len()
            ),
        ));
    }
    if !carries && !payload.is_empty() {
        return Err(fault(
            Some(stream),
            format!(
                "tunnel frame of type {kind} carries {} bytes; it carries none",
                payload.len()
            ),
        ));
    }
    match kind {
        1 => decode_open(stream, length, payload),
        2 if length == 0 || length as usize > MAX_DATA_BYTES => Err(fault(
            Some(stream),
            format!("tunnel data frame carries {length} bytes; one carries 1..{MAX_DATA_BYTES}"),
        )),
        2 => Ok(Frame::Data {
            stream,
            bytes: payload.to_vec(),
        }),
        3 if length == 0 => Err(fault(Some(stream), "tunnel window delta is 0".into())),
        3 => Ok(Frame::Window {
            stream,
            delta: length,
        }),
        4 if length != 0 => Err(fault(
            Some(stream),
            format!("tunnel close frame says {length}; it says 0"),
        )),
        4 => Ok(Frame::Close { stream }),
        _ => match ResetCode::of(length) {
            Some(code) => Ok(Frame::Reset { stream, code }),
            None => Err(fault(
                Some(stream),
                format!("tunnel reset code {length} is not one of 1..7"),
            )),
        },
    }
}

fn decode_open(stream: u32, length: u32, payload: &[u8]) -> Result<Frame, Fault> {
    if length as usize > MAX_OPEN_BYTES {
        return Err(fault(
            Some(stream),
            format!("tunnel open payload is {length} bytes; at most {MAX_OPEN_BYTES}"),
        ));
    }
    match serde_json::from_slice::<serde_json::Value>(payload)
        .ok()
        .as_ref()
        .and_then(open_target)
    {
        Some(target) => Ok(Frame::Open { stream, target }),
        None => Err(fault(
            Some(stream),
            format!(
                "tunnel open payload is not {{\"previewId\": \"<uuid>\"}}, {{\"boxId\": \"<uuid>\", \"channel\": \"view\", \"fps\": {}..{}}} or {{\"boxId\": \"<uuid>\", \"channel\": \"input\"}}",
                BOX_FPS.start(),
                BOX_FPS.end()
            ),
        )),
    }
}

/// The open payload's object, refusing by name a target the contract does not allow. Its keys
/// serialise sorted, which is the order the contract's `JSON.stringify` writes them in.
fn open_body(target: &Target) -> Result<serde_json::Value, String> {
    let (id, name) = match target {
        Target::Preview(id) => (id, "previewId"),
        Target::Box { box_id, .. } => (box_id, "boxId"),
    };
    if !is_uuid(id) {
        return Err(format!(
            "tunnel open names {name} \"{id}\", which is not a uuid"
        ));
    }
    Ok(match target {
        Target::Preview(id) => serde_json::json!({ "previewId": id }),
        Target::Box {
            box_id,
            channel: Channel::Input,
        } => serde_json::json!({ "boxId": box_id, "channel": "input" }),
        Target::Box {
            box_id,
            channel: Channel::View { fps },
        } => {
            if !BOX_FPS.contains(fps) {
                return Err(format!(
                    "tunnel open names fps {fps}; a box view runs at {}..{}",
                    BOX_FPS.start(),
                    BOX_FPS.end()
                ));
            }
            serde_json::json!({ "boxId": box_id, "channel": "view", "fps": fps })
        }
    })
}

/// The target an open payload names, exactly one of the contract's three shapes.
fn open_target(body: &serde_json::Value) -> Option<Target> {
    let o = body.as_object()?;
    let mut keys: Vec<&str> = o.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let uuid = |k: &str| {
        o.get(k)?
            .as_str()
            .filter(|id| is_uuid(id))
            .map(String::from)
    };
    match keys.as_slice() {
        ["previewId"] => uuid("previewId").map(Target::Preview),
        ["boxId", "channel"] if o["channel"] == "input" => Some(Target::Box {
            box_id: uuid("boxId")?,
            channel: Channel::Input,
        }),
        ["boxId", "channel", "fps"] if o["channel"] == "view" => {
            let fps = u32::try_from(o["fps"].as_u64()?).ok()?;
            BOX_FPS.contains(&fps).then_some(())?;
            Some(Target::Box {
                box_id: uuid("boxId")?,
                channel: Channel::View { fps },
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests;
