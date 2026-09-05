# Documentation

Forge documentation, organized by purpose.

> **Scope — this tree is INTERNAL.** `docs/` is engineering/contributor
> documentation (architecture, RFCs, proposals, threat models, module design,
> release/branching). It is **never** served to product users and **never**
> shipped into the app image. **End-user product docs** (how to *use* Forge —
> getting started, pair a runner, manage an org, troubleshoot) live in
> [`packages/web-v2/content/help/`](../packages/web-v2/content/help/) and are
> bundled into the web build. Do **not** put user-facing guides here, and do
> **not** put internal docs there.

## If you are an AI coding session — read in this order

0. **System map (30-second overview).** Load [system.graph.json](system.graph.json) — nodes + edges describing planes, services, modules, and their dependencies. Use this to orient yourself before touching anything. Validated against [system.graph.schema.json](system.graph.schema.json).
1. **Repo state.** Read `/CLAUDE.md` (root) — current status, active migrations, and a "before you start" reading map.
2. **Package context.** Read the `packages/<pkg>/CLAUDE.md` for the package you're touching.
3. **In-flight work.** Check [proposals/](proposals/). Your task may already be planned (or explicitly out of scope).
4. **Behavior canon.** For feature work, read the matching [modules/](modules/) domain — its map table says which doc to open, and each one opens with the diagram of that domain.
5. **Invariants you must not break.** Before changing a guard, a status write, a retry path or skill delivery, read the matching [decisions/](decisions/) ADR — it says what the mechanism holds, not just what it does.

If a doc disagrees with the code, trust the code, then propose a doc fix in the same PR. Do not silently re-derive.

## Where to go

| I want to | Go here |
|-----------|---------|
| Run Forge for the first time | [quickstart.md](quickstart.md) |
| Understand the overall system | [architecture/](architecture/) |
| Know what to call instead of an MCP tool | [architecture/data-plane-surface.md](architecture/data-plane-surface.md) |
| Know why a mechanism was decided this way | [decisions/](decisions/) |
| Understand a specific feature | [modules/](modules/) — seven domains, mapped in its README |
| Follow what happens across processes | [flows/](flows/index.html) — one diagram per flow, backfilled by the work that touches it |
| Propose a significant change | [rfcs/](rfcs/) |
| Read planned but unshipped features | [proposals/](proposals/) |
| Connect Forge to an external platform | [integrations/](integrations/) |

## Folder purpose

| Folder | Answers | Changes |
|--------|---------|---------|
| `architecture/` | What planes exist, what runs where, what carries data between them | Rarely — a new one means the system grew a plane or a transport |
| `decisions/` | Why was this decided, and what invariant does it hold? | Append-only, one per decision; never edited, only superseded |
| `integrations/` | How does external platform Y work with Forge? | When platform API changes |
| `modules/` | How does feature Z work? Where does its data come from? | When feature changes |
| `flows/` | What moves, in what order, and what happens when a hop fails? | When a change alters a flow's order, hops or failure paths |
| `proposals/` | What will we build next? | Move to `modules/` when shipped |
| `rfcs/` | Proposals through Final Comment Period | One per major change |

## Conventions

- Data-flow over code-structure — docs answer "where does data come from, how does it transform" not "which class handles this"
- Cross-references via relative links — no content duplicated across files
- One canonical location per fact — if it's in a module doc, don't restate in architecture
- Docs describe the system as it is **now**. Past migrations live in `CHANGELOG.md` + git log, not in `docs/`
