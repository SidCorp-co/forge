//! OS keychain integration for tokens that must outlive on-disk
//! `config.json` (which intentionally drops sensitive credentials per
//! ADR 0004 / ISS-214 §5).
//!
//! Two independent slots, both under service `forge-beta`:
//!   - `device-token` — pair credential, set once at device-pair time
//!   - `user-jwt`     — Forge user JWT, set/cleared on login/logout
//!
//! Service name was renamed from `forge-dev` to coexist with the legacy
//! Forge stable binary which still uses the `forge-dev` keychain entry.
//! On Linux without a keychain backend (`NoStorageAccess`), the caller should
//! treat it as "not paired" / "not logged in" — never fall back to a
//! plaintext file (AC §5).

use keyring::Entry;

const SERVICE: &str = "forge-beta";
const DEVICE_ACCOUNT: &str = "device-token";
const JWT_ACCOUNT: &str = "user-jwt";

fn device_entry() -> Result<Entry, String> {
    Entry::new(SERVICE, DEVICE_ACCOUNT).map_err(|e| format!("keychain entry: {e}"))
}

fn jwt_entry() -> Result<Entry, String> {
    Entry::new(SERVICE, JWT_ACCOUNT).map_err(|e| format!("keychain entry: {e}"))
}

fn store_at(entry: &Entry, token: &str) -> Result<(), String> {
    entry.set_password(token).map_err(|e| format!("keychain store: {e}"))
}

fn load_at(entry: &Entry) -> Result<Option<String>, String> {
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain load: {e}")),
    }
}

fn clear_at(entry: &Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain clear: {e}")),
    }
}

// === Device token ===
pub fn store(token: &str) -> Result<(), String> { store_at(&device_entry()?, token) }
pub fn load() -> Result<Option<String>, String> { load_at(&device_entry()?) }
pub fn clear() -> Result<(), String> { clear_at(&device_entry()?) }

// === User JWT ===
pub fn store_jwt(token: &str) -> Result<(), String> { store_at(&jwt_entry()?, token) }
pub fn load_jwt() -> Result<Option<String>, String> { load_at(&jwt_entry()?) }
pub fn clear_jwt() -> Result<(), String> { clear_at(&jwt_entry()?) }

#[cfg(test)]
mod tests {
    use super::*;

    // These tests hit the real OS keychain, so they're only meaningful on
    // developer workstations. CI environments without a keychain backend
    // should skip.
    #[test]
    #[ignore]
    fn round_trip() {
        let _ = clear();
        assert!(matches!(load(), Ok(None)));
        store("test-token").unwrap();
        assert_eq!(load().unwrap().as_deref(), Some("test-token"));
        clear().unwrap();
        assert!(matches!(load(), Ok(None)));
    }
}
