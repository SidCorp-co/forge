//! Forge Boxes on this device (ISS-1276, ADR 0015): a screen an agent tests a UI in, which a person
//! watches, takes and hands back from Forge. A box is a kernel record in core; this crate only runs
//! it (ADR 0009). Core sends `box.*` frames and decides who holds a box, what is a read, who views
//! and when a request waits; the runner starts and stops the mode's tools, runs the acts it is
//! sent, carries the view and input streams on the preview tunnel, cuts the clips core orders, and
//! reports what it measured. It holds no maximum: the heartbeat's `box` health says what is free.

pub mod act;
pub mod android;
pub mod browser;
pub mod canary;
pub mod core;
pub mod desktop;
pub mod display;
mod endpoints;
pub mod frames;
pub mod health;
pub mod input;
pub mod mode;
pub mod modes;
pub mod proc;
pub mod record;
pub mod scrcpy;
pub mod setup;
mod slots;
#[cfg(test)]
mod testkit;

pub use frames::FRAMES;
pub use slots::Boxes;
