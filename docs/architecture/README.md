# Architecture

**The shape of the system** — what planes exist, what runs where, and what carries data between
them. It changes rarely by design: a new document here means the system grew a plane or a
transport, not that a feature shipped.

| Document | What it answers |
|---|---|
| [system-overview.md](system-overview.md) | what runs where, and what talks to what |
| [data-plane-surface.md](data-plane-surface.md) | which MCP tool a REST route replaces, and which the CLI cannot reach |
| [forge-feature-and-issue-map.html](forge-feature-and-issue-map.html) | two figures: the three planes and their one lane, and the four-actor life of a single issue — open the file in a browser |
