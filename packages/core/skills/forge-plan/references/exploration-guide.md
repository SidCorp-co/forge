# Codebase Exploration Guide

Every file you read costs tokens. The goal is to build enough understanding to write a correct plan while reading as few files as possible.

## Key Principle: Go Direct

Do NOT browse the project structure or read overview files to "understand the codebase." Use `.forge/knowledge.json` as your lookup table and jump straight to the files that matter.

## Step 1: Read knowledge.json

```
Read: .forge/knowledge.json
```

This gives you:
- **`paths`** — file path patterns for every layer (API, frontend features, pages, tools)
- **`domains`** — which content types belong to which area (e.g., `issues` → `["issue", "comment"]`)
- **`recipes`** — step-by-step for common change types (new endpoint, new page, new tool)
- **`conventions`** — naming, API patterns, state management

Use this to resolve the issue description into concrete file paths. For example:
- Issue mentions "issues list" → `domains.issues` + `paths.frontend-feature` → `web/src/features/issue/`
- Issue mentions "new API endpoint" → `recipes.new-endpoint` gives you the exact steps
- Issue mentions "agent tool" → `paths.agent-tools` → `strapi/src/services/agent/tools.ts`

## Step 2: Jump to the Affected Files

If knowledge.json gave you exact paths, read them directly. If you need to narrow further, use one targeted Glob or Grep:

```
Grep: "function name or component name from the issue"
```
or
```
Glob: packages/<package>/src/**/*<keyword>*
```

One search, not a browsing session.

## Step 2: Read the Affected Files

Read only the files that will change. For each file, focus on:
- The specific function/component mentioned in the issue
- Its dependencies (imports at the top)
- Its shape/pattern (so the plan can reference it)

Use offset/limit for large files — read the relevant section, not the whole thing.

## Step 3: Follow Dependencies (Only When Necessary)

Only trace dependencies if the change affects shared types or APIs:

- **Changing a type/interface?** → Grep for imports to find all consumers
- **Changing an API response?** → Find the frontend hook that calls it
- **Adding a new component?** → Check if a similar one exists to follow its pattern

Skip this step for isolated changes (bug fixes, style changes, config updates).

## Step 4: Check for Existing Patterns

Before proposing something new, check if the codebase already has a pattern for it:

```
Grep: "similar function or component name"
```

If 10 hooks follow the same shape, the plan should follow it too. If there's a utility for a common operation, reference it.

## Step 5: Find Test Patterns (If Relevant)

Only if the plan needs to include testing:

```
Glob: **/*.test.ts, **/*.spec.ts near the affected files
```

If no tests exist nearby, note that in the plan rather than spending tokens searching further.

## What NOT to Do

- **Don't read CLAUDE.md** — it's already in your context
- **Don't list directories to "understand the structure"** — you already know it
- **Don't read files "for context" that won't change** — if it's not in the plan, don't read it
- **Don't explore broadly then narrow down** — narrow from the start
- **Don't read entire files** — use Grep to find the exact function, then Read with offset/limit

## Package Quick Reference

This is already in CLAUDE.md but repeated here for convenience:

| Package | Path | Stack |
|---------|------|-------|
| Backend | `packages/core/src/` | Hono, Drizzle, REST, WebSocket |
| Cloud UI | `packages/web/src/` | Next.js 16, App Router |
| Desktop | `packages/dev/src/` | Tauri + React |

**Frontend patterns:** `src/app/` (pages) → `src/features/` or `components/` (UI) → `hooks/` (logic) → API calls
**Backend patterns:** `src/api/<type>/routes/` → `controllers/` → `services/` → `content-types/`
