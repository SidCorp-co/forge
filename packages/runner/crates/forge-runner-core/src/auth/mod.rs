//! Auth & credential storage.
//!
//! - `pairing`    — paste-code device pairing (`POST /api/devices/pair`) (M1);
//!   browser-approve device-auth (RFC 8628) lands as `device_auth` (C1)
//! - `cred_store` — keychain via `keyring`, with `0600` file fallback on
//!   headless Linux; `FORGE_RUNNER_CRED_STORE=keychain|file` to force (M1)

pub mod cred_store;
pub mod pairing;
