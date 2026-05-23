// ISS-199 — typed release-notes shape per issue. The zod schema + the
// canonical type definitions live in `@forge/core/src/issues/release-notes.ts`
// alongside the Drizzle column. Only the *types* are re-exported here, with
// `export type` so cross-app clients (`@forge/web`, the dev desktop) never
// pull in `@forge/core`'s runtime bundle through `@forge/contracts`. The
// zod schema stays in core because the validators that consume it (REST
// PATCH + the MCP forge_issues tool) also live in core.

export type { ReleaseNotes, ReleaseNotesSection } from '@forge/core/public';
