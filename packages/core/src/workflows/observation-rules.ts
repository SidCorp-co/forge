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

/** An observation is read against the approved revision only (design-reconciliation `cited`). */
export function revisionRefusal(
  flow: string,
  asked: number | undefined,
  approved: number,
): ObservationRefusal | null {
  if (asked === undefined || asked === approved) return null;
  return {
    code: 'WORKFLOW_OBSERVATION_REVISION_NOT_APPROVED',
    path: '/revision',
    detail: `the observation is read against ${flow} r${asked}, and r${approved} is its approved revision; the code is observed against the approved revision only, so send revision ${approved} or leave it out.`,
  };
}

/** The repository files the observation cites, each once. */
export function citedFiles(write: WriteObservation): string[] {
  const files = new Set<string>();
  for (const n of [...write.steps, ...(write.edges ?? [])]) {
    if (n.evidence?.kind === 'repo') files.add(n.evidence.file);
  }
  return [...files];
}

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `symbol` is named in `text`: every dotted part of it, as a whole word. */
export function namesSymbol(text: string, symbol: string): boolean {
  return symbol
    .trim()
    .split('.')
    .filter((part) => part.length > 0)
    .every((part) => new RegExp(`(?<![A-Za-z0-9_$])${escaped(part)}(?![A-Za-z0-9_$])`).test(text));
}

/**
 * Every repo citation whose file is not at the commit, or whose symbol its file does not name.
 * `texts` holds each cited file's text at the commit, or why it is not there.
 */
export function missingCitationRefusals(
  write: WriteObservation,
  texts: ReadonlyMap<string, string | { missing: string }>,
): ObservationRefusal[] {
  const out: ObservationRefusal[] = [];
  const check = (what: string, path: string, c: Citation | null) => {
    if (c?.kind !== 'repo' || !c.symbol) return;
    const text = texts.get(c.file);
    if (text === undefined) return;
    if (typeof text !== 'string') {
      out.push({
        code: 'WORKFLOW_OBSERVATION_CITATION_MISSING',
        path: `${path}/evidence`,
        detail: `${what} cites ${c.file}:${c.symbol}, and ${text.missing}; cite a file and a symbol that exist at the commit read.`,
      });
    } else if (!namesSymbol(text, c.symbol)) {
      out.push({
        code: 'WORKFLOW_OBSERVATION_CITATION_MISSING',
        path: `${path}/evidence`,
        detail: `${what} cites ${c.file}:${c.symbol}, and ${c.file} at ${write.atSha.slice(0, 12)} names no ${c.symbol}; cite a symbol that exists at the commit read.`,
      });
    }
  };
  write.steps.forEach((s, i) => {
    check(`observed step "${s.id}"`, `/steps/${i}`, s.evidence);
  });
  (write.edges ?? []).forEach((e, i) => {
    check(`observed edge ${e.from}>${e.to}`, `/edges/${i}`, e.evidence);
  });
  return out;
}

export const commitOffBranchRefusal = (sha: string, branch: string): ObservationRefusal => ({
  code: 'WORKFLOW_OBSERVATION_COMMIT_OFF_BRANCH',
  path: '/atSha',
  detail: `commit ${sha} is not on ${branch}, the branch work lands on; observe a commit that landed there.`,
});

export const sourceUnreadableRefusal = (why: string): ObservationRefusal => ({
  code: 'WORKFLOW_OBSERVATION_SOURCE_UNREADABLE',
  path: '/atSha',
  detail: `the commit and its cited files cannot be checked, so nothing is stored: ${why}.`,
});
