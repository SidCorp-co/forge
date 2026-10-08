//! One computation core handed this box (REQ-32 BC-14): a python or bash script over
//! `inputs.json`, run in a sandbox of its own and answered with what it wrote.
//!
//! The box only runs it (ADR 0009). Core chose this box, set the limits and reads the output as
//! frames; here the script gets a throwaway working directory holding its script and inputs, a
//! read-only view of the system with this user's home, temp and runtime trees emptied, a network
//! namespace with nothing but loopback, an environment built from a list, and caps: the wall
//! limit (the whole process group is killed at it), address space (`memoryMb`), CPU time (`cpu`
//! cores for the wall limit) and the size of any one file it writes. `frames.json` or
//! `frames.csv` is read back as text without following a link, and the directory is removed.

// Only Linux confines a script; elsewhere `run` refuses by name, and the pieces it would use sit idle.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Where an interpreter is looked for: the system's own directories, which the sandbox keeps.
pub const SYSTEM_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

/// The files a script hands its frames back in, in the order core reads them.
pub const OUTPUT_FILES: [&str; 2] = ["frames.json", "frames.csv"];

/// Each of stdout and stderr is kept to this many bytes; core keeps less.
const LOG_CAP: usize = 64 * 1024;

/// The most a request may ask for here; core asks for less, and past these it is refused by name.
const MAX_WALL_MS: u64 = 120_000;
const MAX_MEMORY_MB: u64 = 4096;
const MAX_CPU: f64 = 8.0;
const MAX_OUTPUT_BYTES: u64 = 8_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Python,
    Bash,
}

impl Language {
    fn interpreter(self) -> &'static str {
        match self {
            Self::Python => "python3",
            Self::Bash => "bash",
        }
    }

    fn script_file(self) -> &'static str {
        match self {
            Self::Python => "script.py",
            Self::Bash => "script.sh",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Python => "python",
            Self::Bash => "bash",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub wall_ms: u64,
    pub cpu: f64,
    pub memory_mb: u64,
    pub output_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub language: Language,
    pub script: String,
    pub inputs: serde_json::Value,
    pub limits: Limits,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Output {
    pub file: &'static str,
    pub text: String,
}

/// What ran: its exit, how long, the limit that stopped it, what it wrote and said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub exit: i32,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Output>,
    pub stdout: String,
    pub stderr: String,
}

/// The languages this box's sandbox can run: each needs its interpreter in [`SYSTEM_PATH`], and
/// both need `bash`, which sets the caps.
pub fn languages() -> Vec<&'static str> {
    if resolve("bash").is_none() {
        return Vec::new();
    }
    [Language::Bash, Language::Python]
        .into_iter()
        .filter(|l| resolve(l.interpreter()).is_some())
        .map(Language::name)
        .collect()
}

fn resolve(program: &str) -> Option<PathBuf> {
    which::which_in(program, Some(SYSTEM_PATH), "/").ok()
}

/// Why a request is outside what this box runs, or `None`.
fn refused(request: &Request) -> Option<String> {
    let l = &request.limits;
    if l.wall_ms == 0 || l.wall_ms > MAX_WALL_MS {
        return Some(format!(
            "limits.wallMs {} is outside 1..={MAX_WALL_MS}",
            l.wall_ms
        ));
    }
    if l.memory_mb < 16 || l.memory_mb > MAX_MEMORY_MB {
        return Some(format!(
            "limits.memoryMb {} is outside 16..={MAX_MEMORY_MB}",
            l.memory_mb
        ));
    }
    if !(l.cpu >= 0.1 && l.cpu <= MAX_CPU) {
        return Some(format!("limits.cpu {} is outside 0.1..={MAX_CPU}", l.cpu));
    }
    if l.output_bytes == 0 || l.output_bytes > MAX_OUTPUT_BYTES {
        return Some(format!(
            "limits.outputBytes {} is outside 1..={MAX_OUTPUT_BYTES}",
            l.output_bytes
        ));
    }
    if !request.inputs.is_array() {
        return Some("inputs is not an array of frames".into());
    }
    None
}

/// The largest output file read back, and the largest file the script may write at all.
fn output_cap(limits: &Limits) -> u64 {
    limits
        .output_bytes
        .saturating_mul(4)
        .saturating_add(64 * 1024)
}

/// CPU seconds the script may use: its cores for the whole wall limit, at least one.
fn cpu_seconds(limits: &Limits) -> u64 {
    // limits are checked first: wall_ms <= 120_000 and cpu <= 8, so this is at most 960
    let ms = (limits.wall_ms as f64) * limits.cpu;
    ((ms / 1000.0).ceil() as u64).max(1)
}

/// The shell line that sets the caps and then becomes the interpreter. `ulimit` sets the hard
/// limit too, so the script cannot raise one; CPU time's hard limit is a second past its soft
/// one, so the script is stopped by `SIGXCPU`, which names the cap, and not by the `SIGKILL` a
/// shared limit sends with it. A cap that cannot be set stops the run with the shell's own
/// message rather than running it without.
fn caps_line(limits: &Limits) -> String {
    let cpu = cpu_seconds(limits);
    format!(
        "ulimit -v {} && ulimit -S -t {cpu} && ulimit -H -t {} && ulimit -f {} && exec \"$@\"",
        limits.memory_mb * 1024,
        cpu + 1,
        output_cap(limits).div_ceil(1024)
    )
}

/// What a script's exit says about the limit that stopped it: a CPU-time or file-size signal.
fn stopped_by(exit: i32) -> Option<&'static str> {
    const SIGXCPU: i32 = 24;
    const SIGXFSZ: i32 = 25;
    match exit - 128 {
        SIGXCPU => Some("cpu"),
        SIGXFSZ => Some("outputBytes"),
        _ => None,
    }
}

/// Run `request` in a sandbox of its own. `Err` is why it could not be run at all, said so a
/// person can act on it; a script that ran and failed is an `Answer` with its exit and logs.
pub async fn run(request: &Request) -> Result<Answer, String> {
    if let Some(why) = refused(request) {
        return Err(format!("this box refuses the request: {why}"));
    }
    if let super::Availability::Unavailable(why) = super::availability() {
        return Err(format!("this box cannot confine a script: {why}"));
    }
    let bash = resolve("bash")
        .ok_or_else(|| format!("bash is not installed in {SYSTEM_PATH} on this box"))?;
    let interpreter = resolve(request.language.interpreter()).ok_or_else(|| {
        format!(
            "{} is not installed in {SYSTEM_PATH} on this box, so a {} script cannot run here",
            request.language.interpreter(),
            request.language.name()
        )
    })?;
    let dir = Workdir::create()?;
    let result = run_in(request, &bash, &interpreter, dir.path()).await;
    drop(dir);
    result
}

#[cfg(target_os = "linux")]
async fn run_in(
    request: &Request,
    bash: &Path,
    interpreter: &Path,
    dir: &Path,
) -> Result<Answer, String> {
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    let script = dir.join(request.language.script_file());
    std::fs::write(&script, &request.script)
        .map_err(|e| format!("the script could not be written to {}: {e}", dir.display()))?;
    let inputs = serde_json::to_vec(&request.inputs).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("inputs.json"), inputs)
        .map_err(|e| format!("inputs.json could not be written to {}: {e}", dir.display()))?;

    let sandbox = sandbox_for(dir);
    let args: Vec<String> = vec![
        "-c".into(),
        caps_line(&request.limits),
        "forge-compute".into(),
        interpreter.display().to_string(),
        request.language.script_file().into(),
    ];
    let mut cmd = sandbox
        .command(bash.as_os_str(), &args)
        .map_err(|e| e.to_string())?;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);

    let started = Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("bubblewrap could not be started: {e}"))?;
    let pid = child.id();
    let stdout = tokio::spawn(read_capped(child.stdout.take()));
    let stderr = tokio::spawn(read_capped(child.stderr.take()));
    let wall = Duration::from_millis(request.limits.wall_ms);
    let (status, timed_out) = match tokio::time::timeout(wall, child.wait()).await {
        Ok(status) => (status.map_err(|e| e.to_string())?, false),
        Err(_) => {
            if let Some(pid) = pid.and_then(|p| i32::try_from(p).ok()) {
                let _ = nix::sys::signal::killpg(
                    nix::unistd::Pid::from_raw(pid),
                    nix::sys::signal::Signal::SIGKILL,
                );
            }
            (child.wait().await.map_err(|e| e.to_string())?, true)
        }
    };
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let logs = |task: tokio::task::JoinHandle<String>| async move {
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default()
    };
    let (stdout, stderr) = (logs(stdout).await, logs(stderr).await);
    let exit = exit_code(status);
    let mut stopped = if timed_out {
        Some("wallMs")
    } else {
        stopped_by(exit)
    };
    let output = if stopped.is_some() {
        None
    } else {
        match read_output(dir, output_cap(&request.limits))? {
            Read::None => None,
            Read::Text(output) => Some(output),
            Read::TooLarge => {
                stopped = Some("outputBytes");
                None
            }
        }
    };
    Ok(Answer {
        exit,
        duration_ms,
        stopped,
        output,
        stdout,
        stderr,
    })
}

#[cfg(not(target_os = "linux"))]
async fn run_in(_: &Request, _: &Path, _: &Path, _: &Path) -> Result<Answer, String> {
    Err(format!(
        "a script is confined only on Linux, through bubblewrap, and this box runs {}",
        std::env::consts::OS
    ))
}

/// The sandbox one computation runs in: the box read-only, everything this user keeps emptied,
/// the working directory bound back writable, no network, and an environment from a list.
fn sandbox_for(dir: &Path) -> super::Sandbox {
    let home = std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map_or_else(|| PathBuf::from("/home"), PathBuf::from);
    let mut emptied =
        super::private_dirs(&home, &std::env::temp_dir(), |name| std::env::var_os(name));
    for other in ["/home", "/root", "/mnt", "/media", "/srv"] {
        let other = PathBuf::from(other);
        if other.is_dir() && !emptied.iter().any(|e| other.starts_with(e)) {
            emptied.retain(|e| !e.starts_with(&other));
            emptied.push(other);
        }
    }
    let mut mounts: Vec<super::Mount> = emptied.into_iter().map(super::Mount::Empty).collect();
    mounts.push(super::Mount::Write(dir.to_path_buf()));
    let env: Vec<(OsString, OsString)> = [
        ("PATH", SYSTEM_PATH),
        ("LANG", "C.UTF-8"),
        ("LC_ALL", "C.UTF-8"),
        ("PYTHONDONTWRITEBYTECODE", "1"),
        ("PYTHONUNBUFFERED", "1"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .chain([
        ("HOME".into(), dir.as_os_str().to_os_string()),
        ("TMPDIR".into(), dir.as_os_str().to_os_string()),
    ])
    .collect();
    super::Sandbox {
        mounts,
        env,
        cwd: dir.to_path_buf(),
        egress: None,
        offline: true,
    }
}

#[cfg(target_os = "linux")]
fn exit_code(status: std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

/// The first [`LOG_CAP`] bytes of a stream, then how much more was cut; the rest is drained so
/// the script never blocks on a full pipe.
async fn read_capped(stream: Option<impl tokio::io::AsyncRead + Unpin>) -> String {
    use tokio::io::AsyncReadExt;
    let Some(mut stream) = stream else {
        return String::new();
    };
    let mut kept: Vec<u8> = Vec::new();
    let mut cut: u64 = 0;
    let mut buf = [0u8; 8192];
    loop {
        match stream.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = LOG_CAP.saturating_sub(kept.len());
                let take = room.min(n);
                kept.extend_from_slice(&buf[..take]);
                cut += (n - take) as u64;
            }
        }
    }
    let mut text = String::from_utf8_lossy(&kept).into_owned();
    if cut > 0 {
        text.push_str(&format!("\n[forge-runner: {cut} more bytes cut]"));
    }
    text
}

enum Read {
    None,
    Text(Output),
    TooLarge,
}

/// The first output file the script wrote, as text. A link or anything but a plain file is
/// refused by name rather than followed: the runner reads it as this box's user, outside the
/// sandbox.
fn read_output(dir: &Path, cap: u64) -> Result<Read, String> {
    use std::io::Read as _;
    for file in OUTPUT_FILES {
        let path = dir.join(file);
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.file_type().is_file() {
            return Err(format!(
                "the script's {file} is not a plain file (a link, a directory or a pipe), so it was not read"
            ));
        }
        if meta.len() > cap {
            return Ok(Read::TooLarge);
        }
        let mut opened = open_no_follow(&path)
            .map_err(|e| format!("the script's {file} could not be opened: {e}"))?;
        let mut bytes = Vec::new();
        opened
            .by_ref()
            .take(cap + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("the script's {file} could not be read: {e}"))?;
        if bytes.len() as u64 > cap {
            return Ok(Read::TooLarge);
        }
        return Ok(Read::Text(Output {
            file,
            text: String::from_utf8_lossy(&bytes).into_owned(),
        }));
    }
    Ok(Read::None)
}

#[cfg(unix)]
fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::fcntl::OFlag::O_NOFOLLOW.bits() | nix::fcntl::OFlag::O_NONBLOCK.bits())
        .open(path)
}

#[cfg(not(unix))]
fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::open(path)
}

/// A working directory for one computation, readable by this user alone and removed when dropped,
/// whatever the script left in it.
struct Workdir(PathBuf);

impl Workdir {
    fn create() -> Result<Self, String> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let path = std::env::temp_dir().join(format!(
            "forge-compute-{}-{nanos}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        owner_only_dir().create(&path).map_err(|e| {
            format!(
                "a working directory could not be made at {}: {e}",
                path.display()
            )
        })?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Workdir {
    fn drop(&mut self) {
        if std::fs::remove_dir_all(&self.0).is_ok() {
            return;
        }
        // a script may have left a directory it took its own permissions from
        owner_writable(&self.0);
        if let Err(e) = std::fs::remove_dir_all(&self.0) {
            tracing::warn!(
                "[compute] the working directory {} could not be removed: {e}",
                self.0.display()
            );
        }
    }
}

#[cfg(unix)]
fn owner_only_dir() -> std::fs::DirBuilder {
    use std::os::unix::fs::DirBuilderExt;
    let mut builder = std::fs::DirBuilder::new();
    builder.mode(0o700);
    builder
}

#[cfg(not(unix))]
fn owner_only_dir() -> std::fs::DirBuilder {
    std::fs::DirBuilder::new()
}

/// Give this user back every directory under `dir`, never following a link.
fn owner_writable(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                owner_writable(&entry.path());
            }
        }
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(all(test, target_os = "linux"))]
#[path = "compute_tests.rs"]
mod tests;
