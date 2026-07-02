# RFC 0001 — Skill delta-override composition

- Status: **Draft**
- Author: owner + agent session 2026-07-02
- Tracking: prerequisite work in ISS-605 (lineage stamp + rebase lane)

## Summary

Make the default project customization of a global skill template a **delta** (declared extension/override blocks) instead of today's full copy. The effective skill body is rendered as `template ⊕ delta` when the project copy is materialized. Full-copy remains the escape hatch. Template updates then flow to every delta-only project without a rebase.

## Motivation

Only `scope='project'` rows are usable at runtime (`skills/effective.ts`); adopting a template copies it. Every project skill is therefore a fork frozen at adoption time — template improvements strand in N projects. ISS-605 makes drift visible and adds an agent-rebase lane, but rebase is per-project work that scales O(projects × bumps). Deltas remove the rebase for the common case: most customizations are additive (project build/deploy commands, branch flow, extra gates), not rewrites.

## Guide-level explanation

A project customizes a skill by declaring only what differs:

```markdown
---
name: forge-code
extends: global/forge-code@>=6
---
<!-- @append: after "## Implementation" -->
### Project build
pnpm turbo build --filter=api...
<!-- @replace: section "## Merge" -->
Merge to `develop`, never `main` (gitflow).
```

Materialization: `effective = render(template_vN, delta)`. When the template bumps to vN+1, delta-only skills re-render automatically (behind the ISS-605 visibility sweep + explicit sync — no silent device push). A delta that no longer applies (anchor section gone) fails render → the skill is flagged `delta-conflict` and falls back to the last-good materialized body; a rebase issue is drafted, same lane as ISS-605.

Full copy (today's model) remains valid: skills without `extends` behave exactly as now.

## Reference-level explanation

- **Storage:** `skills` gains nullable `extendsGlobalSkillId`, `extendsVersionRange`, `deltaMd` (the delta source). `skillMd` stores the **materialized** body — the runtime read path is unchanged.
- **Materialization point:** on template bump / delta edit, server re-renders `skillMd` and re-hashes (`hashSkillBody(effectiveMd, files)`). Because runtime consumers (`resolveProjectSkills`, device manifest, skills-zip, dispatch) read only `skillMd` + hash, **no resolver change is needed** — composition happens at write time, not read time.
- **Delta operators:** `@append after <anchor>`, `@prepend before <anchor>`, `@replace section <anchor>`, `@remove section <anchor>`. Anchors are heading strings. Unresolvable anchor ⇒ render error ⇒ `delta-conflict` state (skill keeps serving last-good body).
- **Sync:** unchanged — materialized-body hash drives the existing report-based sync + explicit `skill.sync` push.

### ⚠️ Implementation precondition — audit before touching state (hard requirement)

Before any code, the implementer MUST re-audit the live resolution/dispatch path and design for these invariants (they protect in-flight job state):

1. **In-flight jobs must not observe a body change mid-run.** Jobs run from the skill already synced to the device's `.claude/skills/`; materialization must only change DB rows + sync *status*, never touch a device mid-job. Verify nothing pushes `skill.sync` automatically on re-render.
2. **Hash stability for non-delta skills.** Re-render must be a no-op for skills without `extends` — zero hash churn, or every project shows "out of sync" and invites a sync storm.
3. **Dispatch references skills by name via project registrations** (`skillRegistrations`); the delta layer must not alter registration semantics or the `installOnly` path.
4. **Failure containment:** a bad delta can never leave `skillMd` NULL/empty — render failures keep the last-good body (state never lies; a broken render must surface as `delta-conflict`, not as a silently different prompt).
5. Re-verify all of the above against code at implementation time — this RFC's reading of `effective.ts`/`sync.ts` is point-in-time (2026-07-02).

## Drawbacks

- A render layer + conflict state = new kernel surface to harden (against principle "kernel hard": more invariants to guard).
- Anchor-based deltas are brittle against heavy template restructuring — mitigated by `delta-conflict` + rebase lane, but restructures still cost O(delta projects).
- Two customization models coexist (delta + full copy) — docs and UI must keep them distinguishable.

## Rationale and alternatives

- **Do nothing / ISS-605 only:** rebase lane works but every bump costs an agent run per customized project. Deltas amortize that to zero for additive customizations.
- **Runtime composition (render at dispatch):** rejected — touches the hot dispatch path, breaks hash-based device sync (device disk would differ from rendered body), violates precondition 1.
- **Includes/partials (template imports project fragment):** inverted ownership; template authors would need to anticipate extension points. Delta operators need no template cooperation.

## Prior art

- Kustomize overlays / docker image layering (base + patch, escape hatch = fork).
- Terraform module version pinning (`extends @>=6` mirrors version ranges).
- Forge's own Skill Facts: platform mechanics already composed server-side into the preamble — this RFC extends the same composition philosophy one layer down.

## Unresolved questions

- Delta syntax: HTML-comment operators (above) vs. front-matter-declared patch list vs. unified-diff. Needs a spike on LLM-editability (agents will author deltas).
- Should `extendsVersionRange` hard-pin (`@6`) be allowed, opting out of auto-flow?
- Does the desktop Studio UI edit the delta or the materialized preview?
