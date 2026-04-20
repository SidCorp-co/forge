# Documentation

Jarvis Agents documentation, organized by purpose.

## Where to go

| I want to | Go here |
|-----------|---------|
| Run Jarvis Agents for the first time | [quickstart.md](quickstart.md) |
| Understand the overall system | [architecture/](architecture/) |
| Understand a specific feature (issues, agents, devices, skills, chat, memory) | [modules/](modules/) |
| Know why a technical choice was made | [decisions/](decisions/) |
| Propose a significant change | [rfcs/](rfcs/) |
| Read planned but unshipped features | [proposals/](proposals/) |
| Connect Jarvis Agents to an external platform | [integrations/](integrations/) |
| Follow a how-to for a specific task | [guides/](guides/) |
| See what's shipping next | [ROADMAP.md](ROADMAP.md) |
| Use the brand / voice correctly | [BRAND.md](BRAND.md) |

## Folder purpose

| Folder | Answers | Changes |
|--------|---------|---------|
| `architecture/` | How is the system built? How do modules chain together? | Rarely |
| `decisions/` | Why was X chosen over Y? | Append-only |
| `guides/` | How do I do X? | When process changes |
| `integrations/` | How does external platform Y work with Jarvis? | When platform API changes |
| `modules/` | How does feature Z work? Where does its data come from? | When feature changes |
| `proposals/` | What will we build next? | Move to `modules/` when shipped |
| `rfcs/` | Proposals through Final Comment Period | One per major change |

## Conventions

- Data-flow over code-structure — docs answer "where does data come from, how does it transform" not "which class handles this"
- Cross-references via relative links — no content duplicated across files
- One canonical location per fact — if it's in a module doc, don't restate in architecture
- ADRs are append-only — never edit a past decision; add a new ADR that supersedes it
