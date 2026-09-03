/**
 * The registry: every `forge-*` component, what it accepts, and the compact
 * text it projects to.
 *
 * This lives in core, NOT in `packages/contracts/src/body-components.ts` where
 * ISS-898's proposal put it. `contracts-runtime-boundary.test.ts` forbids core
 * from value-importing `@forge/contracts` — a type-only surface absent from
 * core's production image, so a value import compiles green and crashes at boot
 * (ISS-510). The dependency also runs contracts → core, not the reverse.
 * `@forge/contracts/body-components` re-exports the TYPES from here.
 */

import { z } from 'zod';
import type { BodyAttrs } from './parse.js';

export interface SlotSpec {
  component: string;
  /** Key it appears under in the parsed `slots` a downstream reader consumes. */
  key: string;
  repeat?: boolean;
  required?: boolean;
}

export interface ComponentView {
  name: string;
  attrs: BodyAttrs;
  /** Text of everything that is not a declared child component. */
  prose: string;
  slots: Record<string, ComponentView[]>;
}

export interface ComponentSpec {
  name: string;
  /** May stand at the top level of a body, and so may be a `template`. */
  root: boolean;
  // cm:why `leaf` is what lets `forge-diagram` and `forge-artifact` sit inside a prose slot without breaking Decision 5 — that decision forbids RECURSIVE components, and a component with no slots of its own opens no second level to recurse into
  leaf?: boolean;
  /** Content is lifted out as raw text before scanning (Decision 6). */
  raw?: boolean;
  attrs: z.ZodType;
  slots: readonly SlotSpec[];
  /** Declared slot order is enforced — the fixed-order issue shapes. */
  ordered?: boolean;
  // cm:guard `toText` belongs to the descriptor and NOT to a switch at the call site: four read paths project a body (prompt/user.ts, memory/indexer.ts, and both MCP serializers), and a second copy is how one of them drifts into embedding raw markup
  toText: (view: ComponentView) => string;
}

const noAttrs = z.object({}).strict();

function proseOf(view: ComponentView): string {
  return view.prose.trim();
}

function slotProse(view: ComponentView, key: string): string {
  return (view.slots[key] ?? [])
    .map((v) => proseOf(v))
    .filter(Boolean)
    .join('\n');
}

function labelled(label: string, value: string): string {
  return value ? `${label}: ${value}` : '';
}

function lines(...parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => Boolean(p && p.length > 0)).join('\n');
}

/** A child-only component whose whole content is prose. */
function proseBlock(name: string, attrs: z.ZodType = noAttrs): ComponentSpec {
  return { name, root: false, attrs, slots: [], toText: (v) => proseOf(v) };
}

function nestedText(view: ComponentView, key: string, component: string): string {
  const spec = SPEC_BY_NAME.get(component);
  if (!spec) return '';
  return (view.slots[key] ?? []).map((child) => spec.toText(child)).join('\n');
}

const SPECS: ComponentSpec[] = [
  {
    name: 'forge-triage',
    root: true,
    attrs: z
      .object({
        complexity: z.enum(['xs', 's', 'm', 'l', 'xl']),
        category: z.string().min(1).max(60),
        priority: z.enum(['low', 'medium', 'high', 'urgent']),
      })
      .strict(),
    slots: [{ component: 'forge-relations', key: 'relations' }],
    toText: (v) =>
      lines(
        `Triage: ${v.attrs.complexity} · ${v.attrs.category} · ${v.attrs.priority}`,
        proseOf(v),
        labelled('Relations', slotProse(v, 'relations')),
      ),
  },
  {
    name: 'forge-plan',
    root: true,
    attrs: z.object({ approval: z.enum(['auto', 'human']) }).strict(),
    slots: [{ component: 'forge-files', key: 'files' }],
    toText: (v) =>
      lines(
        `Plan (approval: ${v.attrs.approval})`,
        proseOf(v),
        labelled('Affected files', slotProse(v, 'files')),
      ),
  },
  {
    name: 'forge-review',
    root: true,
    attrs: z
      .object({
        sha: z.string().regex(/^[0-9a-f]{7,40}$/, 'a git sha, 7-40 lowercase hex characters'),
        verdict: z.enum(['approve', 'request-changes', 'abstain']),
      })
      .strict(),
    slots: [
      { component: 'forge-finding', key: 'findings', repeat: true },
      { component: 'forge-summary', key: 'summary', required: true },
    ],
    toText: (v) => {
      const findings = v.slots.findings ?? [];
      const counts = new Map<string, number>();
      for (const f of findings) {
        const severity = f.attrs.severity ?? 'finding';
        counts.set(severity, (counts.get(severity) ?? 0) + 1);
      }
      const tally = [...counts].map(([severity, n]) => `${n} ${severity}`).join(', ');
      const verdict = (v.attrs.verdict ?? '').toUpperCase();
      return lines(
        `Review ${v.attrs.sha}: ${verdict}${tally ? ` · ${tally}` : ''}`,
        nestedText(v, 'findings', 'forge-finding'),
        slotProse(v, 'summary'),
      );
    },
  },
  {
    name: 'forge-qa-report',
    root: true,
    attrs: z
      .object({
        verdict: z.enum(['pass', 'fail', 'blocked-fixture', 'verified-by-test']),
        env: z.string().min(1).max(120).optional(),
      })
      .strict(),
    slots: [
      { component: 'forge-case', key: 'cases', repeat: true },
      { component: 'forge-failure', key: 'failures', repeat: true },
    ],
    toText: (v) => {
      const cases = v.slots.cases ?? [];
      const passed = cases.filter((c) => c.attrs.verdict === 'pass').length;
      const env = v.attrs.env ? ` on ${v.attrs.env}` : '';
      const ratio = cases.length > 0 ? ` · ${passed}/${cases.length} pass` : '';
      return lines(
        `QA ${(v.attrs.verdict ?? '').toUpperCase()}${env}${ratio}`,
        nestedText(v, 'cases', 'forge-case'),
        nestedText(v, 'failures', 'forge-failure'),
        proseOf(v),
      );
    },
  },
  {
    name: 'forge-outcome',
    root: true,
    attrs: z.object({ kind: z.enum(['done', 'changed', 'note']) }).strict(),
    slots: [{ component: 'forge-extra-fix', key: 'extraFixes', repeat: true }],
    toText: (v) =>
      lines(
        `Outcome: ${v.attrs.kind}`,
        proseOf(v),
        (v.slots.extraFixes ?? []).length > 0 ? 'Extra fixes:' : '',
        nestedText(v, 'extraFixes', 'forge-extra-fix'),
      ),
  },
  {
    name: 'forge-blocked',
    root: true,
    attrs: z.object({ on: z.enum(['decision', 'resource', 'person']) }).strict(),
    slots: [],
    toText: (v) => lines(`Blocked on a ${v.attrs.on}`, proseOf(v)),
  },
  {
    name: 'forge-close',
    root: true,
    attrs: z
      .object({
        branch: z.string().min(1).max(200),
        deploy: z.enum(['ok', 'skipped', 'failed']),
      })
      .strict(),
    slots: [],
    toText: (v) => lines(`Closed · ${v.attrs.branch} · deploy ${v.attrs.deploy}`, proseOf(v)),
  },
  {
    name: 'forge-symptom',
    root: true,
    ordered: true,
    attrs: noAttrs,
    slots: [
      { component: 'forge-opening', key: 'opening', required: true },
      { component: 'forge-evidence', key: 'evidence' },
    ],
    toText: (v) =>
      lines(
        slotProse(v, 'opening'),
        proseOf(v),
        labelled('Evidence', nestedText(v, 'evidence', 'forge-evidence')),
      ),
  },
  {
    name: 'forge-problem',
    root: true,
    ordered: true,
    attrs: noAttrs,
    slots: [
      { component: 'forge-opening', key: 'opening', required: true },
      { component: 'forge-who', key: 'who', required: true },
      { component: 'forge-diagram', key: 'diagram', required: true },
      { component: 'forge-todo', key: 'todo', required: true },
      { component: 'forge-decision', key: 'decisions', repeat: true },
      { component: 'forge-evidence', key: 'evidence', required: true },
    ],
    toText: (v) =>
      lines(
        slotProse(v, 'opening'),
        labelled('Who it hurts', slotProse(v, 'who')),
        nestedText(v, 'diagram', 'forge-diagram'),
        labelled('What to do', slotProse(v, 'todo')),
        labelled('Decisions', slotProse(v, 'decisions')),
        labelled('Evidence', nestedText(v, 'evidence', 'forge-evidence')),
      ),
  },
  {
    name: 'forge-evidence',
    root: false,
    attrs: noAttrs,
    slots: [{ component: 'forge-row', key: 'rows', repeat: true }],
    toText: (v) => lines(proseOf(v), nestedText(v, 'rows', 'forge-row')),
  },
  {
    name: 'forge-row',
    root: false,
    attrs: z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'an ISO date, YYYY-MM-DD'),
        measured: z.string().min(1).max(400),
        source: z.string().min(1).max(400),
      })
      .strict(),
    slots: [],
    toText: (v) => `- ${v.attrs.date} · ${v.attrs.measured} · ${v.attrs.source}`,
  },
  // cm:edge contract -> packages/core/src/body/parse.ts — `raw: true` here and membership of `RAW_TEXT_ELEMENTS` there are one fact read by two halves (validator vs scanner). A component raw in one and structured in the other loses its content silently, which for a mermaid body means a blank diagram rather than an error.
  {
    name: 'forge-diagram',
    root: true,
    leaf: true,
    raw: true,
    attrs: z.object({ kind: z.enum(['mermaid']) }).strict(),
    slots: [],
    toText: (v) => `\`\`\`${v.attrs.kind}\n${v.prose.trim()}\n\`\`\``,
  },
  {
    name: 'forge-artifact',
    root: true,
    leaf: true,
    attrs: z.object({ id: z.uuid() }).strict(),
    slots: [],
    toText: (v) => `[attachment ${v.attrs.id}]`,
  },
  {
    name: 'forge-finding',
    root: false,
    attrs: z
      .object({
        file: z.string().min(1).max(400),
        line: z.string().regex(/^\d+$/, 'a line number').optional(),
        severity: z.enum(['bug', 'risk', 'nit', 'question']),
      })
      .strict(),
    slots: [],
    toText: (v) =>
      `- ${v.attrs.severity} ${v.attrs.file}${v.attrs.line ? `:${v.attrs.line}` : ''} — ${proseOf(v)}`,
  },
  proseBlock('forge-summary'),
  {
    name: 'forge-case',
    root: false,
    attrs: z
      .object({
        id: z.string().min(1).max(80).optional(),
        verdict: z.enum(['pass', 'fail', 'skip']),
      })
      .strict(),
    slots: [],
    toText: (v) => `- ${v.attrs.id ? `${v.attrs.id} ` : ''}${v.attrs.verdict}: ${proseOf(v)}`,
  },
  {
    name: 'forge-failure',
    root: false,
    attrs: z.object({ case: z.string().min(1).max(80).optional() }).strict(),
    slots: [],
    toText: (v) => `! ${v.attrs.case ? `${v.attrs.case}: ` : ''}${proseOf(v)}`,
  },
  {
    name: 'forge-extra-fix',
    root: false,
    attrs: z.object({ file: z.string().min(1).max(400).optional() }).strict(),
    slots: [],
    toText: (v) => `- ${v.attrs.file ? `${v.attrs.file} — ` : ''}${proseOf(v)}`,
  },
  proseBlock('forge-opening'),
  proseBlock('forge-who'),
  proseBlock('forge-todo'),
  proseBlock('forge-decision'),
  proseBlock('forge-relations'),
  proseBlock('forge-files'),
];

export const SPEC_BY_NAME: ReadonlyMap<string, ComponentSpec> = new Map(
  SPECS.map((s) => [s.name, s]),
);

export const COMPONENT_NAMES: readonly string[] = SPECS.map((s) => s.name);

export const ROOT_COMPONENT_NAMES: readonly string[] = SPECS.filter((s) => s.root).map(
  (s) => s.name,
);

export function specFor(name: string): ComponentSpec | undefined {
  return SPEC_BY_NAME.get(name);
}

export function isComponentName(name: string): boolean {
  return name.startsWith('forge-');
}
