# Handoff: Forge Web — UI v2

A package for implementing the Forge cloud web app (the Next.js `packages/web`
surface) in the real codebase, using **Claude Code**. It contains the design
system, an interactive HTML prototype of every screen, and the structure +
conventions to follow.

> **Start here:** read `INTEGRATION.md` (the structure guide) and
> `design-system/README.md` (brand, content & visual foundations), then open
> `ui-kit/Forge — Web App.html` to click through the working prototype.

---

## About the design files

The files under `ui-kit/` are **design references built in HTML/React-via-Babel**
— prototypes that show the intended look and behavior. They are **not production
code to copy**. The task is to **recreate these designs inside `packages/web`**
using its established environment (Next.js App Router, TypeScript, the team's
styling system and component primitives) and to wire them to the real REST API
(`@forge/contracts`). Where the prototype uses static sample data (`Data.jsx`,
`RichIssueData.jsx`), replace it with real API hooks.

`INTEGRATION.md` gives the exact target file structure and the
prototype → production mapping table. **Follow it.**

## Fidelity: **High-fidelity (hifi)**

Final colors, typography, spacing, radii, shadows, and interactions are all
decided and tokenized in `design-system/colors_and_type.css`. Recreate the UI
pixel-faithfully using those tokens (mapped into the codebase's styling layer —
see INTEGRATION §3). Do **not** invent new colors or fonts; extend the token
file if something is genuinely missing.

---

## Screens / views

Open `ui-kit/Forge — Web App.html`. The prototype starts on **Projects** and
the sidebar is two-tier (Workspace / Project). Each view below maps to a JSX
file in `ui-kit/` (see the Files section + INTEGRATION mapping).

1. **Login** (`LoginScreen.jsx`) — centered, brand-forward sign-in (email +
   password, GitHub OAuth). Reached via Log out.
2. **Projects console** (`ProjectsScreen.jsx`) — workspace overview for *many*
   projects: stats band, search, sort (recent / name / health), **Cards ⇄ List**
   views, a needs-attention banner/filter, pinned section, and a New-project tile.
   Each project shows health, live runs, open issues, runners, spend, members.
3. **Board** (`BoardScreen.jsx`) — issue list with a live banner, filter tabs,
   per-row pipeline progress, status, cost, assignee, and **dependency badges**
   (🔒 blocked-by amber / → blocks muted).
4. **Pipeline** (`PipelineScreen.jsx`) — kanban with one column per stage
   (`triage → clarify → plan → code → review → test → release`); issues flow L→R.
5. **Issue detail** (`IssueScreen.jsx`) — full page. Two depths:
   - *Simple*: description, pipeline tracker, Activity / Tasks / Comments tabs,
     properties rail, dependencies.
   - *Rich* (open **ISS-273**): markdown description, acceptance-criteria
     checklist, a **collapsible agent plan**, a lifecycle **comment thread** with
     status badges (Triage/Plan/Code/Changes/Fix/Approved/QA/Released) and
     **image attachments**, an **activity timeline** (status transitions,
     uploads, dependency edges), and a rich properties rail (merge commit, etc).
6. **Agent session (chat)** (`SessionScreen.jsx`) — the conversation for a run:
   prompt, agent messages, tool cards (reads / edits with diffs / tests), a
   context rail (vertical pipeline, run stats, files changed), and a composer.
   Turn-level Regenerate / Fork.
7. **Sessions index** (`SessionsListScreen.jsx`) — agent-sessions queue: queue
   stats (active / queued / zombies / median wait), Sweep zombies, filters, and
   a session table with contextual actions (Cancel / Retry / Rerun / Abort / Sweep).
8. **Runners** (`RunnersScreen.jsx`) — devices + per-project runners, live status,
   Claude quota; Pair a device.
9. **Activity** (`ListScreens.jsx`) — cross-project agent-handoff feed + a context
   rail (today's stats, per-stage legend).
10. **Skills** (`ListScreens.jsx`) — shared skill registry with sync state + scope.
11. **Schedules** (`ListScreens.jsx`) — cadenced runs with enable toggles.
12. **Chrome** (`Shell.jsx`) — two-tier NavRail (Workspace: Projects/Activity/
    Runners · Project: switcher + Board/Pipeline/Sessions/Schedules/Skills) + TopBar
    (search→⌘K, notifications, New issue). Overlays (`Overlays.jsx`): ⌘K command
    palette + notifications dropdown.

## Interactions & behavior
- **Navigation:** clicking an issue (board / kanban / activity / notifications)
  opens the full Issue detail; "Open session" opens the chat; the switcher enters
  a project; "All projects" / logo → Projects console.
- **⌘K** command palette (arrow-key navigable). **Notifications** dropdown.
  **New issue** / **New project** modals. Toasts on create/sweep.
- **Motion:** 120–200ms ease-out (`cubic-bezier(0.22,1,0.36,1)`); the active
  pipeline stage and live indicators use a gentle pulse (`forge-pulse`). No bounce.
- **States:** hover lifts surfaces to `--bg-hover`; focus shows a cobalt ring;
  primary buttons darken one step on hover/press. See `design-system/README.md`
  → Visual Foundations for the full rules.
- **Real-time:** the product is WebSocket-driven; in production, live indicators
  reflect server events (not polling).

## State & data
- Prototype state is local React + static data (`Data.jsx`, `RichIssueData.jsx`).
- In production: one `api/` function per core route + a TanStack Query hook per
  feature; a WebSocket provider invalidates the relevant queries. Shared shapes
  come from `@forge/contracts`. See INTEGRATION §1, §4.

## Design tokens
All in `design-system/colors_and_type.css` — color scales (flame / cobalt /
amber / paper / ink) + semantic vars, the 7 pipeline-stage hues, type styles
(Hanken Grotesk + JetBrains Mono), radii, soft shadow system, 4px spacing scale,
and motion easings. Consume per INTEGRATION §3 (Tailwind mapping or CSS vars).

## Assets / iconography
- `design-system/assets/forge-mark-*.png` — the mascot mark (logo).
- Icons: **Lucide** stroke set (the prototype uses an inline Lucide-style set in
  `ui-kit/Icon.jsx`; in production prefer `lucide-react`). Status = colored dots,
  not emoji. Image attachments map to `GET /api/attachments/:id` (the prototype
  inlines sample screenshots as data URIs in `EvidenceImages.jsx`).

## Files (in this bundle)
- `INTEGRATION.md` — **target structure + prototype→production mapping (read first)**
- `design-system/` — `colors_and_type.css`, `README.md`, `SKILL.md`, `assets/`
- `ui-kit/` — the prototype: `index.html` (multi-file source), every `*.jsx`
  component, and `Forge — Web App.html` (self-contained, openable offline).

## Suggested first tasks for Claude Code
1. Drop `colors_and_type.css` into `styles/tokens.css`; wire the Tailwind/token
   layer (INTEGRATION §3).
2. Build `design/primitives/*` from `Primitives.jsx` + `Icon.jsx` (typed).
3. Implement the **agent-sessions** feature first (richest surface): list + queue
   stats + session conversation, wired to the real endpoints.
4. Then Board + Issue detail, Pipeline kanban, Projects console, Runners, and the
   list views — matching the prototype screen-for-screen.
