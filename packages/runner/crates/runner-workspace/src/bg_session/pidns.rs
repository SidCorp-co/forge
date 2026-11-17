//! A session record's process, wherever its pid namespace is (ISS-1268 BR).
//!
//! A room agent's session runs in its room's sandbox, which has a pid namespace of its own, so the
//! `pid` its record names is that namespace's, not this box's. Claude Code writes the namespace
//! beside it, `pidDomain` (`linux:<boot>:pid:[<inode>]`, measured on 2.1.322). A record in another
//! namespace is read through the process on this box whose `ns/pid` is that one and whose
//! innermost `NSpid` is the record's pid; `procStart` is the start time since boot, the same from
//! any namespace.

/// The `pid:[<inode>]` a record's `pidDomain` names, if it names one.
pub fn ns_of(domain: &str) -> Option<&str> {
    domain.rfind("pid:[").map(|at| &domain[at..])
}

/// This process's own pid namespace, as `/proc/self/ns/pid` reads.
#[cfg(target_os = "linux")]
fn own_ns() -> Option<String> {
    std::fs::read_link("/proc/self/ns/pid")
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// The pid on this box of the process `pid` in the namespace `domain` names: `pid` itself where
/// the namespace is this box's or none is named, `None` where no such process runs.
pub fn host_pid(pid: u32, domain: Option<&str>) -> Option<u32> {
    #[cfg(target_os = "linux")]
    {
        let Some(ns) = domain.and_then(ns_of) else {
            return Some(pid);
        };
        if own_ns().as_deref() == Some(ns) {
            return Some(pid);
        }
        std::fs::read_dir("/proc")
            .ok()?
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
            .find(|host| in_ns_as(*host, ns, pid))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = domain;
        Some(pid)
    }
}

/// Whether the process `host` runs in the namespace `ns` as `pid`.
#[cfg(target_os = "linux")]
fn in_ns_as(host: u32, ns: &str, pid: u32) -> bool {
    let link = std::fs::read_link(format!("/proc/{host}/ns/pid"));
    if !link.is_ok_and(|l| l.to_string_lossy() == ns) {
        return false;
    }
    std::fs::read_to_string(format!("/proc/{host}/status"))
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("NSpid:"))
                .and_then(|l| l.split_whitespace().last()?.parse::<u32>().ok())
        })
        == Some(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_domain_names_its_namespace_and_a_record_in_this_one_is_its_own_pid() {
        assert_eq!(
            ns_of("linux:febb66d7:pid:[4026534844]"),
            Some("pid:[4026534844]")
        );
        assert_eq!(ns_of("darwin"), None);
        let me = std::process::id();
        assert_eq!(host_pid(me, None), Some(me));
        #[cfg(target_os = "linux")]
        {
            let own = own_ns().unwrap();
            assert_eq!(host_pid(me, Some(&format!("linux:x:{own}"))), Some(me));
            assert_eq!(host_pid(me, Some("linux:x:pid:[1]")), None);
        }
    }
}
