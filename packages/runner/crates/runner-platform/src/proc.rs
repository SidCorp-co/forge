//! Process facts this platform can read about a pid.

#[cfg(target_os = "linux")]
pub fn start_ticks(pid: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command sits in parens and may hold spaces and parens of its own, so
    // the fields are counted from the last `)` rather than from the start.
    let mut fields = stat.rsplit_once(") ")?.1.split(' ');
    if fields.next()? == "Z" {
        return None;
    }
    fields.nth(18).map(str::to_string)
}

#[cfg(not(target_os = "linux"))]
pub fn start_ticks(_pid: u32) -> Option<String> {
    None
}

#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    use nix::errno::Errno;
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    let Ok(raw) = i32::try_from(pid) else {
        return false;
    };
    !matches!(kill(Pid::from_raw(raw), None), Err(Errno::ESRCH))
}

#[cfg(not(unix))]
pub fn pid_alive(_pid: u32) -> bool {
    false
}
