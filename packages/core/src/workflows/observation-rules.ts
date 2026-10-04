/**
 * The write check on an observation (design-reconciliation `cited`): every observed node and edge
 * cites a file and a symbol (or its storefront artefact), each matches a planned step or none, and
 * a refused observation is never partly kept.
 */

import type { ObservationRefusalCode } from '@forge/contracts/workflow-health';
import type { Citation, WriteObservation } from './observation-schema.js';
import type { EvidenceSource } from './rules.js';

export interface ObservationRefusal {
  code: ObservationRefusalCode;
  path: string;
  detail: string;
}

/** A symbol that is a line number, or a file path carrying one, names a place that moves. */
const LINE_SYMBOL = /^(L?\d+(-\d+)?|line\s*\d+)$/i;
const LINE_IN_FILE = /:\d+(:\d+)?$/;

function citationRefusal(
  what: string,
  path: string,
  c: Citation | null,
  source: EvidenceSource,
): ObservationRefusal | null {
  const uncited = (why: string): ObservationRefusal => ({
    code: 'WORKFLOW_OBSERVATION_UNCITED',
    path: `${path}/evidence`,
    detail: `${what} ${why}; every observed node and edge cites the code it was read from as { kind: "repo", file, symbol } (file.ts:symbol, never a line number), or its storefront artefact.`,
  });
  if (!c) return uncited('cites nothing');
  if (
    c.kind !== source.kind ||
    (c.kind === 'storefront' && source.kind === 'storefront' && c.provider !== source.provider)
  ) {
    return {
      code: 'WORKFLOW_OBSERVATION_CITATION_KIND_MISMATCH',
      path: `${path}/evidence`,
      detail: `${what} cites ${c.kind === 'repo' ? 'a repository file' : `a ${c.provider} artefact`}; this project's source is ${source.kind === 'storefront' ? `a ${source.provider} storefront` : 'a repository'}.`,
    };
  }
  if (c.kind === 'storefront') return null;
  if (LINE_IN_FILE.test(c.file)) return uncited(`names a line in its file (${c.file})`);
  if (!c.symbol) return uncited(`names the file ${c.file} and no symbol in it`);
  if (LINE_SYMBOL.test(c.symbol.trim()))
    return uncited(`names line ${c.symbol} in place of a symbol`);
  return null;
}

export function observationRefusals(input: {
  write: WriteObservation;
  planned: ReadonlySet<string>;
  revision: number;
  flow: string;
  source: EvidenceSource;
}): ObservationRefusal[] {
  const { write, planned, revision, flow, source } = input;
  const out: ObservationRefusal[] = [];
  const ids = new Set<string>();
  const matchedBy = new Map<string, string>();
  write.steps.forEach((s, i) => {
    const at = `/steps/${i}`;
    if (ids.has(s.id)) {
      out.push({
        code: 'WORKFLOW_OBSERVATION_STEP_DUPLICATE',
        path: `${at}/id`,
        detail: `observed step "${s.id}" is drawn twice; an observed id is unique, as a design step's is.`,
      });
    }
    ids.add(s.id);
    if (s.matches !== null) {
      if (!planned.has(s.matches)) {
        out.push({
          code: 'WORKFLOW_OBSERVATION_MATCH_UNKNOWN',
          path: `${at}/matches`,
          detail: `observed step "${s.id}" matches "${s.matches}", which ${flow} r${revision} does not hold; name a planned step of that revision, or null for code the design does not hold.`,
        });
      } else if (matchedBy.has(s.matches)) {
        out.push({
          code: 'WORKFLOW_OBSERVATION_MATCH_DUPLICATE',
          path: `${at}/matches`,
          detail: `observed steps "${matchedBy.get(s.matches)}" and "${s.id}" both match planned step "${s.matches}"; one observed step is one planned step, so draw the code once or match the second to none.`,
        });
      } else matchedBy.set(s.matches, s.id);
    }
    const c = citationRefusal(`observed step "${s.id}"`, at, s.evidence, source);
    if (c) out.push(c);
  });
  (write.edges ?? []).forEach((e, i) => {
    const at = `/edges/${i}`;
    for (const end of [e.from, e.to]) {
      if (!ids.has(end)) {
        out.push({
          code: 'WORKFLOW_OBSERVATION_EDGE_DANGLING',
          path: at,
          detail: `observed edge ${e.from}>${e.to} names "${end}", which is no observed step.`,
        });
      }
    }
    const c = citationRefusal(`observed edge ${e.from}>${e.to}`, at, e.evidence, source);
    if (c) out.push(c);
  });
  (write.drift?.steps ?? []).forEach((id, j) => {
    if (!ids.has(id)) {
      out.push({
        code: 'WORKFLOW_OBSERVATION_DRIFT_UNKNOWN',
        path: `/drift/steps/${j}`,
        detail: `drift names "${id}", which is no observed step.`,
      });
    }
  });
  return out;
}
