# Project skill — authoring template

Start from this skeleton. Delete sections that don't apply. Keep the body lean (decision logic); push long checklists/playbooks to sibling `references/*.md`.

```markdown
---
name: forge-<stage-or-purpose>
description: "<one line: what it does + when Forge dispatches it + trigger phrases>. Also use when the pipeline needs to move an issue from <fromStatus> to <toStatus>."
user_invocable: true
arguments: "documentId"
---

# Forge <Stage> — <project>

<1–2 sentences: which transition this owns (`<from> → <to>`) and the ONE thing it must get right for this project.>

## Tools
- forge_issues, forge_comments  (+ the project-specific tools: e.g. a vendor MCP, forge_coolify_deploy, Bash)

## Workflow

### Step 1: Check in & read context
Call forge_step_start; read the issue + upstream comments/handoff. (Don't restate the status ladder — the preamble carries it.)

### Step 2…N: <intent-level steps>
- Write WHAT to do, not the exact commands. Infer build/test/deploy from the repo or the project's deploy model.
- Name only NON-inferable policy: gitflow/merge model, deploy gate, domain heuristics, stage exits that differ from the default ladder.
- For long checklists/templates → "see references/<name>.md".

### Final step: comment, then set status LAST
Post the stage comment, then transition status as the LAST action (it triggers the next stage).
```

## Notes
- **Per-project values** (branch, URLs, creds, domain facts) → `forge_config projectFacts` / `previewDeploy`, NOT the body.
- **Adding `references/` via MCP:** pass each file with `encoding:"utf8"` (or `base64` for binaries).
- **Non-standard build/deploy** (MCP-driven, docs-only): replace the build/test/deploy steps with the project's real model; keep durable invariants inline, defer tool mechanics to the live MCP playbook.
