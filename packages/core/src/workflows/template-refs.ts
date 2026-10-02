/**
 * Cross-links between a project's designs: a node's `refs` name steps of its other designs, as its
 * type's `links` allow. Both ends are held. A ref the design carries must resolve to a step of the
 * right type in a design drawn in the right template. A write must not remove or retype a step
 * another design links to. A dangling ref is refused by name, never dropped.
 */

import {
  answersLink,
  findTemplate,
  type WorkflowTemplate,
} from '@forge/contracts/workflow-templates';
import { pointer } from '../project-config/documents.js';
import { nodeOf } from './edges.js';
import type { WorkflowRefusal } from './rules.js';
import type { WorkflowWriteV2 } from './schema.js';
import type { ProjectDesigns } from './template-check.js';

interface RefContext {
  templates: readonly WorkflowTemplate[];
  designs: ProjectDesigns;
}

const known = (designs: ProjectDesigns) => [...designs.keys()].join(', ') || 'none';

/** Every ref this design carries, resolved against the project's other designs. */
export function refRefusals(
  doc: WorkflowWriteV2,
  t: WorkflowTemplate,
  ctx: RefContext,
): WorkflowRefusal[] {
  const out: WorkflowRefusal[] = [];
  doc.steps.forEach((s, i) => {
    const node = nodeOf(s, t);
    const type = t.nodeTypes.find((n) => n.id === node?.type);
    if (!node || !type) return;
    const links = type.links ?? [];
    (node.refs ?? []).forEach((ref, j) => {
      const path = pointer(['steps', i, 'node', 'refs', j]);
      const target = `${ref.flow}/${ref.step}`;
      const link = links.find((l) => l.template === ref.template);
      if (!link) {
        out.push({
          code: 'WORKFLOW_REF_NOT_ALLOWED',
          path,
          detail: `${type.id} step "${s.id}" links to ${ref.template}, and in template ${t.id}@${t.version} a ${type.id} links ${links.length ? `only to ${links.map((l) => `${l.template} (${l.types.join(', ')})`).join(', ')}` : 'to nothing'}.`,
        });
        return;
      }
      const held = ref.flow === doc.flow ? undefined : ctx.designs.get(ref.flow);
      if (!held) {
        out.push({
          code: 'WORKFLOW_REF_DANGLING',
          path,
          detail:
            ref.flow === doc.flow
              ? `step "${s.id}" links to ${target}, a step of this same design; a ref names another design of the project.`
              : `step "${s.id}" links to ${target}, and this project holds no design "${ref.flow}" (its designs: ${known(ctx.designs)}). Draw that ${ref.template} design first, or name one it holds.`,
        });
        return;
      }
      const drawnIn = findTemplate(ctx.templates, held.template);
      if (!drawnIn || !answersLink(drawnIn, ref.template)) {
        out.push({
          code: 'WORKFLOW_REF_TARGET_MISMATCH',
          path,
          detail: `step "${s.id}" links to ${target} as ${ref.template}, and design "${ref.flow}" is drawn in ${held.template.id}@${held.template.version}.`,
        });
        return;
      }
      const step = held.steps.get(ref.step);
      if (!step) {
        out.push({
          code: 'WORKFLOW_REF_DANGLING',
          path,
          detail: `step "${s.id}" links to ${target}, and design "${ref.flow}" has no step "${ref.step}" (its steps: ${[...held.steps.keys()].join(', ')}).`,
        });
        return;
      }
      if (step.type === null || !link.types.includes(step.type))
        out.push({
          code: 'WORKFLOW_REF_TARGET_MISMATCH',
          path,
          detail: `step "${s.id}" links to ${target}, a ${step.type ?? 'step with no type'}; a ${type.id} links to a ${link.types.join(' or ')} of ${ref.template}: ${link.tooltip}`,
        });
    });
    for (const link of links) {
      if (link.required && !(node.refs ?? []).some((r) => r.template === link.template))
        out.push({
          code: 'WORKFLOW_REF_MISSING',
          path: pointer(['steps', i, 'node']),
          detail: `${type.id} step "${s.id}" carries no ref to ${link.template}; in template ${t.id}@${t.version} a ${type.id} names the ${link.types.join(' or ')} it is (${link.tooltip}): \`refs: [{ template: "${link.template}", flow, step }]\`.`,
        });
    }
  });
  return out;
}

/** The other end: a step another design links to stays in this design, as a type that link takes. */
export function inboundRefRefusals(doc: WorkflowWriteV2, ctx: RefContext): WorkflowRefusal[] {
  const out: WorkflowRefusal[] = [];
  const own = findTemplate(ctx.templates, doc.template);
  for (const [flow, design] of ctx.designs) {
    const from = findTemplate(ctx.templates, design.template);
    for (const [id, step] of design.steps) {
      for (const ref of step.refs) {
        if (ref.flow !== doc.flow) continue;
        const link = from?.nodeTypes
          .find((n) => n.id === step.type)
          ?.links?.find((l) => l.template === ref.template);
        const target = doc.steps.find((s) => s.id === ref.step);
        const type = target && own ? (nodeOf(target, own)?.type ?? null) : null;
        const where = `design "${flow}" step "${id}" links to ${doc.flow}/${ref.step}`;
        if (!target)
          out.push({
            code: 'WORKFLOW_REF_DANGLING',
            path: '/steps',
            detail: `${where}, and this write has no step "${ref.step}"; keep it, or change "${flow}" first.`,
          });
        else if (
          !own ||
          !answersLink(own, ref.template) ||
          (link && !link.types.includes(type ?? ''))
        )
          out.push({
            code: 'WORKFLOW_REF_TARGET_MISMATCH',
            path: pointer(['steps', doc.steps.indexOf(target)]),
            detail: `${where} as a ${link?.types.join(' or ') ?? '?'} of ${ref.template}, and this write makes it a ${type ?? 'step with no type'} of ${doc.template.id}@${doc.template.version}; keep it, or change "${flow}" first.`,
          });
      }
    }
  }
  return out;
}
