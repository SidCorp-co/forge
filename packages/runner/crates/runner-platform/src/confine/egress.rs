//! A confined process's only way off the box: a proxy outside its sandbox that opens a
//! connection to a host it names only when that host is on the list it was started with.
//!
//! The sandbox has a network namespace of its own, holding nothing but loopback, so no
//! connection, DNS lookup or abstract socket of the box is reachable from it. One unix socket is
//! bound in from outside, and a bridge inside — `forge-runner egress-bridge`, the parent of the
//! sandboxed program — listens on loopback at [`BRIDGE_PORT`] and forwards each connection to
//! it. The environment names that port as the HTTP(S) proxy, so a client that honours the
//! proxy variables reaches the list's hosts, and one that does not reaches nothing.
//!
//! The proxy speaks `CONNECT host:port` and absolute-form plain HTTP, answers a host off the
//! list `403` naming [`REFUSAL`], and where this box itself reaches the network through a proxy
//! it chains through that one.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

/// The loopback port the bridge listens on, inside the sandbox's own network namespace, where
/// nothing else listens.
pub const BRIDGE_PORT: u16 = 3128;

/// The `forge-runner` subcommand that runs the bridge.
pub const BRIDGE_SUBCOMMAND: &str = "egress-bridge";

/// What a refused connection's answer and the runner's log line are named.
pub const REFUSAL: &str = "CHAT_EGRESS_REFUSED";

/// A host and port a confined process may connect to.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Host {
    /// Lowercase, without brackets for an IPv6 literal.
    pub name: String,
    pub port: u16,
}

impl std::fmt::Display for Host {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.name.contains(':') {
            write!(f, "[{}]:{}", self.name, self.port)
        } else {
            write!(f, "{}:{}", self.name, self.port)
        }
    }
}

impl Host {
    /// `host`, `host:port`, `[v6]:port` or a URL. A URL's port defaults by its scheme
    /// (`https` 443, `http` 80); a bare host's is 443.
    pub fn parse(entry: &str) -> Result<Self, String> {
        let entry = entry.trim();
        let (authority, default_port) = match entry.split_once("://") {
            Some((scheme, rest)) => {
                let port = match scheme.to_ascii_lowercase().as_str() {
                    "https" | "wss" => 443,
                    "http" | "ws" => 80,
                    other => {
                        return Err(format!(
                            "`{entry}` is a {other}:// URL; a host is reached over http or https"
                        ))
                    }
                };
                let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
                let authority = &rest[..end];
                (
                    authority.rsplit_once('@').map_or(authority, |(_, h)| h),
                    port,
                )
            }
            None => (entry, 443),
        };
        let (name, port) = split_port(authority)
            .ok_or_else(|| format!("`{entry}` names no host, or a port that is not a number"))?;
        let name = name.trim_end_matches('.').to_ascii_lowercase();
        if name.is_empty() || name.chars().any(|c| c.is_whitespace() || c == '/') {
            return Err(format!("`{entry}` names no host"));
        }
        Ok(Self {
            name,
            port: port.unwrap_or(default_port),
        })
    }
}

/// `name` and its port, if one is written; `None` where the port is not a number.
fn split_port(authority: &str) -> Option<(&str, Option<u16>)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (name, tail) = rest.split_once(']')?;
        return match tail.strip_prefix(':') {
            Some(port) => Some((name, Some(port.parse().ok()?))),
            None if tail.is_empty() => Some((name, None)),
            None => None,
        };
    }
    match authority.rsplit_once(':') {
        Some((name, port)) => Some((name, Some(port.parse().ok()?))),
        None => Some((authority, None)),
    }
}

/// The upstream proxy this box itself reaches the network through, read from its environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upstream {
    pub proxy: Host,
    /// `NO_PROXY` entries: a host they name, or a host under a domain they name, is connected
    /// to directly. `*` names every host.
    pub bypass: Vec<String>,
}

impl Upstream {
    /// `HTTPS_PROXY`, else `HTTP_PROXY` (either case), as `var` reads them; `None` where neither
    /// is set. A proxy reached other than over plain `http://` is refused by name: the chain
    /// speaks only that.
    pub fn from_env(var: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        let read = |names: &[&str]| {
            names
                .iter()
                .find_map(|n| var(n).filter(|v| !v.trim().is_empty()))
        };
        let Some(url) = read(&["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) else {
            return Ok(None);
        };
        let url = url.trim();
        let plain = url.contains("://").then(|| url.to_ascii_lowercase());
        if plain.as_deref().is_some_and(|u| !u.starts_with("http://")) {
            return Err(format!(
                "this box reaches the network through the proxy `{url}`, and a confined chat \
                 session's egress chains only through a plain http:// proxy"
            ));
        }
        let proxy = Host::parse(&if plain.is_some() {
            url.to_string()
        } else {
            format!("http://{url}")
        })?;
        let bypass = read(&["NO_PROXY", "no_proxy"])
            .unwrap_or_default()
            .split(',')
            .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
            .filter(|e| !e.is_empty())
            .collect();
        Ok(Some(Self { proxy, bypass }))
    }

    /// Whether `host` is connected to directly rather than through the upstream proxy.
    pub fn bypasses(&self, host: &str) -> bool {
        self.bypass.iter().any(|b| {
            let b = b.split(':').next().unwrap_or(b);
            b == "*" || host == b || host.ends_with(&format!(".{b}"))
        })
    }
}

/// Where a sandbox's egress runs: the socket the proxy listens on outside, bound into the
/// sandbox, and the binary whose [`BRIDGE_SUBCOMMAND`] runs the bridge inside.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Egress {
    pub socket: PathBuf,
    pub bridge: PathBuf,
}

impl Egress {
    /// The proxy a sandboxed client is pointed at.
    pub fn proxy_url() -> String {
        format!("http://127.0.0.1:{BRIDGE_PORT}")
    }

    /// The proxy variables a sandboxed process holds, every spelling of each, replacing whatever
    /// the box's own were. Loopback stays direct: inside the sandbox it is the sandbox's own.
    pub fn env() -> Vec<(OsString, OsString)> {
        let url = Self::proxy_url();
        let mut out = Vec::new();
        for name in ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"] {
            out.push((name.into(), url.clone().into()));
            out.push((name.to_ascii_lowercase().into(), url.clone().into()));
        }
        for name in ["NO_PROXY", "no_proxy"] {
            out.push((name.into(), "localhost,127.0.0.1,::1".into()));
        }
        out
    }

    /// The program the sandbox runs in place of `program args`: the bridge, which runs them.
    pub fn wrap(&self, program: &OsStr, args: &[String]) -> (OsString, Vec<OsString>) {
        let mut wrapped: Vec<OsString> = vec![
            BRIDGE_SUBCOMMAND.into(),
            "--socket".into(),
            self.socket.as_os_str().to_os_string(),
            "--".into(),
            program.to_os_string(),
        ];
        wrapped.extend(args.iter().map(OsString::from));
        (self.bridge.as_os_str().to_os_string(), wrapped)
    }

    /// Whether `name` is one of the proxy variables [`Egress::env`] sets.
    pub fn sets(name: &OsStr) -> bool {
        Self::env().iter().any(|(k, _)| k == name)
    }
}

#[cfg(target_os = "linux")]
mod serve;
#[cfg(target_os = "linux")]
pub use serve::{bridge, Proxy};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_is_read_from_a_url_a_host_and_port_or_a_bare_host() {
        let host = |s: &str| Host::parse(s).map(|h| h.to_string());
        assert_eq!(
            host("https://API.anthropic.com").unwrap(),
            "api.anthropic.com:443"
        );
        assert_eq!(
            host("http://core.local:8080/mcp?x=1").unwrap(),
            "core.local:8080"
        );
        assert_eq!(host("http://user:pw@proxy:3128").unwrap(), "proxy:3128");
        assert_eq!(host("example.com").unwrap(), "example.com:443");
        assert_eq!(host("example.com:22").unwrap(), "example.com:22");
        assert_eq!(host("[::1]:9").unwrap(), "[::1]:9");
        assert_eq!(host("http://[::1]").unwrap(), "[::1]:80");
    }

    #[test]
    fn an_entry_naming_no_host_or_another_scheme_is_refused_by_name() {
        for bad in [
            "",
            "https://",
            "host:port",
            "ftp://example.com",
            "[::1",
            "a b",
        ] {
            let err = Host::parse(bad).expect_err(bad);
            assert!(err.contains(bad.trim()) || bad.is_empty(), "{bad}: {err}");
        }
    }

    #[test]
    fn the_boxs_own_proxy_is_chained_and_a_proxy_the_chain_cannot_speak_is_refused() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| (*v).to_string())
            }
        };
        assert_eq!(Upstream::from_env(env(&[])).unwrap(), None);
        let up = Upstream::from_env(env(&[
            ("https_proxy", "http://corp:3128"),
            ("NO_PROXY", "internal.example, .lan"),
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(up.proxy.to_string(), "corp:3128");
        assert!(up.bypasses("internal.example") && up.bypasses("box.lan"));
        assert!(!up.bypasses("api.anthropic.com"));
        let err = Upstream::from_env(env(&[("HTTPS_PROXY", "socks5://corp:1080")])).unwrap_err();
        assert!(err.contains("socks5://corp:1080"), "{err}");
    }

    #[test]
    fn the_bridge_runs_the_program_and_the_proxy_variables_name_it_in_every_spelling() {
        let egress = Egress {
            socket: "/s/egress.sock".into(),
            bridge: "/bin/forge-runner".into(),
        };
        let (program, args) = egress.wrap(OsStr::new("claude"), &["-p".into()]);
        assert_eq!(program, "/bin/forge-runner");
        let args: Vec<_> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                BRIDGE_SUBCOMMAND,
                "--socket",
                "/s/egress.sock",
                "--",
                "claude",
                "-p"
            ]
        );
        for name in [
            "HTTPS_PROXY",
            "https_proxy",
            "HTTP_PROXY",
            "http_proxy",
            "ALL_PROXY",
        ] {
            assert!(Egress::sets(OsStr::new(name)), "{name} is not set");
        }
    }
}
