//! Doctor's rows for the plugins core designates for this box (REQ-26), read where core serves them
//! (`GET /api/devices/me/plugins`) rather than from config.toml alone: each plugin with its pin and
//! the projects asking for it, a pin conflict between those projects, and a marketplace the
//! operator registered themselves, whose designation the sweep therefore does not apply.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::Duration;

use runner_transport::plugins::{self, DesignatedPlugin};
use runner_transport::CoreClient;
use runner_workspace::plugin_sync;

/// The rows for the designated plugins; `true` where they could not be read. `local` is the
/// marketplace config.toml names, whose operator registration the local row already reports.
pub async fn rows(client: &CoreClient, timeout: Duration, local: Option<&str>) -> bool {
    match tokio::time::timeout(timeout, plugins::list_designated(client)).await {
        Ok(Ok(list)) => {
            let registered = |m: &str| {
                if local.is_some_and(|l| l.eq_ignore_ascii_case(m)) {
                    return None;
                }
                plugin_sync::operator_registration(m)
            };
            for line in designated_rows(&list, registered) {
                println!("{line}");
            }
            false
        }
        Ok(Err(e)) => {
            println!("✖ plugins      could not read the plugins core designates for this box: {e}");
            true
        }
        Err(_) => {
            println!(
                "✖ plugins      timeout after {}s reading the designated plugins",
                timeout.as_secs()
            );
            true
        }
    }
}

/// The row for `[plugins] checkout`: which directories this runner's panes load their plugins from
/// and which registered plugins they turn off, or the refusal the daemon starts with. `true` where
/// refused; nothing where no checkout is set.
pub async fn source_row(settings: &runner_platform::config::PluginSettings) -> bool {
    use runner_workspace::plugin_source;
    let launch = match plugin_source::resolve(settings).await {
        Ok(None) => return false,
        Ok(Some(source)) => {
            plugin_source::launch_for(Some(&source), plugin_sync::claude_config_dir().as_deref())
        }
        Err(why) => Err(why),
    };
    match launch {
        Ok(launch) => {
            let dirs: Vec<String> = launch
                .dirs
                .iter()
                .map(|d| d.display().to_string())
                .collect();
            let off = match launch.disabled.as_slice() {
                [] => String::from("no registered plugin of the same name"),
                ids => format!("{} turned off", ids.join(", ")),
            };
            println!("✔ plugins      panes load {} — {off}", dirs.join(", "));
            false
        }
        Err(why) => {
            println!("✖ plugins      {why}");
            true
        }
    }
}

/// A marketplace this box's operator registered to a directory of their own: the sweep installs
/// nothing from it, so neither config.toml nor a project's designation or pin is applied for it.
pub fn registered_row(marketplace: &str, path: &std::path::Path) -> String {
    format!(
        "⚠ plugins      {marketplace}: registered to {} by this box's operator, so the plugins and pins named for it are not applied here; jobs load what that directory holds",
        path.display()
    )
}

fn short(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

/// One row per designated plugin, then a warning per marketplace whose pins conflict or that the
/// operator registered themselves; pure over the served list and the registration read.
pub fn designated_rows(
    list: &[DesignatedPlugin],
    registered_by_operator: impl Fn(&str) -> Option<PathBuf>,
) -> Vec<String> {
    if list.is_empty() {
        return vec![String::from(
            "• plugins      no project this box serves designates a plugin",
        )];
    }
    let mut out = Vec::new();
    for d in list {
        let projects = d.projects.join(", ");
        let at = match (&d.pinned_ref, &d.pinned_ref_conflict) {
            (_, Some(_)) => String::from("no pin (conflict below)"),
            (Some(r), None) => format!("pinned {}", short(r)),
            (None, None) => String::from("latest"),
        };
        out.push(format!(
            "✔ plugins      {} @ {}: {at}, for {projects}",
            d.name, d.marketplace
        ));
    }
    let marketplaces: BTreeSet<&str> = list.iter().map(|d| d.marketplace.as_str()).collect();
    for m in marketplaces {
        let here: Vec<&DesignatedPlugin> = list.iter().filter(|d| d.marketplace == m).collect();
        if let Some(refs) = here.iter().find_map(|d| d.pinned_ref_conflict.as_ref()) {
            let refs: Vec<&str> = refs.iter().map(|r| short(r)).collect();
            let projects: BTreeSet<&str> = here
                .iter()
                .flat_map(|d| d.projects.iter().map(String::as_str))
                .collect();
            out.push(format!(
                "⚠ plugins      {m}: the projects this box serves ({}) pin it at {}; this box holds one clone of it, so it honours neither pin and follows latest — change one pin on that project's plugin settings",
                projects.into_iter().collect::<Vec<_>>().join(", "),
                refs.join(" and "),
            ));
        }
        if let Some(path) = registered_by_operator(m) {
            out.push(registered_row(m, &path));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn plugin(
        name: &str,
        pin: Option<&str>,
        conflict: Option<&[&str]>,
        projects: &[&str],
    ) -> DesignatedPlugin {
        DesignatedPlugin {
            marketplace: String::from("SidCorp-co/forge-plugin"),
            name: name.to_owned(),
            pinned_ref: pin.map(str::to_owned),
            projects: projects.iter().map(|p| (*p).to_owned()).collect(),
            pinned_ref_conflict: conflict.map(|c| c.iter().map(|r| (*r).to_owned()).collect()),
        }
    }

    fn none(_: &str) -> Option<PathBuf> {
        None
    }

    #[test]
    fn a_conflict_core_serves_is_a_warning_naming_both_pins_and_the_projects() {
        let list = [
            plugin("forge", None, Some(&[A, B]), &["alpha"]),
            plugin("forge-codemap", None, Some(&[A, B]), &["beta"]),
        ];
        let rows = designated_rows(&list, none);
        assert_eq!(rows.len(), 3, "{rows:#?}");
        assert!(
            rows[0].contains("forge @ SidCorp-co/forge-plugin: no pin (conflict below), for alpha")
        );
        let warn = &rows[2];
        assert!(
            warn.starts_with("⚠ plugins      SidCorp-co/forge-plugin:"),
            "{warn}"
        );
        assert!(
            warn.contains("(alpha, beta) pin it at aaaaaaa and bbbbbbb"),
            "{warn}"
        );
        assert!(warn.contains("honours neither pin"), "{warn}");
    }

    #[test]
    fn a_served_pin_is_named_and_no_conflict_is_no_warning() {
        let rows = designated_rows(&[plugin("forge", Some(A), None, &["alpha", "beta"])], none);
        assert_eq!(
            rows,
            vec!["✔ plugins      forge @ SidCorp-co/forge-plugin: pinned aaaaaaa, for alpha, beta"]
        );
        let rows = designated_rows(&[plugin("forge", None, None, &["alpha"])], none);
        assert_eq!(
            rows,
            vec!["✔ plugins      forge @ SidCorp-co/forge-plugin: latest, for alpha"]
        );
    }

    #[test]
    fn nothing_designated_is_a_note_not_a_check_mark() {
        assert_eq!(
            designated_rows(&[], none),
            vec!["• plugins      no project this box serves designates a plugin"]
        );
    }

    #[test]
    fn a_marketplace_the_operator_registered_says_the_designation_is_not_applied() {
        let rows = designated_rows(&[plugin("forge", Some(A), None, &["alpha"])], |_| {
            Some(PathBuf::from("/srv/forge-plugin"))
        });
        assert_eq!(rows.len(), 2, "{rows:#?}");
        assert!(rows[1].contains("registered to /srv/forge-plugin by this box's operator"));
        assert!(rows[1].contains("not applied here"));
    }
}
