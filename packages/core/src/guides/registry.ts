// Forge capability-guide registry — a code-defined, server-canonical index of
// how-to-use guides for Forge's own features (test credentials, dependencies,
// memory, deploy safety, pipeline lifecycle, uploads). Two live read surfaces
// consume this module: the `forge_guide` MCP tool (`mcp/tools/forge-guide.ts`)
// and the public `GET /api/guides` routes (`guides/routes.ts`).
//
// Why a code module, and which pages belong here rather than in another of the four
// documentation homes: docs/modules/guides/where-a-page-lives.md.
//
// A body is `content/<slug>.md`, embedded at build (`guide-content.ts`); `capability-guide.ts` and
// `assistant-method-guide.ts` compute theirs from code and keep it there.
//
// Altitude rule for every body (NT1 — teach how to use the capability well:
// ordering, gotchas, cardinal rules). Do NOT re-dump tool schemas (Tool
// Search already supplies those) and do not restate the status ladder /
// enums (`prompt/facts/registry.ts` owns those).

import { WORK_EVIDENCE_WAIVER_NOTE } from '../issues/dependency-effects.js';
import {
  ALWAYS_INJECT_ENFORCEMENT_NOTE,
  ALWAYS_INJECT_GUARANTEE_NOTE,
} from '../projects/project-facts.js';
import { ASSISTANT_METHOD_GUIDE } from './assistant-method-guide.js';
import { CAPABILITY_GUIDE } from './capability-guide.js';
import { CONFORMANCE_GUIDE } from './conformance-guide.js';
import { guideBody } from './guide-content.js';
import { RECORDS_GUIDE } from './records-guide.js';
import type { ForgeGuide } from './types.js';

export type { ForgeGuide };

export const FORGE_GUIDES: readonly ForgeGuide[] = [
  CAPABILITY_GUIDE,
  {
    slug: 'project-settings-and-test-credentials',
    audience: 'agent',
    title: 'Project settings & test credentials',
    summary:
      'Where to fetch repo paths, branches, workspace setup, preview URLs, and test credentials — and why forge_config never returns them.',
    version: 3,
    body: guideBody('project-settings-and-test-credentials', {
      ALWAYS_INJECT_GUARANTEE_NOTE,
      ALWAYS_INJECT_ENFORCEMENT_NOTE,
    }),
  },
  {
    slug: 'issue-dependencies',
    audience: 'agent',
    title: 'Issue dependencies',
    summary:
      'How blocks edges gate dispatch, which blocker statuses release a dependent, how to set an edge without racing the first dispatch, and why splitting an oversized issue is plain work rather than a lifecycle.',
    version: 8,
    body: guideBody('issue-dependencies', { WORK_EVIDENCE_WAIVER_NOTE }),
  },
  {
    slug: 'memory-and-knowledge',
    audience: 'agent',
    title: 'Memory & knowledge',
    summary:
      'The two context tiers (memory and knowledge), recall-first discipline, and the verify-at-recall feedback loop.',
    version: 1,
    body: guideBody('memory-and-knowledge'),
  },
  {
    slug: 'deploy-safety',
    audience: 'agent',
    title: 'Deploy safety',
    summary:
      'Confirm before an outward-facing deploy, poll status in the foreground, and what a failed deployment means for status.',
    version: 1,
    body: guideBody('deploy-safety'),
  },
  {
    slug: 'google-sheets',
    audience: 'agent',
    title: 'Google Sheets through Forge',
    summary:
      'How a project reaches a Sheet without holding a Google key: which sheet a call resolves to, what update does that append does not, and what each refusal means.',
    version: 1,
    body: guideBody('google-sheets'),
  },
  {
    slug: 'what-is-an-issue',
    audience: 'agent',
    title: 'What is an issue?',
    summary:
      'The four gates a thing must pass to be an issue at all, where a note / question / audit finding goes instead, and the three-way routing that stops a residual becoming an unowned draft.',
    version: 2,
    body: guideBody('what-is-an-issue'),
  },
  {
    slug: 'writing-an-issue',
    audience: 'agent',
    title: 'Writing an issue',
    summary:
      'The three shapes an issue body takes and how to tell which one you are writing, why technical detail is placed rather than deleted, and how to use a mermaid diagram or an attached HTML artifact instead of prose.',
    version: 2,
    body: guideBody('writing-an-issue'),
  },
  {
    slug: 'pipeline-and-issue-lifecycle',
    audience: 'agent',
    title: 'Pipeline & issue lifecycle',
    summary:
      'What belongs in a description, the four exits from draft (including the direct-ship route and the discard that does not stamp `merged_at`), what the state machine actually enforces vs merely recommends, status-last discipline, why leaving a park is as free as entering it, the two authored kinds of `waiting`, and who owns which derived fields.',
    version: 10,
    body: guideBody('pipeline-and-issue-lifecycle'),
  },
  {
    slug: 'attachments-and-uploads',
    audience: 'agent',
    title: 'Attachments & uploads',
    summary:
      'Presigned-URL upload flow vs base64, and how to read the content of an existing attachment.',
    version: 1,
    body: guideBody('attachments-and-uploads'),
  },
  {
    slug: 'agent-setup',
    audience: 'agent',
    title: 'Working in a Forge-managed repo',
    summary:
      'Start here: what Forge owns, the recall-first rule, draft vs open, and the red flags that waste a runner slot.',
    version: 2,
    body: guideBody('agent-setup'),
  },
  {
    slug: 'update-pipeline-reconcile',
    audience: 'agent',
    title: 'Update Pipeline — reconcile bundle reference',
    summary:
      'Every field the Master agent and verifiers receive, what each one is worth trusting, and the refusal contract that runs before either agent starts.',
    version: 1,
    body: guideBody('update-pipeline-reconcile'),
  },
  {
    slug: 'module-taxonomy-migration',
    audience: 'agent',
    title: 'Migrating a project onto the module taxonomy',
    summary:
      'Turn an existing module convention — a projectFact list and `**Module:**` comment tags — into kind=module labels and primary attributions, idempotently, without deleting anything.',
    version: 1,
    body: guideBody('module-taxonomy-migration'),
  },
  CONFORMANCE_GUIDE,
  ASSISTANT_METHOD_GUIDE,
  RECORDS_GUIDE,
] as const;

const GUIDE_BY_SLUG = new Map<string, ForgeGuide>(FORGE_GUIDES.map((g) => [g.slug, g]));

/** Body-free index — slug/title/summary/version only, never guide bodies. */
export function listGuides(): Array<Omit<ForgeGuide, 'body'>> {
  return FORGE_GUIDES.map(({ body, ...rest }) => {
    void body;
    return rest;
  });
}

/** Full guide by slug, or `undefined` if unknown. */
export function getGuide(slug: string): ForgeGuide | undefined {
  return GUIDE_BY_SLUG.get(slug);
}
