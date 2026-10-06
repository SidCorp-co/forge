use thiserror::Error;

/// Crate-wide error type.
#[derive(Debug, Error)]
pub enum Error {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("config error: {0}")]
    Config(String),

    #[error("not implemented yet: {0}")]
    NotImplemented(&'static str),

    /// A `401` from core (bad/expired device token or wrong core_url). Callers
    /// match this variant to prompt a re-login — keep it typed rather than
    /// string-matching `Other` so the intent can't drift.
    #[error("UNAUTHORIZED")]
    Unauthorized,

    /// A refusal whose subject is the request's own shape: core named a
    /// constraint the bytes that were sent can never satisfy, so sending them
    /// again is a loop with no exit. A caller that sweeps a payload nothing
    /// between attempts changes matches this to fail once rather than for ever
    /// (ISS-1284). Typed for the same reason `Unauthorized` is.
    #[error("{said}")]
    Malformed {
        /// The refusal as any other would read it, from `transport::status`.
        said: String,
        /// One line per constraint core named, `field: what it said`.
        named: Vec<String>,
    },

    /// A checkout refused because a live agent's process is living in it: the
    /// checkout is that agent's work for as long as it lives, so a release
    /// retries it rather than deciding it (ISS-1390 E1). Typed so the release
    /// can tell it from a refusal no retry gets past.
    #[error("{0}")]
    AgentInTree(String),

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;
