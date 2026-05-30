# Forge — Web UI Kit

A high-fidelity, interactive recreation of the **Forge cloud web app** (the
Next.js `packages/web` surface). It demonstrates the product's core loop —
*"where is my project right now"* — with real click-through interactions.

> **Fidelity note.** GitHub was not connected when this kit was built, so the
> visuals are a **proposed, polished direction** grounded in the product's
> information architecture (from `rest-api-map/`), not a pixel-for-pixel port of
> the live app. Reconnect `SidCorp-co/forge` and reference
> `packages/web/src/features/**` to true up component details.

## Run it

Open `index.html`. It mounts an interactive walkthrough:

1. **Projects** — the workspace console (`GET /api/projects`), built for many
   projects: a stats band, **search**, **sort** (recent / name / health),
   **Cards ⇄ List** views, a **needs-attention** banner/filter, and **pinned**
   projects pinned to the top. Each project shows health, live runs, open
   issues, runners, spend and members. The nav **project switcher** (searchable)
   flips the active project or jumps here; also ⌘K → “All projects”.
2. **Board** — the default view inside a project. A calm list of issues, each
   showing its live pipeline position (`triage → … → release`), status, and cost.
2. **Pipeline** — a kanban with one column per stage; issues flow left→right.
3. **Sessions** — the agent-sessions index (`GET /api/agent-sessions`): queue stats (active / queued / zombies / median wait), **Sweep zombies**, filters, and a table of every run with contextual actions. Click a row → the conversation.
4. **Open an issue** → a right-hand **run detail** panel slides in: full pipeline
   tracker, run controls (Pause / Rerun / Fork), and tabs for the agent-handoff
   **Timeline**, **Tasks**, and per-step **Cost**.
4. **Runners** — the real-time multi-device view: devices, their per-project
   runners, live status, and Claude quota.
5. **Activity** — a live feed of agent handoffs, with a context rail (today's
   stats + per-stage legend) that fills the width.
6. **Skills** — the shared skill registry with sync state and per-stage scope.
7. **Schedules** — cadence-based pipeline runs with enable toggles.
8. **Agent session (chat)** — from a run panel, *Open session* opens the full
   conversation: prompt, agent messages, tool calls (reads / edits with diffs /
   tests), a context rail (vertical pipeline, run stats, files changed), and a
   composer. Also reachable via ⌘K → “Open session”.
9. **⌘K command palette** — search & run commands, arrow-key navigable.
10. **Notifications** (bell) and **New issue** (top-right) — dropdown + modal.
11. **Log out** (bottom-left avatar) → the **sign-in** screen, then back in.

## Architecture

All components are plain React (via Babel), each file exporting to `window` so
they share scope. Load order is defined in `index.html`.

| File | Responsibility |
|---|---|
| `Icon.jsx` | Self-contained Lucide-style icon set (`<Icon name size />`). |
| `Data.jsx` | The 7-stage pipeline definition + sample issues / timeline / devices. |
| `Primitives.jsx` | `Button`, `StatusChip`, `MonoTag`, `Avatar`, `Stat` + status meta. |
| `PipelineTracker.jsx` | The hero motif — `full` / `compact` / `mini` variants. |
| `Shell.jsx` | `NavRail` (+ project switcher) + `TopBar`. |
| `ProjectsScreen.jsx` | Multi-project console: search, sort, cards/list, pinned + attention. |
| `BoardScreen.jsx` | Live banner, filter tabs, issue rows. |
| `PipelineScreen.jsx` | Kanban: 7 stage columns with flowing issue cards. |
| `SessionsListScreen.jsx` | Agent-sessions index: queue stats, sweep-zombies, session table. |
| `RunDetail.jsx` | Slide-over run panel: tracker + tabbed timeline / tasks / cost. |
| `RunnersScreen.jsx` | Device & runner cards. |
| `SessionScreen.jsx` | Agent session as a conversation + context rail + composer; turn-level regenerate / fork. |
| `ListScreens.jsx` | Activity feed (+ rail), Skills registry, Schedules list. |
| `Overlays.jsx` | ⌘K command palette + notifications dropdown. |
| `LoginScreen.jsx` | Centered, brand-forward sign-in. |
| `App.jsx` | State + screen orchestration, ⌘K, modal, toasts. |

## Conventions

> **Going to production?** See **`INTEGRATION.md`** in this folder — it defines
> the standard `packages/web` structure, the prototype→production file mapping,
> token-in-code setup, and the default stack (Tailwind + shadcn/ui +
> lucide-react + TanStack Query) to confirm against your repo.

- Imports `../../colors_and_type.css` — every color, radius, shadow and type
  style comes from those tokens. No hard-coded brand values in components.
- Flame is reserved for **action** and the **active pipeline stage**; everything
  else stays neutral so status reads instantly.
- Pipeline stage names and IDs are monospace; UI copy is sentence case.
- All screens are interactive recreations driven by the sample data in
  `Data.jsx` — swap that data (or wire the real REST API) to make them live.
- **Layout system:** every screen uses one content container (`max-width:
  1180px`) so gutters stay consistent. Content-light pages avoid a centered
  void by filling the width — a context rail (Activity), a responsive grid
  (Skills), or a full-width table (Schedules).
