import type { CodeTraceResponse, CodeTraceScope, CodeTraceUnit } from '@forge/contracts/modules';
import { Hono } from 'hono';
import declaration from './modules.json' with { type: 'json' };

const SECTIONS: Record<CodeTraceScope, 'modules' | 'web' | 'runner'> = {
  core: 'modules',
  web: 'web',
  runner: 'runner',
};

/**
 * The requirement trace this build declares (ISS-221). It describes the shipped source, not any
 * project's data, so it is served without a session, as the build's version is.
 */
export function codeTrace(): CodeTraceResponse {
  const units: CodeTraceUnit[] = [];
  for (const [scope, section] of Object.entries(SECTIONS) as [CodeTraceScope, string][]) {
    const declared = (
      declaration as unknown as Record<string, Record<string, { serves?: string[] }>>
    )[section];
    for (const [unit, spec] of Object.entries(declared ?? {}))
      units.push({ scope, unit, serves: spec.serves ?? [] });
  }
  return {
    units,
    total: units.length,
    untraced: units.filter((u) => u.serves.length === 0).length,
  };
}

export const codeTraceRoutes = new Hono();
codeTraceRoutes.get('/code-trace', (c) => c.json(codeTrace()));
