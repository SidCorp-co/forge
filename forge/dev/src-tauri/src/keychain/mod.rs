//! OS keychain integration for the device token.
//!
//! Service: `forge-beta`, account: `device-token`. One token per install.
//! Service name was renamed from `forge-dev` to coexist with the legacy
//! Forge stable binary which still uses the `forge-dev` keychain entry.
//! On Linux without a keychain backend (`NoStorageAccess`), the caller should
//! treat it as "not paired" — never fall back to a plaintext file (AC §5).

use keyring::Entry;

const SERVICE: &str = "forge-beta";
const ACCOUNT: &str = "device-token";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keychain entry: {e}"))
}

pub fn store(token: &str) -> Result<(), String> {
    entry()?.set_password(token).map_err(|e| format!("keychain store: {e}"))
}

pub fn load() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain load: {e}")),
    }
}

pub fn clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain clear: {e}")),
    }
}

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
