// The body type surface a client needs to render one.
//
// The scanner and the sanitizer are NOT here, and the proposal that put them
// here was wrong about the direction of the dependency: `@forge/contracts`
// depends on `@forge/core` (not the reverse) and is a type-only surface absent
// from core's production image, so runtime code cannot live here —
// `packages/core/src/contracts-runtime-boundary.test.ts` is the gate that says
// so, and ISS-510 is what happens when it is ignored.
//
// The `forge-*` component vocabulary this file also carried was removed on
// 2026-09-14; `format: 'html'` now means sanitized plain HTML and nothing more.

import type { BodyFormat, BodyNode } from '@forge/core/public';

export type { BodyFormat, BodyNode };

/** What a REST or MCP read hands back for a body. */
export interface ParsedBody {
  body: string;
  format: BodyFormat;
  /** The compact text projection — what an agent should reason over. */
  text: string | null;
}

/** A body's node tree, as `GET /api/issues/:id` and the comment tree hand it back. */
export interface RenderedBody {
  format: BodyFormat;
  /** `null` for a markdown body and for one this build's scanner cannot read. */
  nodes: BodyNode[] | null;
}
