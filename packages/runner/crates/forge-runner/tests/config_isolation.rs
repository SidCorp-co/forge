//! The forge-runner crate's tests link `forge-runner-core` with `test-support`
//! rather than `cfg(test)`, and the refusal to write under a config dir that is
//! not a test's own scratch has to hold here too (ISS-1344).
//!
//! One test in its own process, because it moves `XDG_CONFIG_HOME`.

use forge_runner_core::daemon::{control, pool_reads};
use forge_runner_core::test_scratch::Scratch;

#[test]
fn this_crates_tests_write_under_no_config_dir_but_their_own_scratch() {
    let users_own = if cfg!(windows) {
        r"C:\iss-1344-nobody\AppData\Roaming"
    } else {
        "/iss-1344-nobody/.config"
    };
    std::env::set_var("XDG_CONFIG_HOME", users_own);
    assert_eq!(control::config_dir(), None, "no dir for pool-reads.json");
    assert!(forge_runner_core::config::base_dir().is_err());

    let own = Scratch::new("config-isolation");
    std::env::set_var("XDG_CONFIG_HOME", own.path());
    let dir = control::config_dir().expect("a test's own scratch");
    assert_eq!(dir, own.path().join("forge-runner"));
    assert_eq!(pool_reads::path(&dir).parent(), Some(dir.as_path()));
}
