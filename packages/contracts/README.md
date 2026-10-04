# @forge/contracts

Shared TypeScript types derived from [`@forge/core`](../core) — Drizzle row inferrals plus the `z.infer` of the request validators core uses at the HTTP boundary. The request shapes are exported as *types only* (no runtime Zod), so clients get the same compile-time contract without bundling core. The runtime exports are the modules `tsconfig.emit.json` lists and builds to `dist/` (the state machines, permissions, pipeline-registry, attachments, document-patch, ui-actions, wireframe, workflow-templates and the rest of that list) — each of which imports nothing from core.

The point: every client (`web-v2`, future SDKs) imports the *same* shapes core actually serves, instead of hand-rolling typings that drift.

## Install

Workspace-internal — already wired through pnpm's workspace protocol. To add it to a sibling package:

```json
{
  "dependencies": {
    "@forge/contracts": "workspace:*"
  }
}
```

## Usage

```ts
import type { Issue, Project, IssueCreateInput } from "@forge/contracts";
import { REGISTRY_JOB_TYPES } from "@forge/contracts";

// Row types — what core returns from SELECT.
const issue: Issue = await api.get(`/issues/${id}`);

// Request input types — compile-time shape of POST bodies, shared with core
// (these are `z.infer` of core's validators, exported as types — no runtime Zod).
const body: IssueCreateInput = { title: "add /api/foo" };
await api.post("/issues", body);

// Runtime values live in the emitted modules (pipeline-registry, ui-actions, wireframe, workflow-templates …).
const isJobType = (t: string) => (REGISTRY_JOB_TYPES as readonly string[]).includes(t);
```

## Layout

| File | Exports |
|---|---|
| [`src/rows.ts`](./src/rows.ts) | Row types inferred from Drizzle table schemas in `@forge/core` |
| [`src/requests.ts`](./src/requests.ts) | Request input types (`z.infer` of core's validators, re-exported as types — no runtime Zod) |
| [`src/responses.ts`](./src/responses.ts) | Response envelope shapes |
| [`src/integrations.ts`](./src/integrations.ts) | Cross-app integration types |
| [`src/notifications.ts`](./src/notifications.ts) | Notification types |
| [`src/pipeline-registry.ts`](./src/pipeline-registry.ts) | Pipeline-registry enum tuples (job types, priorities, complexities, run kinds) |
| [`src/workflow-templates.ts`](./src/workflow-templates.ts) | workflow-template-v1: the diagram-template meta-schema, the built-in registry (`BUILTIN_WORKFLOW_TEMPLATES`) and project-template resolution — runtime, read by core to check designs and by the web to draw them |
| [`src/issues.ts`](./src/issues.ts) | Release-notes types (`ReleaseNotes`, `ReleaseNotesSection`) re-exported from `src/release-notes.ts` |
| [`src/ssh-keys.ts`](./src/ssh-keys.ts) | Org Private Keys pool + per-project git-credential types |
| [`src/index.ts`](./src/index.ts) | Aggregated barrel |

## Why "type-only"

`@forge/contracts` depends on `@forge/core` to *read* its schemas, but its request inputs ship as types only (`z.infer`-derived, not runtime validators). Its runtime values are the emitted modules, which hardcode their own tuples rather than importing core. Web-v2 never bundles core code at runtime. Changing core handlers without changing schemas leaves contracts untouched — which is the desired property.

→ When core changes a row or request shape, add or update the export here and the consumer packages get TypeScript errors at the call sites that need updating. That's the contract.
