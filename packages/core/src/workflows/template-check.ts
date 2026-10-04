/**
 * A version 2 design checked against the template it names: its node types, the band each step
 * sits in, the fields each type owes, the kinds its edges are, the rules the template switches on
 * (`template-rules.ts`) and the cross-links its nodes carry (`template-refs.ts`). Every refusal
 * names the template and what it declares instead, so the fix is in the message.
 */

import {
  bandOfNode,
  findTemplate,
  type NodeRequirableField,
  type TemplateRef,
  type WorkflowTemplate,
} from '@forge/contracts/workflow-templates';
import { pointer } from '../project-config/documents.js';
import { edgeRefusals, nodeOf } from './edges.js';
import type { WorkflowRefusal } from './rules.js';
import type { WorkflowWrite, WorkflowWriteV2 } from './schema.js';
import { inboundRefRefusals, refRefusals } from './template-refs.js';
import { ruleRefusals, structureRefusals } from './template-rules.js';

export { nodeOf };

export interface ProjectDesignStep {
  type: string | null;
  refs: readonly { template: string; flow: string; step: string }[];
}

/** Another design of the project as a cross-link reads it: its template, and each step's type and refs. */
export interface ProjectDesign {
  template: TemplateRef;
  steps: ReadonlyMap<string, ProjectDesignStep>;
}

/** The project's other version 2 designs, by flow. */
export type ProjectDesigns = ReadonlyMap<string, ProjectDesign>;

export function projectDesignOf(
  doc: WorkflowWrite,
  templates: readonly WorkflowTemplate[],
): ProjectDesign | null {
  if (doc.version !== 2) return null;
  const t = findTemplate(templates, doc.template);
  return {
    template: doc.template,
    steps: new Map(
      doc.steps.map((s) => {
        const node = t ? nodeOf(s, t) : (s.node ?? null);
        return [s.id, { type: node?.type ?? null, refs: node?.refs ?? [] }] as const;
      }),
    ),
  };
}

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
          : `"${doc.template.id}" is no template this project can draw in; the templates are ${templates.map((t) => `${t.id}@${t.version}`).join(', ')} (GET /api/projects/<id>/workflow-templates).`,
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
    if (missing.length === 0 && type.vocabulary && node.mapsTo !== undefined)
      return type.vocabulary.includes(node.mapsTo)
        ? []
        : [
            {
              code: 'WORKFLOW_NODE_VALUE_NOT_IN_VOCABULARY',
              path: pointer(['steps', i, 'node', 'mapsTo']),
              detail: `${type.id} step "${s.id}" maps to "${node.mapsTo}", which ${name(t)} does not hold; a ${type.id} maps to one of ${type.vocabulary.join(', ')}.`,
            },
          ];
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

/** Everything the named template holds a design to; the template itself resolves first. */
export function templateRefusals(
  doc: WorkflowWriteV2,
  template: WorkflowTemplate,
  ctx: { templates: readonly WorkflowTemplate[]; designs: ProjectDesigns },
  /** False when `after` loops: the order the rules read is not there, so they are not read (nor while a step is unplaced). */
  ordered = true,
): WorkflowRefusal[] {
  const nodes = nodeRefusals(doc, template);
  const lanes = laneRefusals(doc, template);
  const edges = ordered ? edgeRefusals(doc, template) : [];
  const placed = nodes.length === 0 && lanes.length === 0;
  const read = placed && ordered && edges.length === 0;
  return [
    ...nodes,
    ...lanes,
    ...edges,
    ...(read ? [...structureRefusals(doc, template), ...ruleRefusals(doc, template)] : []),
    ...(placed ? refRefusals(doc, template, ctx) : []),
    ...inboundRefRefusals(doc, ctx),
  ];
}
