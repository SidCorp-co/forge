//! Forge Runner core library.
//!
//! Holds everything the daemon does, with zero CLI/GUI coupling so a thin
//! GUI/tray frontend can later drive the same logic over a local socket.

pub mod auth;
pub mod config;
pub mod daemon;
pub mod error;
pub mod mcp;
pub mod observability;
pub mod runner;
pub mod transport;
pub mod workspace;

pub use error::{Error, Result};
