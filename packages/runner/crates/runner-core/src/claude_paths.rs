//! Where Claude Code keeps a session's transcript: `<config dir>/projects/<dir name>/<id>.jsonl`,
//! the directory named from the session's working directory. Read by the box to carry a master's
//! session (`runner-daemon` `master::inherit`) and to tail a channel agent's pane (ISS-946).

/// The directory Claude Code names for a project run in `cwd`: each UTF-16
/// unit of the path that is not an ASCII letter or digit becomes `-`, and a
/// name past 200 units is cut there and followed by a hash of the whole path.
/// A drive's `:` and `\` are replaced like any other, so on Windows the name
/// is one component and never an absolute path that `join` would put in place
/// of the home it is under.
pub fn project_dir_name(cwd: &std::path::Path) -> String {
    const CAP: usize = 200;
    let path = cwd.to_string_lossy();
    let units: Vec<u16> = path.encode_utf16().collect();
    let name: String = units
        .iter()
        .map(|&u| match u8::try_from(u) {
            Ok(b) if b.is_ascii_alphanumeric() => char::from(b),
            _ => '-',
        })
        .collect();
    if name.len() <= CAP {
        return name;
    }
    let hash = units.iter().fold(0i32, |h, &u| {
        h.wrapping_shl(5).wrapping_sub(h).wrapping_add(i32::from(u))
    });
    format!(
        "{}-{}",
        &name[..CAP],
        base36(i64::from(hash).unsigned_abs())
    )
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).expect("base-36 digits are ASCII")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_working_directory_becomes_the_name_claude_code_gives_its_project() {
        // measured on 2.1.319: a session run in this directory wrote its transcript under this name
        assert_eq!(
            project_dir_name(std::path::Path::new(
                "/home/dev/forge-local-docs/master-briefs/iss946/run1/p1cwd"
            )),
            "-home-dev-forge-local-docs-master-briefs-iss946-run1-p1cwd"
        );
    }
}
