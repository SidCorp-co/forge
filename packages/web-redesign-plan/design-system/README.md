# Forge — Design System

> A calm, bright **control plane for running Claude Code at scale**.
> Forge turns the software lifecycle into an automated agent pipeline:
> **triage → clarify → plan → code → review → test → release**, where each
> step is handled by an agent that hands work off to the next.

This folder is a self-contained design system: brand assets, color & type
foundations, reusable CSS tokens, preview cards, and a high-fidelity UI kit
recreation of the Forge web app. It exists so any design agent can produce
on-brand Forge interfaces and assets — production or throwaway.

---

## What Forge is

Forge is an **open-source project-management platform fused with an AI-agent
pipeline**. Instead of invoking AI command-by-command, Forge automates the
development lifecycle: every issue flows through a strict, sequential pipeline
where one agent owns each step and hands off to the next.

**Architecture** — a full-stack monorepo (pnpm + turbo) with four pieces:

| Package | Role |
|---|---|
| **core** | Hono backend on Postgres (pgvector for embeddings); also the WebSocket server, MCP server, and the runner that orchestrates Claude. |
| **web** | The cloud interface, built in Next.js. *(This is the surface the UI kit recreates.)* |
| **dev** | A Tauri desktop app that lets agents work directly against a local codebase via the Claude CLI. |
| **contracts** | Shared types so all three clients stay in sync with one REST API contract. |

**What makes it distinct** — real-time and multi-device. One device can run
runners for several projects at once; every change is broadcast instantly over
WebSocket to all interfaces. The pipeline is **strictly sequential** — a step
only starts once the previous one has fully finished — with orphan-job cleanup
so runners never get stuck. Built for teams who want Claude in their
engineering process in a way that is controlled, observable (Sentry, per-step
pipeline analytics), and fully self-hosted.

**The product experience we're designing for:** open it up and immediately
understand *"where is my project right now"* with no learning curve. Tidy,
bright, lots of breathing room — the feeling of calm and control. Not as dense
as a technical dashboard, not as loud as a consumer app. English only.

---

## Sources used to build this system

> These were the inputs. The reader may not have access — they're recorded here
> so the system can be improved if access is restored.

- **GitHub repo:** [`SidCorp-co/forge`](https://github.com/SidCorp-co/forge) —
  the Forge monorepo (core / web / dev / contracts). *Browse this repo to build
  more accurate Forge designs — the `packages/web/src` tree is the source of
  truth for the cloud UI.* **Note:** GitHub was not connected during this build,
  so the UI kit is a **proposed, polished direction** informed by the product's
  information architecture rather than a pixel-for-pixel port. Reconnect GitHub
  and pull `packages/web/src/features/**` to true it up.
- **Codebase artifact (mounted):** `rest-api-map/` — a generated map of all 259
  REST endpoints and which clients call them. This is the backbone of the
  product's information architecture and drove the screens in the UI kit
  (projects, issues, pipeline runs, runners, devices, agent-sessions, skills,
  PM policies, schedules, analytics).
- **Brand assets (uploaded):** `uploads/32x32.png`, `uploads/180x180.png` — the
  app icons / mascot. Copied into `assets/`.

---

## CONTENT FUNDAMENTALS

How Forge talks. The voice is that of a **calm operations console** — precise,
quietly confident, never chatty. It tells you the state of the world and what
happens next, then gets out of the way.

- **Person & address.** Speak to the user as **"you"**; the product refers to
  itself by name ("Forge") or in the imperative, rarely "we". Agents are named
  by their role, not anthropomorphized ("the Plan agent", not "I'll now plan").
- **Tone.** Factual and reassuring. State status plainly: *"Waiting on review",
  "3 steps remaining", "Runner offline — reconnecting"*. Avoid hype, avoid
  exclamation marks. Confidence comes from clarity, not enthusiasm.
- **Casing.** **Sentence case everywhere** — buttons, menus, headings, table
  headers (`New project`, not `New Project`). The seven pipeline stages are the
  one exception: rendered as lowercase or small-caps mono labels
  (`triage`, `clarify`, `plan`, `code`, `review`, `test`, `release`).
- **Verbs for actions.** Short, literal, present-tense: *Run, Pause, Resume,
  Retry, Cancel, Fork, Rerun, Decompose, Sweep zombies, Pair device, Rotate key.*
- **Status language.** A small, consistent vocabulary: `queued · running ·
  blocked · waiting · passed · failed · paused · done`. Reuse these exact words.
- **Numbers & telemetry.** Lead with the metric, label after: *"$0.42 this run",
  "12s median", "4 / 7 steps"*. Money, durations, token counts and IDs are set
  in the **monospace** face.
- **IDs & technical strings.** Issue keys (`FRG-241`), branch names, run IDs,
  endpoints, and skills are always monospace, never sentence-styled.
- **Emoji.** **Not used** in product UI. The mascot carries the personality;
  the interface stays clean.
- **Empty states.** One calm line + one action. *"No issues yet. Create one to
  start the pipeline." [New issue]* — never cute, never apologetic.
- **Errors.** Plain cause + remedy: *"Runner lost connection. It will resume
  automatically, or retry now."*

**Examples**
- Button: `Run pipeline` · `Pause run` · `Pair a device`
- Section kicker (overline, mono uppercase): `PIPELINE` · `RUNNERS` · `ACTIVITY`
- Status chip: `running · code` · `blocked` · `waiting on review` · `passed`
- Empty: `Nothing in review. Steps appear here as agents hand off work.`

---

## VISUAL FOUNDATIONS

The feeling: **a quiet, well-lit workshop.** Warm paper-white surfaces, ink-dark
text, generous whitespace, and one decisive warm accent — flame orange — used
only where the user acts or where work is *live*. Cobalt provides cool
structural contrast (links, info, the clarify stage). Everything else is
restrained so status reads instantly.

### Color
- **Warm paper neutrals, not cold gray.** The app background is `#FBFAF8`, cards
  are pure white `#FFFFFF`, sunken panels `#F5F3EF`. Borders are warm
  (`#E4E0D8`) — never blue-gray. This is the source of the "calm, bright" feel.
- **Flame orange `#F15A2B` is the single action/active accent**, derived from
  the mascot. Use it for primary buttons, the active pipeline stage, focus on
  live work, and the logo. Used sparingly — if everything is orange, nothing is.
- **Cobalt `#2D5BD6`** is the secondary/structural color: links, informational
  badges, secondary buttons, the `clarify` stage.
- **Amber `#E8920C`** (the mascot's gold) = scheduled / review / attention.
- **Semantic hues are muted, never neon:** green `#1F9D6B` (passed/done), amber
  (warning/review), red `#D6453B` (failed/danger). Each pairs with a soft tint
  background (`*-50`) for chips and banners.
- **Pipeline stage palette** gives each of the 7 stages a muted dot color
  (violet→cobalt→teal→flame→amber→green→ink) so a run reads as a colored
  progression — but the *current* stage is always flame.

### Type
- **Hanken Grotesk** for everything UI — a calm humanist grotesk. Display is
  tight (`-0.022em`, weight 800); body is comfortable at 15px / 1.55.
- **JetBrains Mono** for code, IDs, metrics, endpoints, and the mono *overline*
  used as section kickers and stage labels. The mono face is a deliberate
  signal: "this is engineering infrastructure."
- Sentence case; no all-caps except the mono overline (uppercase, `0.10em`
  tracking).

### Spacing & layout
- **4px base scale.** Components breathe — 16–24px internal padding on cards,
  large gutters between regions. Density is intentionally *low*.
- **Layout uses flex/grid with `gap`**, never inline-flow spacing.
- The web app is a fixed left **nav rail + workspace**; primary actions sit
  top-right; context (run/pipeline detail) opens in a right-hand panel rather
  than navigating away.

### Surfaces, borders, radii
- **Cards:** white, `1px` warm border (`--border-default`), radius `13px`
  (`--r-lg`), and a soft low shadow (`--shadow-sm`). They rest on the paper bg
  rather than floating dramatically.
- **Controls:** radius `9px` (`--r-md`); pills/chips use `--r-pill`.
- **Borders do most of the structural work; shadows are soft and warm**
  (tinted with ink at 4–10% alpha), never hard black. Large surfaces (modals,
  popovers) use `--shadow-lg`.

### Motion
- **Calm and quick.** `120–200ms`, ease-out (`cubic-bezier(0.22,1,0.36,1)`).
  Fades and small (2–4px) translate/settle moves. The one animated flourish is
  the **active pipeline stage**: a gentle pulsing flame dot. No bounce, no
  spring overshoot, no parallax.

### States
- **Hover:** surfaces lift to `--bg-hover` (warm `#F5F3EF`); accent buttons
  darken one step (`--flame-600`). Subtle, no scale.
- **Press:** darken another step (`--flame-700`) + `translateY(1px)`.
- **Focus:** `3px` cobalt ring (`--shadow-focus`) — accent controls use a flame
  ring (`--shadow-focus-accent`). Always visible, never removed.
- **Disabled:** `--fg-disabled` text, `--paper-200` fill, no shadow.

### Transparency, blur, imagery
- **Used sparingly.** A light backdrop blur behind modals/command palette
  (`blur(8px)` over `rgba(24,27,34,0.25)`). No glassmorphism in the body.
- **No gradients on backgrounds**, no textures, no full-bleed hero photos in the
  app. The brand expresses itself through the mascot, flame accent and clean
  space — not decoration.
- **Avoid:** bluish-purple gradients, emoji cards, rounded-card-with-colored-
  left-border, neon, drop-shadow-heavy "floating" UI. None of these are Forge.

---

## ICONOGRAPHY

- **Icon set: [Lucide](https://lucide.dev)** — a clean, consistent 1.5–2px
  stroke line-icon set. *Substitution flag:* the exact set used by the Forge web
  app could not be confirmed (GitHub was not connected), but Lucide is the
  de-facto choice for Next.js apps of this kind and matches the calm, light
  stroke we want. **If the real repo uses a different set, swap it.** Loaded via
  CDN in the UI kit (`lucide@latest`); icons render at `18px`/`20px` with
  `stroke-width: 1.75`, colored `--fg-muted` by default and `--accent` when
  active.
- **No icon font, no emoji** in the product UI. Status is shown with **colored
  dots** (the stage/semantic palette) plus a text label — not emoji.
- **The mascot** (`assets/forge-mark-*.png`) is the one piece of illustrative
  brand art: a friendly orange-and-blue robot helmet. Use it for the logo,
  loading states, and empty-state spots — not as a UI icon.
- **Unicode** is used only for true typographic glyphs (·, →, ×, ⌘), never as
  pictograms. The arrow `→` recurs as the pipeline hand-off symbol.

---

## Index — what's in this folder

| Path | What it is |
|---|---|
| `README.md` | This file — context, content & visual foundations, iconography, index. |
| `colors_and_type.css` | All design tokens: color scales, semantic vars, type styles, radii, shadows, spacing, motion. **Import this everywhere.** |
| `SKILL.md` | Agent-Skills entry point for using this system in Claude Code. |
| `assets/` | Brand art — the Forge mascot mark (`forge-mark-180.png`, `forge-mark-32.png`). |
| `preview/` | Small HTML cards that populate the Design System tab (type, color, spacing, components, brand). |
| `ui_kits/web/` | High-fidelity recreation of the Forge web app: `index.html` (interactive walkthrough) + JSX components. See its own `README.md`. |
| `rest-api-map/` | *(mounted input)* The REST endpoint map that defined the product's IA. |

**To build a Forge design:** import `colors_and_type.css`, pull components from
`ui_kits/web/`, copy assets you need from `assets/`, and follow the content &
visual rules above.
