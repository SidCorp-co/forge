# Complexity Rules

Complexity classification matters because `forge-plan` uses it to decide whether to auto-approve the implementation plan (`xs/s/m`) or hold it for human review (`l/xl`), and whether the issue is a decompose candidate. Getting this wrong has real costs:
- **Too high (l/xl)** → unnecessary human gate, slows the pipeline
- **Too low** → under-planned, risks missing important cross-cutting concerns

The `complexity` field is one of `xs / s / m / l / xl`. Since triage runs without codebase access, classify based on the issue description, acceptance criteria, and your knowledge of typical software patterns.

## xs — trivial
A copy/constant/config one-liner with no real logic.

**Signals:** typo fix, label/copy change, bumping a constant, a single config value.
**Plan gate:** auto-approve.

## s — simple
Single file or component change, isolated, following an existing pattern.

**Signals:** style change, null check, adding a field to a form when the schema already supports it, a localized tweak.
**Plan gate:** auto-approve.

## m — medium
2–5 files within a single package. May need a new utility, hook, or component, but follows existing patterns.

**Signals:** new filter/sort option, new UI component using the existing design system, new field in an API response (schema exists), component refactor, new validation rule, error-handling additions.
**Plan gate:** auto-approve.

## l — large
Roughly 6+ files, a sizable single feature, or a cross-cutting change within a package (and possibly spilling into a second). Bigger than "follow an existing pattern" but still one coherent piece of work.

**Signals:** a feature touching a list screen + its API + a dialog; a non-trivial refactor across a module; several related endpoints.
**Plan gate:** human review. May be a decompose candidate if it splits into independently-shippable tracks.

## xl — epic
Cross-package work combining schema + API + UI, a new subsystem, or a multi-track effort.

**Signals:** mentions multiple packages, new content types / schema, new endpoints, "migration", "real-time", "authentication flow", "integration", a new third-party dependency, or several independently-reviewable workstreams.
**Plan gate:** human review; usually a **decompose candidate** (forge-plan splits it into a parent + children).

## Assessment Heuristics (Without Codebase)

1. **Description scope** — how many areas/features are mentioned?
2. **Acceptance criteria count** — many criteria usually correlate with higher complexity.
3. **Keywords** — "schema", "migration", "new API", "cross-platform", "multi-tenant" push toward `l`/`xl`.
4. **Package mentions** — multiple packages = almost certainly `xl`.
5. **When in doubt, classify as `m`** — forge-plan can upgrade after reading the actual codebase, and starting too high adds unnecessary friction.
