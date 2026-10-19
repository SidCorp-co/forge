# Project skill — authoring template

Start from this skeleton. Delete sections that don't apply. Keep the body lean (decision logic); push long checklists/playbooks to sibling `references/*.md`.

```markdown
---
name: <purpose>
description: "<one line: what it does + when to use it + trigger phrases>."
user_invocable: true
arguments: "[issue-key]"
---

# <Purpose> — <project>

<1–2 sentences: what this skill does and the ONE thing it must get right for this project.>

## Tools
- forge_issues, forge_comments  (+ the project-specific tools: e.g. a vendor MCP, forge_coolify_deploy, Bash)

## Workflow

### Step 1: Read context
Read the issue + comments/handoff. (Don't restate the status vocabulary — the preamble carries it.)

### Step 2…N: <intent-level steps>
- Write WHAT to do, not the exact commands. Infer build/test/deploy from the repo or the project's deploy model.
- Name only NON-inferable policy: gitflow/merge model, deploy gate, domain heuristics.
- For long checklists/templates → "see references/<name>.md".

### Final step: say what happened
Post the comment. If the skill moves an issue's status, that move is the LAST action.
```

## Notes
- **Per-project values** (branch, URLs, creds, domain facts) → `forge_knowledge` / `environments`, NOT the body.
- **Adding `references/` via MCP:** pass each file with `encoding:"utf8"` (or `base64` for binaries).
- **Non-standard build/deploy** (MCP-driven, docs-only): replace the build/test/deploy steps with the project's real model; keep durable invariants inline, defer tool mechanics to the live MCP playbook.
