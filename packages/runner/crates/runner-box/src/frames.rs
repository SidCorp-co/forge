//! Core's `device.pushed` frames for boxes (`box-wire.ts` `BoxControlFrames`), as the runner reads
//! them. A frame that does not read is said and dropped: the box it names is core's to settle.

use serde::Deserialize;

pub const FRAMES: [&str; 9] = [
    "box.open",
    "box.close",
    "box.act",
    "box.assign",
    "box.take",
    "box.release",
    "box.span.mark",
    "box.recording.fetch",
    "box.recording.drop",
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub box_id: String,
    pub span_id: String,
    pub criterion: u32,
    pub edge: String,
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

/// A uuid, as every box id is: the id names a directory on this device, so nothing else passes.
pub fn is_uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|u| u.hyphenated().to_string() == s.to_ascii_lowercase())
}
