# Architecture

**The shape of the system** — what planes exist, what runs where, and what carries data between
them. It changes rarely by design: a new document here means the system grew a plane or a
transport, not that a feature shipped.

| Document | What it answers |
|---|---|
| [system-overview.md](system-overview.md) | what runs where, and what talks to what |
| [data-plane-surface.md](data-plane-surface.md) | which MCP tool a REST route replaces, and which routes `forge-runner api` cannot reach |
| [agent-surface.md](agent-surface.md) | which CLI belongs to whom, and which MCP tools survive the shrink — with the target the two issues deliver |
| [comment-conventions.md](comment-conventions.md) | what a comment in this repo may claim, which annotation kinds survive, and where a lesson goes instead |
| [forge-plugin-coupling.md](forge-plugin-coupling.md) | every place a change here has a second half in `github.com/SidCorp-co/forge-plugin`, what breaks when they drift, and whether anything notices |
| [forge-feature-and-issue-map.html](forge-feature-and-issue-map.html) | target workflow, three figures: the three planes and their one lane; one issue from `open` to ready-for-release on staging; release as one skill for a batch or a single issue, `closed` only after production is verified — open the file in a browser |
