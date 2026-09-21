import type { BodyFormat, BodyNode } from '@forge/core/public';

export type { BodyFormat, BodyNode };

export interface ParsedBody {
  body: string;
  format: BodyFormat;
  text: string | null;
}

export interface RenderedBody {
  format: BodyFormat;
  /** `null` for a markdown body and for one this build's scanner cannot read. */
  nodes: BodyNode[] | null;
}
