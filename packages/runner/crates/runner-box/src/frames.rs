//! Core's `device.pushed` frames for boxes (`box-wire.ts` `BoxControlFrames`), as the runner reads
//! them. A frame that does not read is said and dropped: the box it names is core's to settle.

use serde::Deserialize;

pub const FRAMES: [&str; 11] = [
    "box.open",
    "box.close",
    "box.act",
    "box.assign",
    "box.take",
    "box.release",
    "box.span.mark",
    "box.recording.fetch",
    "box.recording.drop",
    "box.recording.set",
    "box.recording.upload",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Open {
    pub box_id: String,
    pub mode: String,
    #[serde(default)]
    pub warm: bool,
    #[serde(default)]
    pub viewport: Option<Viewport>,
    #[serde(default)]
    pub url: Option<String>,
    pub open_timeout_seconds: u64,
    /// Opened for a person to test by hand: they hold it from the start, so their input stream is
    /// admitted at once. A core that names no holder opens it to the agent.
    #[serde(default)]
    pub as_person: bool,
    /// Record the session once it is up (ISS-1321). A core that names none asks for no recording,
    /// and a warm box never records.
    #[serde(default)]
    pub record: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Named {
    pub box_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Act {
    pub box_id: String,
    pub act_id: String,
    pub command: Vec<String>,
    pub kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assign {
    pub box_id: String,
    #[serde(default)]
    pub url: Option<String>,
    /// Handed to a person: they hold it from the hand-out.
    #[serde(default)]
    pub as_person: bool,
    /// Start its recording at the hand-out (ISS-1321).
    #[serde(default)]
    pub record: bool,
}

/// Start or stop a box's recording (ISS-1321).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSet {
    pub box_id: String,
    pub on: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub box_id: String,
    pub span_id: String,
    pub criterion: u32,
    pub edge: String,
    /// `start`: the box was not recording, so its recording starts before this mark; `stop`: this
    /// end closes the recording a span began, after the mark (ISS-1321).
    #[serde(default)]
    pub recording: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetch {
    pub box_id: String,
    pub span_id: String,
    pub from_ms: u64,
    pub to_ms: u64,
    pub max_seconds: u64,
    pub max_bytes: u64,
}

/// Send the box's whole kept recording to core within `max_bytes` (ISS-1338).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    pub box_id: String,
    pub max_bytes: u64,
}

/// What the clip upload names in a span's place for the whole kept recording (`BOX_SESSION_CLIP`).
pub const SESSION_CLIP: &str = "session";

/// A uuid, as every box id is: the id names a directory on this device, so nothing else passes.
pub fn is_uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|u| u.hyphenated().to_string() == s.to_ascii_lowercase())
}
