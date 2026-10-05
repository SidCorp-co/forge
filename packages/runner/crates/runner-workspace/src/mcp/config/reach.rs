use super::*;

/// The MCP server every `forge_*` tool is served by, including `forge_source`.
pub const FORGE_SERVER: &str = "forge";

/// One half of a master pane's MCP reach: a config file, and what it declares.
///
/// A file that is not there declares nothing, and that is knowledge. A file
/// that is there and will not parse declares nothing KNOWABLE, which is a
/// different answer and the one no diagnosis may be built on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Half {
    /// The file parsed, and these are the server names it declares.
    Declares(Vec<String>),
    /// There is no such file.
    Missing,
    /// The file is there and could not be read, in its own words.
    Unreadable(String),
}

impl Half {
    /// Read one config file for the NAMES of the servers it declares.
    ///
    /// Only the keys of `mcpServers` are taken. These files carry bearer
    /// tokens in their values and no caller of this is ever handed one.
    pub(crate) fn read(path: &Path) -> Self {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Self::Missing,
            Err(e) => return Self::Unreadable(e.to_string()),
        };
        let doc = match serde_json::from_str::<Value>(&text) {
            Ok(v) => v,
            // A serde_json parse error names a line and a column and quotes no
            // input, so it is safe to carry out of a file holding a token.
            Err(e) => return Self::Unreadable(e.to_string()),
        };
        match doc.get("mcpServers") {
            None => Self::Declares(Vec::new()),
            Some(Value::Object(map)) => Self::Declares(map.keys().cloned().collect()),
            Some(_) => Self::Unreadable("`mcpServers` is not an object".to_string()),
        }
    }

    pub(crate) fn names(&self) -> &[String] {
        match self {
            Self::Declares(names) => names,
            Self::Missing | Self::Unreadable(_) => &[],
        }
    }

    pub(crate) fn unreadable(&self) -> bool {
        matches!(self, Self::Unreadable(_))
    }

    /// This half as one clause of the inventory the pane is shown.
    pub(crate) fn clause(&self) -> String {
        match self {
            Self::Declares(names) if names.is_empty() => "declares no servers".to_string(),
            Self::Declares(names) => {
                let mut names = names.clone();
                names.sort();
                format!("declares {}", names.join(", "))
            }
            Self::Missing => "is not there, so it declares nothing".to_string(),
            Self::Unreadable(why) => {
                format!("could NOT be read ({why}), so what it declares is unknown")
            }
        }
    }
}

/// What else this box can OBSERVE when the union holds no [`FORGE_SERVER`].
///
/// Not a history. [`write_persistent`] writes that entry from the credential
/// core minted for the checkout, falling back to this box's stored PAT, so an
/// absent entry is consistent with a provision that never ran, one that ran
/// without a credential, and a file edited since. Naming one of those would be
/// the invented certainty ISS-1114 is about, a layer along.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForgeAbsentBecause {
    /// No operator PAT is stored here either, so this box has no credential of
    /// its own to fall back on.
    AndNoCredentialHere,
    /// An operator PAT IS stored here, so a re-provision has one to write.
    WhileACredentialIsHere,
}

/// What this box may say about [`FORGE_SERVER`] being within a pane's reach.
///
/// Three answers and never two: the third exists because a half that could not
/// be read is not a half that declares nothing, and reporting it as one would
/// be the same substitution ISS-1114 was opened about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForgeReach {
    /// One of the halves declares it.
    Declared,
    /// Both halves were read and neither declares it.
    Absent(ForgeAbsentBecause),
    /// A half could not be read, so nothing follows about it either way.
    Undetermined,
}

/// What a master pane will actually be able to see.
///
/// A pane is started with `--mcp-config <session file>` and deliberately
/// WITHOUT `--strict-mcp-config`, so its reach is the union of the checkout's
/// `.mcp.json` and that session file. Neither file on its own answers the
/// question the pane has to ask, which is what it holds — and the daemon log,
/// where the runner says what it wrote, is not a thing a pane reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneReach {
    pub(crate) repo_path: PathBuf,
    pub(crate) repo: Half,
    pub(crate) session_path: Option<PathBuf>,
    pub(crate) session: Half,
    pub(crate) has_operator_pat: bool,
}

/// The union a pane started in `repo_path` with `session_config` will get.
pub fn pane_reach(repo_path: &Path, session_config: Option<&Path>) -> PaneReach {
    pane_reach_in(
        repo_path,
        session_config,
        load_pat()
            .ok()
            .flatten()
            .is_some_and(|t| !t.trim().is_empty()),
    )
}

pub(crate) fn pane_reach_in(
    repo_path: &Path,
    session_config: Option<&Path>,
    has_operator_pat: bool,
) -> PaneReach {
    let repo_file = repo_path.join(".mcp.json");
    PaneReach {
        repo: Half::read(&repo_file),
        repo_path: repo_file,
        session: session_config.map_or(Half::Missing, Half::read),
        session_path: session_config.map(Path::to_path_buf),
        has_operator_pat,
    }
}

impl PaneReach {
    /// Every server name the union declares, sorted and deduplicated.
    pub fn names(&self) -> Vec<String> {
        let mut all: Vec<String> = self
            .repo
            .names()
            .iter()
            .chain(self.session.names())
            .cloned()
            .collect();
        all.sort();
        all.dedup();
        all
    }

    /// What this box may say about `forge`.
    pub fn forge(&self) -> ForgeReach {
        if self.names().iter().any(|n| n == FORGE_SERVER) {
            return ForgeReach::Declared;
        }
        if self.repo.unreadable() || self.session.unreadable() {
            return ForgeReach::Undetermined;
        }
        ForgeReach::Absent(if self.has_operator_pat {
            ForgeAbsentBecause::WhileACredentialIsHere
        } else {
            ForgeAbsentBecause::AndNoCredentialHere
        })
    }

    /// One line for an operator's log, saying which of the three this is.
    pub fn verdict(&self) -> String {
        let held = self.names();
        let held = if held.is_empty() {
            "nothing".to_string()
        } else {
            held.join(", ")
        };
        match self.forge() {
            ForgeReach::Declared => format!("declares {held}, `forge` among them"),
            ForgeReach::Absent(ForgeAbsentBecause::AndNoCredentialHere) => format!(
                "declares {held} and NOT `forge`: no such entry in {}, and no operator PAT stored \
                 here to write one — re-provision the checkout, or `forge-runner login --pat \
                 <token>`",
                self.repo_path.display()
            ),
            ForgeReach::Absent(ForgeAbsentBecause::WhileACredentialIsHere) => format!(
                "declares {held} and NOT `forge`: no such entry in {}, though an operator PAT is \
                 stored here — re-provision the checkout",
                self.repo_path.display()
            ),
            ForgeReach::Undetermined => format!(
                "declares {held}, and whether `forge` is among them is UNDETERMINED: {}",
                self.unreadable_clause()
            ),
        }
    }

    pub(crate) fn unreadable_clause(&self) -> String {
        let mut which = Vec::new();
        if let Half::Unreadable(why) = &self.repo {
            which.push(format!(
                "{} could not be read ({why})",
                self.repo_path.display()
            ));
        }
        if let Half::Unreadable(why) = &self.session {
            let path = self
                .session_path
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "the session config".to_string());
            which.push(format!("{path} could not be read ({why})"));
        }
        which.join("; ")
    }

    /// The reach as the prose a pane is given when it starts.
    ///
    /// Server names only: no value from either file reaches this string, and
    /// the wording says the files DECLARE these servers rather than that any of
    /// them answers.
    pub fn brief(&self) -> String {
        let session_line = match self.session_path.as_ref() {
            Some(path) => format!("- `{}` {}\n", path.display(), self.session.clause()),
            None => "- no session config was written for this pane, so it declares nothing\n"
                .to_string(),
        };
        let held = self.names();
        let held = if held.is_empty() {
            "nothing at all".to_string()
        } else {
            held.join(", ")
        };
        // A half that could not be read makes the union a floor and not a
        // total, and a line that said otherwise would be this issue's own
        // defect wearing the fix's clothes.
        let holds = if self.repo.unreadable() || self.session.unreadable() {
            format!(
                "So this pane is known to hold AT LEAST: {held}. One of those two files could not \
be read, so that list may be short by whatever it declares."
            )
        } else {
            format!("So this pane holds: {held}.")
        };
        let mut out = format!(
            "\n## What this pane can actually reach\n\nThis pane was started with `--mcp-config` \
and deliberately without `--strict-mcp-config`, so its MCP reach is the UNION of two files:\n\n\
- `{}` {}\n{session_line}\n{holds} That is what those two files DECLARE. \
Nothing here has checked that any of them answers, authenticates, or serves the tools it names.\n",
            self.repo_path.display(),
            self.repo.clause(),
        );
        match self.forge() {
            ForgeReach::Declared => {}
            ForgeReach::Absent(because) => {
                out.push_str(ABSENT_FORGE);
                out.push_str(&self.cause_line(because));
            }
            ForgeReach::Undetermined => out.push_str(&format!(
                "\nWhether the `{FORGE_SERVER}` MCP server is within that union could NOT be \
determined, because {}. Conclude nothing from this either way: if no `forge_*` tool is in the \
inventory you can see, report that this box could not read its own MCP configuration — never that \
the capability is unavailable, and never that it refused.\n",
                self.unreadable_clause()
            )),
        }
        out
    }

    pub(crate) fn cause_line(&self, because: ForgeAbsentBecause) -> String {
        match because {
            ForgeAbsentBecause::AndNoCredentialHere => format!(
                "\nWhat is observed, which is not the same as what happened: there is no \
`{FORGE_SERVER}` entry in `{}`, and no operator PAT is stored on this box either. The runner \
writes that entry when it provisions a checkout, from a credential core mints for the project or, \
failing that, from a PAT stored here — so re-provision this checkout, or run `forge-runner login \
--pat <token>` to give this box one of its own. Why it is missing is not something this pane can \
tell you: it may never have been written, or it may have been removed since.{TAIL}",
                self.repo_path.display()
            ),
            ForgeAbsentBecause::WhileACredentialIsHere => format!(
                "\nWhat is observed, which is not the same as what happened: there is no \
`{FORGE_SERVER}` entry in `{}`, though this box DOES hold an operator PAT — so a credential is on \
hand and the entry is still missing. Re-provision this checkout on this box. Why it is missing is \
not something this pane can tell you.{TAIL}",
                self.repo_path.display()
            ),
        }
    }
}

/// What follows either observation: a pane cannot be re-configured in place.
pub(crate) const TAIL: &str =
    " A started pane cannot be handed a new MCP configuration, so the pane that \
gets it is the next one this box starts.\n";

/// What a pane is told when `forge` is in neither half of its union.
///
/// It is absence and not refusal that has to land: a pane that could not tell
/// the two apart reasoned from `gh`, the only GitHub-shaped thing it could
/// still see, and reported pull requests unreachable as established fact for
/// six passes (ISS-1114).
pub(crate) const ABSENT_FORGE: &str = "\nThe `forge` MCP server is in NEITHER half, so every `forge_*` tool \
is ABSENT from this pane — `forge_source`, which is the only route to a pull or merge request, \
along with `forge_uploads`, `forge_agent_report` and the rest.\n\nAbsent is not refused. A tool you cannot see has \
told you nothing about whether its route is open, so do not report a route as shut on the strength \
of not seeing it, and do not reach for `gh` or `glab` instead: it runs as whoever configured this box, which \
is neither attributable nor revocable. Say the capability is unreachable FROM THIS PANE, and name \
the cause below.\n";
