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

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;
