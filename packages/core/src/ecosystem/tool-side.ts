import { HTTPException } from 'hono/http-exception';
import { RefusalError } from '../lib/refusal.js';
import { type McpContext, patEffectiveProjectIds } from '../lib/tool.js';
import { findProjectIdBySlug } from '../projects/index.js';
import type { EcosystemRefusal, EcosystemRefusalCode } from './refusals.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The codes one ecosystem tool refuses an unresolvable side with, so each tool's refusals stay its own. */
export interface SideCodes {
  invalid: EcosystemRefusalCode;
  unbound: EcosystemRefusalCode;
  unnamed: EcosystemRefusalCode;
  outside: EcosystemRefusalCode;
}

export type Side = { ok: true; side: string } | { ok: false; refusal: EcosystemRefusal };

const no = (code: EcosystemRefusalCode, path: string, detail: string): Side => ({
  ok: false,
  refusal: { code, path, detail },
});

// the ecosystem tools serve both doors, so the side is the one thing they name differently: a chat turn is bound to the project it answers and the adapter pins it, while an /mcp caller names it, holds a token bound to one, or sends the slug header; a call naming none is refused, never guessed, and a side outside the token's fence is refused before anything is read
export async function sideOf(ctx: McpContext, named: unknown, codes: SideCodes): Promise<Side> {
  const side = await namedSide(ctx, named, codes);
  if (!side.ok) return side;
  const fence = patEffectiveProjectIds(ctx.principal);
  if (fence !== null && !fence.includes(side.side)) {
    return no(
      codes.outside,
      '/projectId',
      `the token this call runs under reaches ${fence.join(', ')}, not project ${side.side}, so nothing of it is read or written`,
    );
  }
  return side;
}

async function namedSide(ctx: McpContext, named: unknown, codes: SideCodes): Promise<Side> {
  if (named !== undefined) {
    if (typeof named === 'string' && UUID.test(named)) return { ok: true, side: named };
    return no(codes.invalid, '/projectId', 'projectId is a project uuid');
  }
  if (ctx.boundProjectId) return { ok: true, side: ctx.boundProjectId };
  if (ctx.turn !== undefined || ctx.turnToken !== undefined) {
    return no(
      codes.unbound,
      '/',
      'this turn answers under no project, so there is no side to act for',
    );
  }
  if (ctx.projectSlug) {
    const id = await findProjectIdBySlug(ctx.projectSlug);
    if (id) return { ok: true, side: id };
    return no(
      codes.unnamed,
      '/projectId',
      `no project has the slug ${ctx.projectSlug} that X-Forge-Project-Slug names`,
    );
  }
  return no(
    codes.unnamed,
    '/projectId',
    'this call names no project: pass projectId, send X-Forge-Project-Slug, or use a token bound to one project',
  );
}

// a service that refuses by name throws the refusal it decided, and it reaches the caller under that code; only a bare not-found or forbidden is left for the tool to name
export function namedRefusals(err: unknown): EcosystemRefusal[] | null {
  if (err instanceof RefusalError) return err.refusals as EcosystemRefusal[];
  if (!(err instanceof HTTPException)) return null;
  const cause = err.cause as { details?: { refusals?: unknown } } | undefined;
  const refusals = cause?.details?.refusals;
  return Array.isArray(refusals) && refusals.length > 0 ? (refusals as EcosystemRefusal[]) : null;
}
