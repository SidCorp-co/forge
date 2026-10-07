use thiserror::Error;

/// Crate-wide error type.
#[derive(Debug, Error)]
pub enum Error {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("config error: {0}")]
    Config(String),

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

    /// Core answered `422` naming a take refusal: the issues are held by something that
    /// is not this request's shape and not this moment's luck, a `blocks` edge, an
    /// unapproved design, an unsettled contract wait or another holder's lease. Sending
    /// the same declaration again before that changes is a loop, and sending it never is
    /// a stranded run, so a caller that sweeps matches this to slow its retry and say
    /// so once.
    #[error("{said}")]
    Held {
        /// The refusal as any other would read it, from `transport::status`.
        said: String,
        /// Core's refusal code, such as `ISSUE_BLOCKED`.
        code: String,
    },

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;
