/**
 * What a template holds a placed, ordered design to beyond its fields: the shape its node types
 * declare (entry types, how many of each, the lines each owes, the values no two share) and the
 * rules it switches on. Each refusal names the type or rule and the template that declares it.
 */

import {
  bandOfNode,
  type TemplateRule,
  type WorkflowTemplate,
} from '@forge/contracts/workflow-templates';
import { jsonPointer as pointer } from '../lib/refusal.js';
import { designLines, nodeOf } from './edges.js';
import type { WorkflowRefusal } from './rules.js';
import type { WorkflowWriteV2 } from './schema.js';

const name = (t: WorkflowTemplate) => `template ${t.id}@${t.version}`;

/** The node types' own shape: entry types, counts, the lines each owes, and unique fields. */
export function structureRefusals(doc: WorkflowWriteV2, t: WorkflowTemplate): WorkflowRefusal[] {
  const out: WorkflowRefusal[] = [];
  const typed = doc.steps.map((s, i) => ({ s, i, node: nodeOf(s, t) }));
  const entries = t.nodeTypes.filter((n) => n.entry).map((n) => n.id);
  if (entries.length > 0) {
    for (const { s, i, node } of typed) {
      if (s.after.length > 0 || !node || entries.includes(node.type)) continue;
      out.push({
        code: 'WORKFLOW_NODE_NOT_ENTRY',
        path: pointer(['steps', i, 'after']),
        detail: `${node.type} step "${s.id}" comes after nothing, and in ${name(t)} only a ${entries.join(' or ')} starts the flow; every other step is reached from one. List what "${s.id}" comes after in its \`after\`.`,
      });
    }
  }
  const lines = designLines(doc, t);
  for (const type of t.nodeTypes) {
    const steps = typed.filter((x) => x.node?.type === type.id);
    const { min, max } = type.count ?? {};
    if ((min !== undefined && steps.length < min) || (max !== undefined && steps.length > max))
      out.push({
        code: 'WORKFLOW_NODE_TYPE_COUNT',
        path: '/steps',
        detail: `${name(t)} holds a design to ${min === max ? `exactly ${min}` : [min !== undefined ? `at least ${min}` : '', max !== undefined ? `at most ${max}` : ''].filter(Boolean).join(' and ')} ${type.id} steps, and this one has ${steps.length}${steps.length ? ` (${steps.map((x) => x.s.id).join(', ')})` : ''}.`,
      });
    for (const { s, i } of steps) {
      for (const side of ['in', 'out'] as const) {
        for (const rule of type.lines?.[side] ?? []) {
          const n = lines.filter(
            (l) =>
              (side === 'in' ? l.to : l.from) === s.id &&
              (rule.kind === undefined || l.kind === rule.kind),
          ).length;
          if (n >= rule.min && (rule.max === undefined || n <= rule.max)) continue;
          const what = rule.kind ? `${rule.kind} lines` : 'lines';
          const bound =
            rule.max === rule.min
              ? `exactly ${rule.min}`
              : n < rule.min
                ? `at least ${rule.min}`
                : `at most ${rule.max}`;
          out.push({
            code: 'WORKFLOW_NODE_LINES',
            path: pointer(['steps', i]),
            detail: `${type.id} step "${s.id}" has ${n} ${side === 'in' ? 'incoming' : 'outgoing'} ${what}, and ${name(t)} gives a ${type.id} ${bound}: ${type.tooltip}`,
          });
        }
      }
    }
    for (const field of type.unique ?? []) {
      const seen = new Map<string, string>();
      for (const { s, i, node } of steps) {
        const value = node?.[field];
        if (typeof value !== 'string') continue;
        const first = seen.get(value);
        if (first)
          out.push({
            code: 'WORKFLOW_NODE_FIELD_NOT_UNIQUE',
            path: pointer(['steps', i, 'node', field]),
            detail: `${type.id} steps "${first}" and "${s.id}" share ${field} "${value}"; in ${name(t)} no two ${type.id} steps share a ${field}.`,
          });
        else seen.set(value, s.id);
      }
    }
  }
  return out;
}

const SCREEN_STATES = ['empty', 'loading', 'error'] as const;

/** The rules the template switches on, each implemented here once. */
interface RuleCtx {
  doc: WorkflowWriteV2;
  t: WorkflowTemplate;
  nodes: ReturnType<typeof nodeOf>[];
  broken: (path: string, detail: string) => void;
}

const RULE_CHECKS: Partial<Record<TemplateRule, (c: RuleCtx) => void>> = {
  'single-entry': ({ doc, broken }) => {
    const roots = doc.steps.filter((s) => s.after.length === 0).map((s) => s.id);
    if (roots.length !== 1)
      broken(
        '/steps',
        `exactly one step comes after nothing, and ${roots.length === 0 ? 'none does' : `${roots.join(', ')} do`}.`,
      );
  },
  tree: ({ doc, broken }) => {
    doc.steps.forEach((s, i) => {
      if (s.after.length > 1)
        broken(
          pointer(['steps', i, 'after']),
          `"${s.id}" comes after ${s.after.join(', ')}; in a tree every step has one parent.`,
        );
    });
  },
  'screen-states': ({ doc, t, nodes, broken }) => {
    const lines = designLines(doc, t);
    doc.steps.forEach((s, i) => {
      const node = nodes[i];
      if (node?.type !== 'SCREEN' || !node.dataShown?.length) return;
      const shown = new Set(
        lines
          .filter((l) => l.from === s.id && l.kind === 'shows')
          .map((l) => nodes[doc.steps.findIndex((x) => x.id === l.to)]?.variant),
      );
      const lacking = SCREEN_STATES.filter((v) => !shown.has(v));
      if (lacking.length > 0)
        broken(
          pointer(['steps', i]),
          `screen "${s.id}" shows data (${node.dataShown.join(', ')}) and draws no ${lacking.join(', ')} state; add a UI_STATE of each variant and a \`shows\` line to it from "${s.id}".`,
        );
    });
  },
  'personas-declared': ({ doc, nodes, broken }) => {
    const declared = new Set((doc.personas ?? []).map((p) => p.id));
    doc.steps.forEach((s, i) => {
      const persona = nodes[i]?.persona;
      if (persona !== undefined && !declared.has(persona))
        broken(
          pointer(['steps', i, 'node', 'persona']),
          `step "${s.id}" is for persona "${persona}", which the design does not declare; its personas are ${[...declared].join(', ') || 'none'} — declare it in \`personas: [{ id, label }]\`.`,
        );
    });
  },
  'band-order': ({ doc, t, nodes, broken }) => {
    if (t.lanes.from !== 'template') return;
    const order = new Map(t.lanes.bands.map((b, i) => [b.id, i]));
    const bandAt = new Map(
      doc.steps.map((s, i) => {
        const n = nodes[i];
        return [s.id, n ? bandOfNode(t, n) : null] as const;
      }),
    );
    const returns =
      t.edgeKinds
        .filter((k) => k.direction === 'return')
        .map((k) => k.id)
        .join(' / ') || 'return';
    doc.steps.forEach((s, i) => {
      s.after.forEach((a, j) => {
        const from = order.get(bandAt.get(a) ?? '');
        const to = order.get(bandAt.get(s.id) ?? '');
        if (from !== undefined && to !== undefined && from > to)
          broken(
            pointer(['steps', i, 'after', j]),
            `the line ${a} → ${s.id} runs back up from band "${bandAt.get(a)}" to "${bandAt.get(s.id)}"; a forward line never climbs the bands. Move "${s.id}" to a later band (\`node.band\`), or draw the return as a ${returns} edge.`,
          );
      });
    });
  },
};

export function ruleRefusals(doc: WorkflowWriteV2, t: WorkflowTemplate): WorkflowRefusal[] {
  const out: WorkflowRefusal[] = [];
  const nodes = doc.steps.map((s) => nodeOf(s, t));
  for (const rule of t.rules) {
    const broken = (path: string, detail: string) =>
      out.push({
        code: 'WORKFLOW_TEMPLATE_RULE',
        path,
        detail: `${name(t)} rule ${rule}: ${detail}`,
      });
    RULE_CHECKS[rule]?.({ doc, t, nodes, broken });
  }
  return out;
}
