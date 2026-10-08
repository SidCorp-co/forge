import {
  type DataEgressRefusalCode,
  type EgressClass,
  SENSITIVE_DATA_DEFAULT,
  type SensitiveDataLevel,
} from '@forge/contracts/data-policy';
import type { ActorAgency } from '@forge/contracts/permissions';
import { redactionCount, scrubPersonalData } from '@forge/observability';
import { RefusalError } from './refusal.js';

// the one egress rule (decision on ISS-59, 2026-10-04): every read that hands content to an
// agent or a provider passes `egressDeep(project, surface)`, and each surface declares its class
// here, the one table. Product is written to build the product and an agent cannot build without
// it; operational is what people send in, where patient text arrives. A name missing here is
// refused, so a new surface cannot leak; the write side (`storedText`) scrubs on write
const EGRESS_SURFACES = {
  requirement: {
    class: 'product',
    holds: 'requirements: revisions, spec, business criteria, baselines, history',
  },
  design: { class: 'product', holds: 'workflow designs and their revisions' },
  issue: {
    class: 'product',
    holds: 'issues: title, description, plan, acceptance criteria, handoffs',
  },
  'issue.criteria': { class: 'product', holds: 'issue criteria and their verdicts' },
  'issue.comments': { class: 'product', holds: 'comments on an issue' },
  'issue.questions': {
    class: 'product',
    holds: "an agent's questions on an issue and the answers",
  },
  'onboarding.answers': {
    class: 'product',
    holds: 'onboarding questionnaires and their answers',
  },
  suggestion: { class: 'product', holds: 'suggestions on a requirement or an issue' },
  feedback: {
    class: 'operational',
    holds:
      'feedback items: title, body, where seen, answer, decision reasons, clarification, triage suggestions',
  },
  'feedback.attachments': { class: 'operational', holds: 'files attached to a feedback item' },
  // a mockup's bytes (an image, a sketch, an HTML page, a captured request) cannot be scrubbed
  // on write, and a screenshot of the running product is where patient data shows, so they are
  // operational on every target: withheld from every agent at no_egress, while the manifest (key,
  // kind, scrubbed name and caption, status) rides the target's own surface (decision on ISS-78)
  'mockup.content': {
    class: 'operational',
    holds: 'the bytes of a mockup on a requirement revision, a feedback item or an issue',
  },
  'feedback.comments': { class: 'operational', holds: 'comments on a feedback item' },
  conversation: {
    class: 'operational',
    holds:
      'assistant conversations with people: messages, room and page context, transcript passages',
  },
  'requirement.clarification': {
    class: 'operational',
    holds: "the BA assistant's questions to a person about a requirement, and the answers",
  },
  memory: {
    class: 'product',
    holds: 'project memory: entries and chunks drawn from issues, comments, jobs, notes, decisions',
  },
  knowledge: { class: 'product', holds: 'knowledge entries: title and body' },
  'agent-session': {
    class: 'product',
    holds: "a person's messages to a coding agent in an agent session",
  },
  // a share link open to anyone with its token takes the report out of the project for good, so
  // it is operational whatever the report holds: never created at no_egress, scrubbed at redact
  'report.share': {
    class: 'operational',
    holds: 'a frozen report answer opened through a share link by anyone holding its token',
  },
  // an execution hands its input frames to a sandbox the deployment enabled, which may be a third
  // party's, so it is operational whatever the frames hold: never sent at no_egress, scrubbed at redact
  'report.exec': {
    class: 'operational',
    holds: 'report frames handed to a sandbox executor as the input snapshot of a computation',
  },
} as const satisfies Record<string, { class: EgressClass; holds: string }>;

export type EgressSurface = keyof typeof EGRESS_SURFACES;

export interface EgressRefusal {
  code: DataEgressRefusalCode;
  path: string;
  detail: string;
}

export type EgressDeep<T> = { ok: true; value: T } | { ok: false; refusal: EgressRefusal };

export interface EgressReader {
  agency: ActorAgency;
  providerBound?: boolean | undefined;
}

export const MCP_DOOR = { providerBound: true } as const;

export function isProviderBound(reader: EgressReader): boolean {
  return reader.providerBound === true || reader.agency === 'agent';
}

/** A project's declared data policy, or undefined where its document sets none. */
type DataPolicySource = (projectId: string) => Promise<SensitiveDataLevel | undefined>;

let dataPolicySource: DataPolicySource | null = null;

/** The project-config domain hands the egress guard each project's policy; the process entry provides it at boot. */
export function provideDataPolicy(source: DataPolicySource): void {
  dataPolicySource = source;
}

export async function dataPolicyOf(projectId: string): Promise<SensitiveDataLevel> {
  if (!dataPolicySource) {
    throw new Error(
      "data egress: no data policy source was provided, so a project's policy cannot be read; the process entry calls provideDataPolicy with the project document reader before it serves",
    );
  }
  return (await dataPolicySource(projectId)) ?? SENSITIVE_DATA_DEFAULT;
}

export function storedText(level: SensitiveDataLevel, text: string) {
  if (level === 'off') return { text, redactions: 0, scrubbed: false };
  const scrub = scrubPersonalData(text);
  return { text: scrub.text, redactions: redactionCount(scrub.redactions), scrubbed: true };
}

/** A structured value as it is stored: every string scrubbed, ids, times and bare URLs kept, at any level but off. */
export function storedDeep<T>(level: SensitiveDataLevel, value: T): T {
  return level === 'off' ? value : (scrubDeep(value, { n: 0 }) as T);
}

export function storedAnswers<A extends { text?: string | undefined }>(
  level: SensitiveDataLevel,
  answers: readonly A[],
): A[] {
  return answers.map((a) =>
    a.text === undefined ? a : { ...a, text: storedText(level, a.text).text },
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;
const URL_ONLY = /^(?:data:|https?:\/\/)\S*$/;

function scrubDeep(v: unknown, counted: { n: number }): unknown {
  if (typeof v === 'string') {
    if (UUID.test(v) || ISO_TIME.test(v) || URL_ONLY.test(v)) return v;
    const scrub = scrubPersonalData(v);
    counted.n += redactionCount(scrub.redactions);
    return scrub.text;
  }
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, counted));
  if (v instanceof Date) return v;
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrubDeep(x, counted)]),
    );
  }
  return v;
}

function classOf(surface: string): EgressClass | null {
  return Object.hasOwn(EGRESS_SURFACES, surface)
    ? EGRESS_SURFACES[surface as EgressSurface].class
    : null;
}

// the one rule, at a level already read: an undeclared surface is refused by name at every
// level; operational content never leaves at no_egress and leaves scrubbed at redact; product content
// leaves exactly as stored at every level and is scrubbed once on write (`storedText`) — a read-side
// scrub breaks every expect-precondition write and rewrites lease places (HOP, 2026-10-04)
export function egressAt<T>(
  level: SensitiveDataLevel,
  surface: EgressSurface,
  value: T,
  what: string = surface,
): EgressDeep<T> {
  const cls = classOf(surface);
  if (cls === null) {
    return {
      ok: false,
      refusal: {
        code: 'EGRESS_SURFACE_UNDECLARED',
        path: '',
        detail: `${what} was read through surface "${surface}", which declares no class in lib/data-egress.ts:EGRESS_SURFACES; declare it product or operational before any agent reads it. Declared: ${Object.keys(EGRESS_SURFACES).join(', ')}.`,
      },
    };
  }
  if (cls === 'operational' && level === 'no_egress') {
    return {
      ok: false,
      refusal: {
        code: 'CONTENT_EGRESS_FORBIDDEN',
        path: '',
        detail: `${what} is ${surface} content (operational: ${EGRESS_SURFACES[surface].holds}) of a project whose sensitiveData is no_egress: it never reaches an agent or a provider, redacted or not. Only its metadata (key, kind, severity, status, links) may be read here.`,
      },
    };
  }
  if (level === 'off' || cls === 'product') return { ok: true, value };
  return { ok: true, value: scrubDeep(value, { n: 0 }) as T };
}

export function withheldAt(level: SensitiveDataLevel, surface: EgressSurface): boolean {
  return !egressAt(level, surface, '').ok;
}

export async function egressDeep<T>(
  projectId: string,
  surface: EgressSurface,
  value: T,
  what?: string,
): Promise<EgressDeep<T>> {
  return egressAt(await dataPolicyOf(projectId), surface, value, what);
}

export async function egressAs<T>(
  reader: EgressReader,
  projectId: string,
  surface: EgressSurface,
  value: T,
  what?: string,
): Promise<EgressDeep<T>> {
  if (!isProviderBound(reader)) return { ok: true, value };
  return egressDeep(projectId, surface, value, what);
}

export function egressReading(
  level: SensitiveDataLevel,
  reader: EgressReader,
  surface: EgressSurface,
) {
  const bound = isProviderBound(reader);
  const withhold = bound && withheldAt(level, surface);
  const shown = <T>(view: T, what: string): T => {
    if (!bound || withhold) return view;
    const out = egressAt(level, surface, view, what);
    if (!out.ok) throw new EgressRefused(out.refusal);
    return out.value;
  };
  return { withhold, shown };
}

export function egressText(
  level: SensitiveDataLevel,
  surface: EgressSurface,
  text: string,
  what?: string,
): { ok: true; text: string; redactions: number } | { ok: false; refusal: EgressRefusal } {
  const gate = egressAt(level, surface, '', what);
  if (!gate.ok) return gate;
  if (level === 'off' || classOf(surface) === 'product') return { ok: true, text, redactions: 0 };
  const counted = { n: 0 };
  return { ok: true, text: scrubDeep(text, counted) as string, redactions: counted.n };
}

export function egressOr<T, M extends object>(
  out: EgressDeep<T>,
  metadata: M,
): T | (M & { withheld: EgressRefusal }) {
  return out.ok ? out.value : { ...metadata, withheld: out.refusal };
}

export class EgressRefused extends Error {
  constructor(readonly refusal: EgressRefusal) {
    super(`${refusal.code}: ${refusal.detail}`);
    this.name = 'EgressRefused';
  }
}

export async function egressShown<T>(
  projectId: string,
  surface: EgressSurface,
  value: T,
  what?: string,
): Promise<T> {
  const out = await egressDeep(projectId, surface, value, what);
  if (!out.ok) throw new EgressRefused(out.refusal);
  return out.value;
}

export async function egressForRequest<T>(
  agency: ActorAgency | undefined,
  projectId: string,
  surface: EgressSurface,
  value: T,
  what?: string,
): Promise<T> {
  if (!agency)
    throw new Error(`data-egress: a ${surface} read reached its handler without an auth gate`);
  const out = await egressAs({ agency }, projectId, surface, value, what);
  if (out.ok) return out.value;
  throw new RefusalError([out.refusal], out.refusal.code);
}

type ProductSurface = {
  [K in EgressSurface]: (typeof EGRESS_SURFACES)[K]['class'] extends 'product' ? K : never;
}[EgressSurface];

/** What an LLM or embedding adapter needs to gate text: an operational surface must name its project or level. */
export type EgressScope =
  | { surface: ProductSurface; what?: string }
  | { surface: EgressSurface; projectId: string; what?: string }
  | { surface: EgressSurface; level: SensitiveDataLevel; what?: string };

/** `egressText` for a provider-bound adapter; reads the project's level only when the surface needs it. */
export async function egressScoped(
  scope: EgressScope,
  text: string,
): Promise<{ ok: true; text: string; redactions: number } | { ok: false; refusal: EgressRefusal }> {
  const what = scope.what ?? scope.surface;
  if ('level' in scope) return egressText(scope.level, scope.surface, text, what);
  if ('projectId' in scope) {
    return egressText(await dataPolicyOf(scope.projectId), scope.surface, text, what);
  }
  if (classOf(scope.surface) !== 'product') {
    throw new Error(
      `data-egress: ${what} is ${scope.surface} content, which is not product, and reached a provider adapter with no projectId or level to read its policy`,
    );
  }
  return { ok: true, text, redactions: 0 };
}
