# @forge/contracts

Shared TypeScript types derived from [`@forge/core`](../core) — Drizzle row inferrals plus the `z.infer` of the request validators core uses at the HTTP boundary. The request shapes are exported as *types only* (no runtime Zod), so clients get the same compile-time contract without bundling core. The one runtime export is the pipeline-registry response schema. Type-only surface, no runtime coupling beyond imports.

The point: every client (`web-v2`, `dev`, future SDKs) imports the *same* shapes core actually serves, instead of hand-rolling typings that drift.

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
import { pipelineRegistryResponseSchema } from "@forge/contracts";

// Row types — what core returns from SELECT.
const issue: Issue = await api.get(`/issues/${id}`);

// Request input types — compile-time shape of POST bodies, shared with core
// (these are `z.infer` of core's validators, exported as types — no runtime Zod).
const body: IssueCreateInput = { title: "add /api/foo" };
await api.post("/issues", body);

// Runtime Zod lives only on the pipeline-registry response.
const registry = pipelineRegistryResponseSchema.parse(await api.get("/pipeline/registry"));
```

## Layout

| File | Exports |
|---|---|
| [`src/rows.ts`](./src/rows.ts) | Row types inferred from Drizzle table schemas in `@forge/core` |
| [`src/requests.ts`](./src/requests.ts) | Request input types (`z.infer` of core's validators, re-exported as types — no runtime Zod) |
| [`src/responses.ts`](./src/responses.ts) | Response envelope shapes |
| [`src/domain-templates.ts`](./src/domain-templates.ts) | Reusable domain literal templates (status enums, etc.) |
| [`src/integrations.ts`](./src/integrations.ts) | Cross-app integration types |
| [`src/memory.ts`](./src/memory.ts) | Memory / knowledge types |
| [`src/notifications.ts`](./src/notifications.ts) | Notification types |
| [`src/skill-facts.ts`](./src/skill-facts.ts) | Skill-facts types |
| [`src/pipeline-registry.ts`](./src/pipeline-registry.ts) | Pipeline-registry response — the one runtime Zod schema (`pipelineRegistryResponseSchema`, `pipelineStepSchema`) plus enum tuples |
| [`src/issues.ts`](./src/issues.ts) | Release-notes types (`ReleaseNotes`, `ReleaseNotesSection`) re-exported from core |
| [`src/index.ts`](./src/index.ts) | Aggregated barrel |

## Why "type-only"

`@forge/contracts` depends on `@forge/core` to *read* its schemas, but ships only types (request inputs are `z.infer`-derived, not runtime validators). The sole runtime value is the pipeline-registry schema, which hardcodes its own enum tuples rather than importing core. Web-v2/dev never bundle core code at runtime. Changing core handlers without changing schemas leaves contracts untouched — which is the desired property.

→ When core changes a row or request shape, add or update the export here and the consumer packages get TypeScript errors at the call sites that need updating. That's the contract.
