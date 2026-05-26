# Documentation

Forge documentation, organized by purpose.

## If you are an AI coding session — read in this order

0. **System map (30-second overview).** Load [system.graph.json](system.graph.json) — nodes + edges describing planes, services, modules, and their dependencies. Use this to orient yourself before touching anything. Validated against [system.graph.schema.json](system.graph.schema.json).
1. **Repo state.** Read `/CLAUDE.md` (root) — current status, active migrations, and a "before you start" reading map.
2. **Package context.** Read the `packages/<pkg>/CLAUDE.md` for the package you're touching.
3. **In-flight work.** Check [proposals/](proposals/). Your task may already be planned (or explicitly out of scope).
4. **Behavior canon.** For feature work, read the matching [modules/](modules/) doc — it answers "where does data come from, how does it flow."
5. **Cross-cutting flows.** For anything spanning ≥2 modules, check [architecture/cross-module-flows.md](architecture/cross-module-flows.md).

If a doc disagrees with the code, trust the code, then propose a doc fix in the same PR. Do not silently re-derive.

## Where to go

| I want to | Go here |
|-----------|---------|
| Run Forge for the first time | [quickstart.md](quickstart.md) |
| Understand the overall system | [architecture/](architecture/) |
| Understand a specific feature (issues, agents, devices, skills, chat, memory) | [modules/](modules/) |
| Propose a significant change | [rfcs/](rfcs/) |
| Read planned but unshipped features | [proposals/](proposals/) |
| Connect Forge to an external platform | [integrations/](integrations/) |
| Follow a how-to for a specific task | [guides/](guides/) |

## Folder purpose

| Folder | Answers | Changes |
|--------|---------|---------|
| `architecture/` | How is the system built? How do modules chain together? | Rarely |
| `guides/` | How do I do X? | When process changes |
| `integrations/` | How does external platform Y work with Forge? | When platform API changes |
| `modules/` | How does feature Z work? Where does its data come from? | When feature changes |
| `proposals/` | What will we build next? | Move to `modules/` when shipped |
| `rfcs/` | Proposals through Final Comment Period | One per major change |

## Conventions

- Data-flow over code-structure — docs answer "where does data come from, how does it transform" not "which class handles this"
- Cross-references via relative links — no content duplicated across files
- One canonical location per fact — if it's in a module doc, don't restate in architecture
- Docs describe the system as it is **now**. Past migrations live in `CHANGELOG.md` + git log, not in `docs/`
