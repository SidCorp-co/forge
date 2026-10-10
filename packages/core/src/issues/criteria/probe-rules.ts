/**
 * The kept-probe rules (REQ-36 BC-6, BC-13; ISS-469), pure: what a verdict's probe is refused for,
 * and which probe a verdict rests on. A probe is evidence, so it is kernel input: a credential in
 * it is refused at its path through the one secret detector (`@forge/observability:containsSecret`),
 * and the value is never echoed back. Storing a probe never runs it. `probes.ts` reads and writes
 * around these.
 *
 *   rule                                                          code
 *   a probe carries no credential, and no header that holds one   VERDICT_PROBE_SECRET
 *   a code property keeps no probe of the running build           VERDICT_PROBE_CODE_PROPERTY
 *   a pass or short on an observable criterion rests on a probe   VERDICT_PROBE_REQUIRED
 *   a request names the origin that answers its path               VERDICT_PROBE_ROUTE
 *
 * A criterion no design classes owes no probe: the verdict's record says so (`probeNote`), so the
 * exemption is read on every verdict it covers rather than assumed.
 */

import {
  type CriterionProbe,
  type ProbeRefusalCode,
  type ProbeRouting,
  probeRouteFault,
} from '@forge/contracts/criterion-probes';
import type { CriterionClass } from '@forge/contracts/issue-design';
import { verdictEarns, verdictExercised } from '@forge/contracts/verdict-identity';
import { containsSecret } from '@forge/observability';
import { jsonPointer } from '../../lib/refusal.js';

export interface ProbeRefusal {
  readonly code: ProbeRefusalCode;
  readonly path: string;
  readonly detail: string;
}

const SECRET_VALUE =
  'this is shaped like a credential (a token, key, password or signed URL), and a probe stores none. The value is not echoed back';

const secretHeader = (name: string) =>
  `header \`${name}\` carries a credential, and a probe stores none. Leave it out and send \`as: "replayer"\`: whoever replays the probe attaches its own`;

function stringsIn(value: unknown, at: readonly (string | number)[]): [string, string][] {
  if (typeof value === 'string') return [[jsonPointer(at), value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringsIn(v, [...at, i]));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => stringsIn(v, [...at, k]));
  }
  return [];
}

/** Each place `probe` holds a credential, at its JSON pointer under `/probe`. */
export function probeSecretRefusals(probe: CriterionProbe): ProbeRefusal[] {
  const out: ProbeRefusal[] = [];
  const headers = probe.kind === 'request' ? (probe.request.headers ?? {}) : {};
  for (const [name, value] of Object.entries(headers)) {
    if (!containsSecret(`${name}: ${value}`)) continue;
    out.push({
      code: 'VERDICT_PROBE_SECRET',
      path: jsonPointer(['probe', 'request', 'headers', name]),
      detail: secretHeader(name),
    });
  }
  // a header's value is read with its name above, so `Authorization` is refused whatever it holds
  const headersAt = `${jsonPointer(['probe', 'request', 'headers'])}/`;
  for (const [path, value] of stringsIn(probe, ['probe'])) {
    if (path.startsWith(headersAt) || !containsSecret(value)) continue;
    out.push({ code: 'VERDICT_PROBE_SECRET', path, detail: SECRET_VALUE });
  }
  return out;
}

/**
 * The refusal for a request the production origin it resolves to would not answer, or null: a
 * deploy's replay sends it to the environment's `url`, or to the service it names (ISS-470), so a
 * path another origin answers would fail there and reopen an issue that holds.
 */
export function probeRouteRefusal(
  probe: CriterionProbe,
  routing: ProbeRouting,
): ProbeRefusal | null {
  if (probe.kind !== 'request') return null;
  const fault = probeRouteFault(probe.request, routing);
  if (fault === null) return null;
  const at =
    probe.request.service === undefined
      ? ['probe', 'request', 'path']
      : ['probe', 'request', 'service'];
  return { code: 'VERDICT_PROBE_ROUTE', path: jsonPointer(at), detail: fault };
}

export interface ProbeFacts {
  readonly criterion: number;
  /** The class the issue's design gives the criterion, or null where no design classes it. */
  readonly criterionClass: CriterionClass | null;
  readonly verdict: string;
  /** Whether this verdict sends a probe. */
  readonly sent: boolean;
  /** Whether the criterion already keeps one. */
  readonly kept: boolean;
}

/** Why this verdict's probe, or its lack of one, is refused; null where it may be written. */
export function probeRuleFault(facts: ProbeFacts): ProbeRefusal | null {
  const { criterion, criterionClass, verdict, sent, kept } = facts;
  if (sent && criterionClass === 'code_property') {
    return {
      code: 'VERDICT_PROBE_CODE_PROPERTY',
      path: '/probe',
      detail: `criterion ${criterion} is a code property in the issue's design: the review judges it against the diff, so it keeps no probe of the running build. Leave \`probe\` out, or reclass it (PUT /api/issues/:id/design)`,
    };
  }
  if (criterionClass === 'observable' && verdictEarns(verdict) && !sent && !kept) {
    return {
      code: 'VERDICT_PROBE_REQUIRED',
      path: '/probe',
      detail: `criterion ${criterion} is observable on the running build, and a \`${verdict}\` on it rests on a kept probe; none was sent and none is kept on it. Send \`probe\` with the verdict (POST /api/issues/:id/verdicts)`,
    };
  }
  return null;
}

/** Whether a verdict that sends no probe rests on the criterion's kept one. */
export function restsOnKept(verdict: string): boolean {
  return verdictExercised(verdict);
}

/**
 * What the verdict's kernel record says about its probe: the one it rests on, or, for a pass or
 * short that owes none, the rule that exempts it. Null where there is nothing to say.
 */
export function probeNote(
  verdict: string,
  criterionClass: CriterionClass | null,
  probeId: string | null,
): string | null {
  if (probeId) return probeId;
  if (!verdictEarns(verdict)) return null;
  return criterionClass === 'code_property'
    ? 'not owed: a code property is judged against the diff'
    : criterionClass === null
      ? 'not owed: no design classes this criterion'
      : null;
}
