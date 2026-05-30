---
name: forge-design
description: Use this skill to generate well-branded interfaces and assets for Forge, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the `README.md` file within this skill, and explore the other available files.

Forge is an open-source **control plane for running Claude Code at scale** — it
turns the software lifecycle into a sequential agent pipeline
(`triage → clarify → plan → code → review → test → release`). The design feels
like a calm, bright workshop: warm paper-white surfaces, ink text, generous
whitespace, one decisive flame-orange action accent, cobalt for structure.

## What's here
- `README.md` — full context: product, content fundamentals, visual
  foundations, iconography, and an index of every file.
- `colors_and_type.css` — all design tokens (color scales + semantic vars, type
  styles, radii, shadows, spacing, motion). **Import this in everything.**
- `assets/` — the Forge mascot mark (robot helmet).
- `preview/` — small specimen cards (type, color, spacing, components, brand).
- `ui_kits/web/` — interactive React recreation of the Forge cloud app
  (board, run detail, runners, login) with reusable components.

## How to work
- **Visual artifacts** (slides, mocks, throwaway prototypes): copy the assets and
  tokens out, then produce static/interactive HTML for the user to view. Pull
  components from `ui_kits/web/` and follow the rules in `README.md`.
- **Production code**: read the rules here to become an expert in the brand, and
  reference the UI kit components as the canonical look.
- Reserve flame orange for actions and the *active* pipeline stage. Keep status
  legible by leaving everything else neutral. Sentence case copy; monospace for
  IDs, stages, metrics, and code.

If the user invokes this skill without other guidance, ask what they want to
build or design, ask a few focused questions, then act as an expert designer who
outputs HTML artifacts *or* production code, depending on the need.
