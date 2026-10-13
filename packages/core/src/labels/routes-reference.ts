import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { labels } from '../db/schema.js';

export const labelSchema = tableRow(labels);
export const labelListSchema = z.array(labelSchema);

const counts = z.object({
  total: z.number(),
  open: z.number(),
  closed: z.number(),
  recentlyActive: z.number(),
});
const attribution = z.object({ primary: counts, secondary: counts });

export const moduleRollupSchema = z.object({
  activeWithinDays: z.number(),
  generatedAt: z.string(),
  modules: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string().nullable(),
      color: z.string(),
      parentId: z.string().nullable(),
      depth: z.number(),
      own: attribution,
      inherited: attribution,
      rollup: attribution,
    }),
  ),
  unassigned: counts,
});

const driftNode = z.object({
  labelId: z.string(),
  name: z.string(),
  slug: z.string().nullable(),
  knowledgeEntryId: z.string().nullable(),
});

export const moduleDriftSchema = z.object({
  generatedAt: z.string(),
  layer: z.literal('module-taxonomy'),
  minCoOccurrence: z.number(),
  declaration: z.object({
    state: z.enum(['present', 'absent']),
    source: z.literal('label-hierarchy'),
    edgeCount: z.number(),
  }),
  observed: z.object({
    moduleCount: z.number(),
    edgeCount: z.number(),
    belowThresholdEdgeCount: z.number(),
  }),
  undeclared: z.array(
    z.object({
      a: driftNode,
      b: driftNode,
      issueCount: z.number(),
      primaryAnchoredIssueCount: z.number(),
      recentIssueSeqs: z.array(z.number()),
      nearestCommonAncestor: driftNode.nullable(),
    }),
  ),
  unobserved: z.array(z.object({ a: driftNode, b: driftNode, issueCount: z.number() })),
  agreedEdgeCount: z.number(),
});

/** What a module's parent or knowledge node can be refused for, on create and on update alike. */
const MODULE_REFUSALS = {
  INVALID_PARENT: '`parentId` does not name a label in this project',
  PARENT_NOT_MODULE: '`parentId` names a label that is not a module',
  CIRCULAR_HIERARCHY: 'the parent is the label itself or one of its descendants',
  PARENT_ON_NON_MODULE: 'a parent was given for a label that is not a module',
  INVALID_KNOWLEDGE_NODE: '`knowledgeEntryId` does not name a knowledge entry',
  KNOWLEDGE_NODE_NOT_IN_PROJECT: 'the knowledge entry belongs to a different project',
  KNOWLEDGE_NODE_TAKEN: 'another module is already bound to that knowledge entry',
  KNOWLEDGE_NODE_ON_NON_MODULE: 'a knowledge entry was given for a label that is not a module',
};

const NAME_CLASHES = {
  LABEL_NAME_TAKEN: 'a label of this project already has the name',
  MODULE_SLUG_TAKEN: 'another module took the derived slug while the write was in flight; retry',
  KNOWLEDGE_NODE_TAKEN: 'another module is already bound to that knowledge entry',
};

const NOT_ADMIN = fail('FORBIDDEN', 'the caller is not a project admin');
const NOT_A_MEMBER = fail('FORBIDDEN', 'the caller is not a member of the project');

export const createLabel = describeOperation({
  summary: 'Create a label, or a module when `kind` is `module`',
  description:
    'A plain label needs a `color`; a module without one gets a colour derived from its name.',
  responses: {
    201: json(labelSchema),
    400: fail(MODULE_REFUSALS),
    403: NOT_ADMIN,
    404: fail('NOT_FOUND', 'the project does not exist'),
    409: fail(NAME_CLASHES),
  },
});

export const listLabels = describeOperation({
  summary: "List a project's labels and modules",
  responses: {
    200: json(labelListSchema),
    403: NOT_A_MEMBER,
    404: fail('NOT_FOUND', 'the project does not exist'),
  },
});

export const readModuleRollup = describeOperation({
  summary: 'Count issues per module: its own, inherited from descendants, and the sum',
  description:
    '`activeWithinDays` sets what counts as recently active. Issues with no module are in `unassigned`.',
  responses: {
    200: json(moduleRollupSchema),
    403: NOT_A_MEMBER,
    404: fail('NOT_FOUND', 'the project does not exist'),
  },
});

export const readModuleDrift = describeOperation({
  summary: 'Compare the declared module hierarchy with modules that share issues',
  description:
    '`undeclared` lists module pairs that co-occur on at least `minCoOccurrence` issues with no declared edge.',
  responses: {
    200: json(moduleDriftSchema),
    403: NOT_A_MEMBER,
    404: fail('NOT_FOUND', 'the project does not exist'),
  },
});

export const patchLabel = describeOperation({
  summary:
    'Change a label: rename, recolour, re-parent, or promote or demote it to or from a module',
  description:
    "Demoting a module that is a parent, or some issue's primary, is refused with `MODULE_IN_USE`.",
  responses: {
    200: json(labelSchema),
    400: fail({
      ...MODULE_REFUSALS,
      MODULE_IN_USE: "demoting a module that is the parent of another module or an issue's primary",
    }),
    403: NOT_ADMIN,
    404: fail('NOT_FOUND', 'the label does not exist, or its project does not'),
    409: fail(NAME_CLASHES),
  },
});

export const deleteLabel = describeOperation({
  summary: 'Delete a label that no issue carries',
  responses: {
    204: empty(),
    403: NOT_ADMIN,
    404: fail('NOT_FOUND', 'the label does not exist, or its project does not'),
    409: fail('LABEL_IN_USE', 'the label is attached to issues'),
  },
});
