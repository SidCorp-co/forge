// ISS-898 — the body-component type surface a client needs to render one.
//
// The registry itself is NOT here, and the proposal that put it here was wrong
// about the direction of the dependency: `@forge/contracts` depends on
// `@forge/core` (not the reverse) and is a type-only surface absent from core's
// production image, so a registry with a runtime `toText()` cannot live here —
// `packages/core/src/contracts-runtime-boundary.test.ts` is the gate that says
// so, and ISS-510 is what happens when it is ignored.
//
// The registry lives at `packages/core/src/body/`. This file re-exports its
// types, plus the format union, so web and the runner can type a body without a
// runtime edge.

import type { BodyFormat, ComponentSpec, ComponentView } from '@forge/core/public';

export type { BodyFormat, ComponentSpec, ComponentView };

/** What a REST or MCP read hands back for a component body. */
export interface ParsedBody {
  body: string;
  format: BodyFormat;
  /** Root component name, or null for prose and for every markdown row. */
  template: string | null;
  /** Attributes and child slots of the root component, keyed by slot name. */
  slots: Record<string, unknown> | null;
  /** The compact text projection — what an agent should reason over. */
  text: string | null;
}
