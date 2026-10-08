//! This build's probation as the daemon serves it (ISS-1378): say at start what a probation put
//! back, and end this build's own probation once it has stayed up for its period.

/// Say what a probation holds back, and confirm this build's own probation
/// once it has stayed up for its period (ISS-1378).
pub(crate) fn serve() {
    say_what_is_held_back();
    tokio::spawn(async {
        tokio::time::sleep(runner_update::probation::PERIOD).await;
        confirm();
    });
}

/// End the probation of the build this process serves, which has stayed up.
fn confirm() {
    let exe = match runner_platform::exe::own() {
        Ok(own) => own.path,
        Err(e) => {
            tracing::warn!("[update] this build's probation cannot be confirmed: {e}");
            return;
        }
    };
    match runner_update::probation::confirm(&exe, runner_update::CURRENT_VERSION) {
        Ok(true) => tracing::info!(
            "[update] {} has served {}s and is confirmed: its probation is over",
            runner_update::CURRENT_VERSION,
            runner_update::probation::PERIOD.as_secs()
        ),
        Ok(false) => {}
        Err(e) => tracing::warn!(
            "[update] the probation of {} at {} could not be ended ({e}); a later restart counts against it as though this one had not stayed up",
            runner_update::CURRENT_VERSION,
            runner_update::probation::path(&exe).display()
        ),
    }
}

/// Say, from this process's first moment, a release a probation put back from
/// the build it serves: the first update check is half a minute away.
fn say_what_is_held_back() {
    let exe = match runner_platform::exe::own() {
        Ok(own) => own.path,
        Err(e) => {
            tracing::warn!("[update] whether a release is held back cannot be read: {e}");
            return;
        }
    };
    match runner_update::probation::rejected(&exe) {
        Ok(Some(r)) => tracing::warn!("[update] {} is held back: {}", r.version, r.why(&exe)),
        Ok(None) => {}
        Err(why) => tracing::warn!(
            "[update] the record of a release a probation put back is unreadable, so no update is installed until it is: {why}"
        ),
    }
}
