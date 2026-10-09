//! Whether a dev server listens beyond loopback (BC-5). The box asks for loopback (`HOST`), but a
//! framework may not read it — `next dev` binds every address unless given `--hostname` — and a
//! person's own command may bind anything. A server reachable on the box's other addresses could be
//! opened by anyone who can reach the box, without Forge, so the box reads the kernel's listening
//! sockets once the server answers and refuses one that listens anywhere else.

/// The first address other than loopback a socket listens on at `port`, as `addr:port`; `None`
/// where every listener is on loopback, or the platform gives no table to read.
pub fn beyond_loopback(port: u16) -> Option<String> {
    listeners(port)
        .into_iter()
        .find(|a| !is_loopback(a))
        .map(|a| match a.contains(':') {
            true => format!("[{a}]:{port}"),
            false => format!("{a}:{port}"),
        })
}

fn is_loopback(addr: &str) -> bool {
    addr.starts_with("127.")
        || addr == "::1"
        || addr.starts_with("::ffff:127.")
        || addr == "localhost"
}

/// The local addresses with a socket listening on `port`.
#[cfg(target_os = "linux")]
fn listeners(port: u16) -> Vec<String> {
    let mut out = Vec::new();
    for (table, v6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
        let Ok(text) = std::fs::read_to_string(table) else {
            continue;
        };
        out.extend(
            text.lines()
                .skip(1)
                .filter_map(|l| listening_on(l, port, v6)),
        );
    }
    out
}

/// One row of `/proc/net/tcp{,6}`: `sl local_address rem_address st …`, the address in hex as the
/// kernel stores it (each 32-bit word little-endian), `st` `0A` for LISTEN.
#[cfg(any(target_os = "linux", test))]
fn listening_on(row: &str, port: u16, v6: bool) -> Option<String> {
    let mut cols = row.split_whitespace();
    let local = cols.nth(1)?;
    let state = cols.nth(1)?;
    if state != "0A" {
        return None;
    }
    let (addr, p) = local.split_once(':')?;
    if u16::from_str_radix(p, 16).ok()? != port {
        return None;
    }
    let words: Vec<u32> = (0..addr.len() / 8)
        .map(|i| u32::from_str_radix(&addr[i * 8..i * 8 + 8], 16).map(u32::swap_bytes))
        .collect::<Result<_, _>>()
        .ok()?;
    if !v6 {
        return Some(std::net::Ipv4Addr::from(*words.first()?).to_string());
    }
    let mut octets = [0u8; 16];
    for (i, w) in words.iter().enumerate().take(4) {
        octets[i * 4..i * 4 + 4].copy_from_slice(&w.to_be_bytes());
    }
    Some(std::net::Ipv6Addr::from(octets).to_string())
}

/// macOS and the BSDs: `lsof`'s listening sockets on the port, `n<addr>:<port>` per row.
#[cfg(all(unix, not(target_os = "linux")))]
fn listeners(port: u16) -> Vec<String> {
    let Ok(out) = std::process::Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fn"])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.strip_prefix('n'))
        .filter_map(|a| {
            a.rsplit_once(':')
                .map(|(h, _)| h.trim_matches(['[', ']']).to_string())
        })
        .map(|h| if h == "*" { "0.0.0.0".into() } else { h })
        .collect()
}

#[cfg(not(unix))]
fn listeners(_port: u16) -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests;
