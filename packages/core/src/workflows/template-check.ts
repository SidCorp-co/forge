/**
 * A version 2 design checked against the template it names: its node types, the band each step
 * sits in, the fields each type owes, the kinds its edges are, and the rules the template switches
 * on. Every refusal names the template and what it declares instead, so the fix is in the message.
 */

import {
  bandOfNode,
  findTemplate,
  type NodeRequirableField,
  type WorkflowTemplate,
} from '@forge/contracts/workflow-templates';
import { pointer } from '../project-config/documents.js';
import { edgeKindOf, edgeRefusals, nodeOf } from './edges.js';
import type { WorkflowRefusal } from './rules.js';
import type { WorkflowWriteV2 } from './schema.js';

export { nodeOf };

/** Each other design of the project, by flow, with its step ids: what an `invokes` may point at. */
export type ProjectDesigns = ReadonlyMap<string, readonly string[]>;

const name = (t: WorkflowTemplate) => `template ${t.id}@${t.version}`;

export function templateOf(
  doc: WorkflowWriteV2,
  templates: readonly WorkflowTemplate[],
): { ok: true; template: WorkflowTemplate } | { ok: false; refusal: WorkflowRefusal } {
  const found = findTemplate(templates, doc.template);
  if (found) return { ok: true, template: found };
  const versions = templates.filter((t) => t.id === doc.template.id).map((t) => t.version);
  return {
    ok: false,
    refusal: {
      code: 'WORKFLOW_TEMPLATE_UNKNOWN',
      path: '/template',
      detail:
        versions.length > 0
          ? `template ${doc.template.id} has no version ${doc.template.version}; it is at ${versions.join(', ')}.`
          : `"${doc.template.id}" is no template this project can draw in; the templates are ${templates.map((t) => `${t.id}@${t.version}`).join(', ')} (GET /api/projects/<id>/workflow-templates, or forge_workflows action=templates).`,
    },
  };
}

const absent = (v: unknown) =>
  v === undefined ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

function nodeRefusals(doc: WorkflowWriteV2, t: WorkflowTemplate): WorkflowRefusal[] {
  const types = new Map(t.nodeTypes.map((n) => [n.id, n]));
  return doc.steps.flatMap((s, i): WorkflowRefusal[] => {
    const node = nodeOf(s, t);
    if (!node) {
      return [
        {
          code: 'WORKFLOW_NODE_FIELD_MISSING',
          path: pointer(['steps', i, 'node']),
          detail: `step "${s.id}" names no node, and ${name(t)} has no default type; give it \`node: { type }\`, one of ${[...types.keys()].join(', ')}.`,
        },
      ];
    }
    const type = types.get(node.type);
    if (!type) {
      return [
        {
          code: 'WORKFLOW_NODE_TYPE_NOT_IN_TEMPLATE',
          path: pointer(['steps', i, 'node', 'type']),
          detail: `step "${s.id}" is a ${node.type}, which ${name(t)} does not declare; its node types are ${[...types.keys()].join(', ')}. A type it lacks is added by a project template that extends it.`,
        },
      ];
    }
    const missing = type.required.filter((f: NodeRequirableField) => absent(node[f]));
    return missing.length === 0
      ? []
      : [
          {
            code: 'WORKFLOW_NODE_FIELD_MISSING',
            path: pointer(['steps', i, 'node']),
            detail: `${type.id} step "${s.id}" carries no ${missing.join(', ')}; ${name(t)} requires a ${type.id} to carry ${type.required.join(', ')}.`,
          },
        ];
  });
}

function laneRefusals(doc: WorkflowWriteV2, t: WorkflowTemplate): WorkflowRefusal[] {
  const out: WorkflowRefusal[] = [];
  const mismatch = (path: string, detail: string) =>
    out.push({ code: 'WORKFLOW_BAND_MISMATCH', path, detail });
  if (t.lanes.from !== 'design' && doc.lanes) {
    mismatch(
      '/lanes',
      `${name(t)} draws ${t.lanes.from === 'template' ? 'its own bands' : 'no bands'}, so the design declares no lanes; remove \`lanes\`.`,
    );
  }
  if (t.lanes.from === 'design') {
    if (!doc.lanes) {
      mismatch(
        '/lanes',
        `${name(t)} takes its lanes from the design — one per ${t.lanes.noun} — and this design declares none; add \`lanes: [{ id, label }]\`.`,
      );
      return out;
    }
    const ids = doc.lanes.map((l) => l.id);
    ids.forEach((id, j) => {
      if (ids.indexOf(id) !== j)
        mismatch(pointer(['lanes', j, 'id']), `lane "${id}" is declared twice.`);
    });
  }
  const bands = t.lanes.from === 'template' ? t.lanes.bands : [];
  const known =
    t.lanes.from === 'template' ? bands.map((b) => b.id) : (doc.lanes ?? []).map((l) => l.id);
  doc.steps.forEach((s, i) => {
    const node = nodeOf(s, t);
    if (!node || !t.nodeTypes.some((n) => n.id === node.type)) return;
    const path = pointer(['steps', i, 'node', 'band']);
    if (t.lanes.from === 'none') {
      if (node.band !== undefined)
        mismatch(
          path,
          `step "${s.id}" names band "${node.band}", and ${name(t)} is not banded; remove it.`,
        );
      return;
    }
    const band = t.lanes.from === 'template' ? bandOfNode(t, node) : (node.band ?? null);
    if (band === null) {
      mismatch(
        path,
        `step "${s.id}" sits in no ${t.lanes.from === 'design' ? `${t.lanes.noun} lane` : 'band'}; every step is in exactly one — name it in \`node.band\`, one of ${known.join(', ')}.`,
      );
      return;
    }
    if (!known.includes(band)) {
      mismatch(path, `step "${s.id}" names band "${band}", which is none of ${known.join(', ')}.`);
      return;
    }
    const admits = bands.find((b) => b.id === band);
    if (admits && !admits.types.includes(node.type)) {
      const fits = bands.filter((b) => b.types.includes(node.type)).map((b) => b.id);
      mismatch(
        path,
        `${node.type} step "${s.id}" is in band "${band}", which admits ${admits.types.join(', ')}; a ${node.type} sits in ${fits.join(' or ')}.`,
      );
    }
  });
  return out;
}

function ruleRefusals(
  doc: WorkflowWriteV2,
  t: WorkflowTemplate,
  designs: ProjectDesigns,
): WorkflowRefusal[] {
  const out: WorkflowRefusal[] = [];
  const broken = (path: string, rule: string, detail: string) =>
    out.push({
      code: 'WORKFLOW_TEMPLATE_RULE',
      path,
      detail: `${name(t)} rule ${rule}: ${detail}`,
    });
  const steps = doc.steps;
  const nodes = steps.map((s) => nodeOf(s, t));
  for (const rule of t.rules) {
    if (rule === 'single-entry') {
      const roots = steps.filter((s) => s.after.length === 0).map((s) => s.id);
      if (roots.length !== 1)
        broken(
          '/steps',
          rule,
          `exactly one step comes after nothing, and ${roots.length === 0 ? 'none does' : `${roots.join(', ')} do`}.`,
        );
    }
    if (rule === 'single-initial') {
      const initial = steps.filter((_, i) => nodes[i]?.initial === true).map((s) => s.id);
      if (initial.length !== 1)
        broken(
          '/steps',
          rule,
          `exactly one node is \`initial: true\`, and ${initial.length === 0 ? 'none is' : `${initial.join(', ')} are`}.`,
        );
    }
    if (rule === 'terminal-declared') {
      const terminal = new Set(
        steps.filter((_, i) => nodes[i]?.terminal === true).map((s) => s.id),
      );
      if (terminal.size === 0)
        broken('/steps', rule, 'at least one node is `terminal: true`, and none is.');
      steps.forEach((s, i) => {
        s.after.forEach((a, j) => {
          if (terminal.has(a))
            broken(
              pointer(['steps', i, 'after', j]),
              rule,
              `"${s.id}" comes after "${a}", which is terminal; nothing moves on from a terminal node (a return to an earlier node is a return edge from it, not an \`after\`).`,
            );
        });
      });
    }
    if (rule === 'tree') {
      steps.forEach((s, i) => {
        if (s.after.length > 1)
          broken(
            pointer(['steps', i, 'after']),
            rule,
            `"${s.id}" comes after ${s.after.join(', ')}; in a tree every step has one parent.`,
          );
      });
    }
    if (rule === 'screen-error-state') {
      steps.forEach((s, i) => {
        if (nodes[i]?.type !== 'SCREEN' || nodes[i]?.noErrorState) return;
        const hasError = (doc.edges ?? []).some(
          (e) =>
            e.from === s.id &&
            edgeKindOf(e, t) === 'error' &&
            nodes[steps.findIndex((x) => x.id === e.to)]?.variant === 'error',
        );
        if (!hasError)
          broken(
            pointer(['steps', i, 'node']),
            rule,
            `screen "${s.id}" declares no error state; draw an \`error\` edge from it to a UI_STATE of variant "error", or say why it has none in \`node.noErrorState\`.`,
          );
      });
    }
    if (rule === 'submit-targets') {
      const ids = new Set(steps.map((s) => s.id));
      (doc.edges ?? []).forEach((e, j) => {
        if (edgeKindOf(e, t) !== 'submit') return;
        for (const side of ['success', 'failure'] as const) {
          const target = e[side];
          if (target !== undefined && !ids.has(target))
            broken(
              pointer(['edges', j, side]),
              rule,
              `submit ${e.from} → ${e.to} sends the person to "${target}" on ${side}, which is no step of this design; name the screen or UI state they reach.`,
            );
        }
      });
    }
    if (rule === 'invokes-resolve') {
      steps.forEach((s, i) => {
        const ref = nodes[i]?.invokes;
        if (!ref) return;
        const path = pointer(['steps', i, 'node', 'invokes']);
        if (ref.workflow === doc.flow) {
          broken(
            path,
            rule,
            `system step "${s.id}" invokes "${ref.workflow}/${ref.step}", a step of this same design; \`invokes\` points at the business flow this one drives, which is another design.`,
          );
          return;
        }
        const held = designs.get(ref.workflow);
        if (!held) {
          broken(
            path,
            rule,
            `system step "${s.id}" invokes design "${ref.workflow}", which this project does not hold (its designs: ${[...designs.keys()].join(', ') || 'none'}); draw that design first, or name one it holds.`,
          );
          return;
        }
        if (!held.includes(ref.step))
          broken(
            path,
            rule,
            `system step "${s.id}" invokes "${ref.workflow}/${ref.step}", and design "${ref.workflow}" has no step "${ref.step}" (its steps: ${held.join(', ')}).`,
          );
      });
    }
    if (rule === 'personas-declared') {
      const declared = new Set((doc.personas ?? []).map((p) => p.id));
      steps.forEach((s, i) => {
        const persona = nodes[i]?.persona;
        if (persona !== undefined && !declared.has(persona))
          broken(
            pointer(['steps', i, 'node', 'persona']),
            rule,
            `step "${s.id}" is for persona "${persona}", which the design does not declare; its personas are ${[...declared].join(', ') || 'none'} — declare it in \`personas: [{ id, label }]\`.`,
          );
      });
    }
    if (rule === 'band-order' && t.lanes.from === 'template') {
      const order = new Map(t.lanes.bands.map((b, i) => [b.id, i]));
      const bandAt = new Map(
        steps.map((s, i) => {
          const n = nodes[i];
          return [s.id, n ? bandOfNode(t, n) : null] as const;
        }),
      );
      steps.forEach((s, i) => {
        s.after.forEach((a, j) => {
          const from = order.get(bandAt.get(a) ?? '');
          const to = order.get(bandAt.get(s.id) ?? '');
          if (from !== undefined && to !== undefined && from > to)
            broken(
              pointer(['steps', i, 'after', j]),
              rule,
              `the line ${a} → ${s.id} runs back up from band "${bandAt.get(a)}" to "${bandAt.get(s.id)}"; a forward line never climbs the bands. Move "${s.id}" to a later band (\`node.band\`), or draw the return as a ${
                t.edgeKinds
                  .filter((k) => k.direction === 'return')
                  .map((k) => k.id)
                  .join(' / ') || 'return'
              } edge.`,
            );
        });
      });
    }
  }
  return out;
}

/** Everything the named template holds a design to; the template itself resolves first. */
export function templateRefusals(
  doc: WorkflowWriteV2,
  template: WorkflowTemplate,
  designs: ProjectDesigns,
  /** False when `after` loops: the order the rules read is not there, so they are not read (nor while a step is unplaced). */
  ordered = true,
): WorkflowRefusal[] {
  const nodes = nodeRefusals(doc, template);
  const lanes = laneRefusals(doc, template);
  const placed = nodes.length === 0 && lanes.length === 0;
  return [
    ...nodes,
    ...lanes,
    ...edgeRefusals(doc, template),
    ...(placed && ordered ? ruleRefusals(doc, template, designs) : []),
  ];
}
