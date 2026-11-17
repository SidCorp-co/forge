//! The device's headroom for boxes, measured on every heartbeat (`boxHealthReportSchema`):
//! available memory against the reserve, CPU pressure against the ceiling, disk against its
//! reserve, whether KVM is usable, the modes this device serves, and the boxes it holds. The
//! runner measures and reports; it holds no maximum, and core decides what starts.

use std::path::{Path, PathBuf};

use runner_platform::box_settings::BoxSettings;
use serde_json::{json, Value};

use crate::modes::{self, ModeReport};

/// Where the measurements are read from: `/proc` and `/dev/kvm` on a real host.
#[derive(Debug, Clone)]
pub struct Probe {
    pub proc_root: PathBuf,
    pub kvm: PathBuf,
    /// The filesystem the boxes write recordings to.
    pub disk_at: PathBuf,
}

impl Probe {
    pub fn of_host(data_dir: &Path) -> Self {
        Self {
            proc_root: PathBuf::from("/proc"),
            kvm: PathBuf::from("/dev/kvm"),
            disk_at: data_dir.to_path_buf(),
        }
    }
}

/// One measurement, or the reason none could be taken.
pub fn measure(
    probe: &Probe,
    s: &BoxSettings,
    modes: &[ModeReport],
    held: &[String],
) -> Result<Value, String> {
    let meminfo = std::fs::read_to_string(probe.proc_root.join("meminfo"))
        .map_err(|e| format!("cannot read {}/meminfo: {e}", probe.proc_root.display()))?;
    let available_kb = field_kb(&meminfo, "MemAvailable:").ok_or_else(|| {
        "meminfo names no MemAvailable, so this device's free memory is not measured".to_string()
    })?;
    let psi_path = probe.proc_root.join("pressure").join("cpu");
    let psi = std::fs::read_to_string(&psi_path).map_err(|e| {
        format!(
            "cannot read {} ({e}): this kernel reports no CPU pressure, which boxes are allocated on",
            psi_path.display()
        )
    })?;
    let some_avg10 = psi_some_avg10(&psi)
        .ok_or_else(|| format!("{} names no `some avg10=`", psi_path.display()))?;
    let free_mb = disk_free_mb(&probe.disk_at)?;
    Ok(json!({
        "memory": { "availableMb": available_kb / 1024, "reserveMb": s.memory_reserve_mb },
        "cpu": {
            "pressureSomeAvg10": some_avg10.clamp(0.0, 100.0),
            "ceiling": s.cpu_pressure_ceiling.clamp(0.0, 100.0),
        },
        "disk": { "freeMb": free_mb, "reserveMb": s.disk_reserve_mb },
        "kvm": modes::kvm_writable(&probe.kvm),
        "modes": modes,
        "held": held,
    }))
}

fn field_kb(meminfo: &str, name: &str) -> Option<u64> {
    meminfo
        .lines()
        .find_map(|l| l.strip_prefix(name))?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

fn psi_some_avg10(psi: &str) -> Option<f64> {
    psi.lines()
        .find(|l| l.starts_with("some "))?
        .split_whitespace()
        .find_map(|kv| kv.strip_prefix("avg10="))?
        .parse()
        .ok()
}

/// Free space for this user on the filesystem holding `at`, or its nearest existing ancestor.
#[cfg(unix)]
fn disk_free_mb(at: &Path) -> Result<u64, String> {
    let existing = at
        .ancestors()
        .find(|p| p.exists())
        .ok_or_else(|| format!("no existing directory above {}", at.display()))?;
    let st = nix::sys::statvfs::statvfs(existing)
        .map_err(|e| format!("statvfs {}: {e}", existing.display()))?;
    Ok(st.blocks_available() as u64 * st.fragment_size() as u64 / (1024 * 1024))
}

#[cfg(not(unix))]
fn disk_free_mb(at: &Path) -> Result<u64, String> {
    Err(format!(
        "no disk measurement on this platform for {}",
        at.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Scratch;

    fn plant(root: &Scratch, meminfo: &str, psi: &str) -> Probe {
        std::fs::create_dir_all(root.path().join("proc/pressure")).unwrap();
        std::fs::write(root.path().join("proc/meminfo"), meminfo).unwrap();
        std::fs::write(root.path().join("proc/pressure/cpu"), psi).unwrap();
        Probe {
            proc_root: root.path().join("proc"),
            kvm: root.path().join("kvm"),
            disk_at: root.path().join("not-yet/made"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_heartbeat_reports_health_from_what_it_measured() {
        let root = Scratch::new("health");
        let probe = plant(
            &root,
            "MemTotal:       126000000 kB\nMemFree:         2000000 kB\nMemAvailable:   12582912 kB\n",
            "some avg10=72.50 avg60=40.00 avg300=1.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
        );
        std::fs::write(&probe.kvm, b"").unwrap();
        let s = BoxSettings::default();
        let modes = vec![modes::ios()];
        let held = vec!["0b8e7a52-3c4d-4e6f-8a1b-2c3d4e5f6a7b".to_string()];
        let h = measure(&probe, &s, &modes, &held).expect("measured");
        assert_eq!(
            h["memory"],
            json!({ "availableMb": 12288, "reserveMb": 16384 })
        );
        assert_eq!(h["cpu"]["pressureSomeAvg10"], json!(72.5));
        assert_eq!(h["cpu"]["ceiling"], json!(60.0));
        assert_eq!(h["disk"]["reserveMb"], json!(20480));
        assert!(h["disk"]["freeMb"].as_u64().unwrap() > 0, "{h}");
        assert_eq!(h["kvm"], json!(true), "a writable /dev/kvm stand-in");
        assert_eq!(h["held"], json!(held));
        assert_eq!(h["modes"][0]["mode"], json!("ios"));
        assert_eq!(h["modes"][0]["serves"], json!(false));
        assert!(
            h.get("max").is_none() && h.get("slots").is_none(),
            "the runner holds no maximum"
        );

        std::fs::remove_file(&probe.kvm).unwrap();
        assert_eq!(
            measure(&probe, &s, &modes, &held).unwrap()["kvm"],
            json!(false)
        );
    }

    #[test]
    fn a_kernel_without_pressure_or_memavailable_is_no_measurement_said_by_name() {
        let root = Scratch::new("health");
        let probe = plant(&root, "MemTotal: 1 kB\n", "some avg10=1.0\n");
        let err = measure(&probe, &BoxSettings::default(), &[], &[]).unwrap_err();
        assert!(err.contains("MemAvailable"), "{err}");
        let probe = plant(&root, "MemAvailable: 1024 kB\n", "full avg10=1.0\n");
        let err = measure(&probe, &BoxSettings::default(), &[], &[]).unwrap_err();
        assert!(err.contains("some avg10"), "{err}");
    }
}
