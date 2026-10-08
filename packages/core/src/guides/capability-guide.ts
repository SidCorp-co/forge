// The capability map: what Forge is and can do, by area, each area routing to the guide that owns
// it. A router, not a manual; capability-guide.test.ts checks every slug against the registry.

import { RECORD_GUIDE_SLUG } from '../messaging/record-screen.js';
import { ASSISTANT_METHOD_SLUG } from './assistant-method-guide.js';
import { CORPUS_SCOPE, cliServedBullets } from './corpus-scope.js';
import type { ForgeGuide } from './types.js';

export const CAPABILITY_GUIDE_SLUG = 'what-forge-is';

export interface CapabilityArea {
  area: string;
  covers: string;
  /** Slugs of registry guides. Verified against the registry, never trusted. */
  guides: readonly string[];
}

export const CAPABILITY_AREAS: readonly CapabilityArea[] = [
  {
    area: 'Issues',
    covers:
      'What counts as an issue and what does not, how to write one, and how issues order each other.',
    guides: ['what-is-an-issue', 'writing-an-issue', 'issue-dependencies'],
  },
  {
    area: 'The pipeline and the lifecycle',
    covers:
      'How an issue moves from draft to closed, what the state machine enforces, and what the update pipeline hands the agents that run it.',
    guides: ['pipeline-and-issue-lifecycle', 'update-pipeline-reconcile'],
  },
  {
    area: 'Project settings and test credentials',
    covers: 'Where a project keeps its paths, branches, preview addresses and test accounts.',
    guides: ['project-settings-and-test-credentials'],
  },
  {
    area: 'Memory and knowledge',
    covers: 'The two tiers of context a project accumulates, and the recall-first habit.',
    guides: ['memory-and-knowledge'],
  },
  {
    area: 'Records and comments',
    covers: 'What a comment is for, and where each structured record goes instead.',
    guides: [RECORD_GUIDE_SLUG],
  },
  {
    area: 'Conformance',
    covers: 'The gate a change passes before a step is called done, and what each exit obliges.',
    guides: ['conformance-and-verify'],
  },
  {
    area: 'Deploys',
    covers: 'When an outward-facing deploy needs a confirmation, and what a failed one means.',
    guides: ['deploy-safety'],
  },
  {
    area: 'Files and attachments',
    covers: 'How a file reaches an issue and how its content is read back.',
    guides: ['attachments-and-uploads'],
  },
  {
    area: 'Connected services',
    covers:
      'How a project reaches an external service without holding its key. A service an organisation has documented has its own guide, `integration-<provider>`, in the same index.',
    guides: ['google-sheets'],
  },
  {
    area: 'Modules',
    covers: 'Moving a project onto the module taxonomy without losing what it already names.',
    guides: ['module-taxonomy-migration'],
  },
  {
    area: 'Working as an assistant',
    covers: 'How an assistant answers a request: investigate first, act, and what a reply owes.',
    guides: [ASSISTANT_METHOD_SLUG],
  },
  {
    area: 'Working in a managed repository',
    covers: 'The first page for an agent in a repository Forge manages.',
    guides: ['agent-setup'],
  },
];

function areaRow(a: CapabilityArea): string {
  const links = a.guides.map((slug) => `[${slug}](/api/guides/${slug}.md)`).join(', ');
  return `| ${a.area} | ${a.covers} | ${links} |`;
}

export const CAPABILITY_GUIDE: ForgeGuide = {
  slug: CAPABILITY_GUIDE_SLUG,
  audience: 'agent',
  title: 'What Forge is and what it can do',
  summary:
    'The capability map by area, each area naming the guide that covers it, and where the method guides the CLI serves are found. Read this first when you arrive cold.',
  version: 1,
  body: `## What Forge is and what it can do

Forge is the control plane for a software project's lifecycle: an issue enters the pipeline that
fits it, agents do the work wherever automation is safe, project memory and skills supply the
context, evidence proves what happened, and the next decision reaches whoever has the authority to
make it. Agents execute; people decide; Forge keeps the state honest about which is which.

This page routes. It restates no method another guide owns — to learn one, take the guide in the
last column and read it whole.

### By area

| Area | What it covers | Read |
|---|---|---|
${CAPABILITY_AREAS.map(areaRow).join('\n')}

### The methods that drive work

Running a wave of issues, taking one issue from its title to deployed code, judging a change that
has landed, releasing it, and what each status is owed before it moves are **methods**, and the
forge CLI serves them. They are not served by this host, so they are not in the table above and a
request for one here answers 404.

${CORPUS_SCOPE.reach}

${CORPUS_SCOPE.authority}

${cliServedBullets().join('\n')}

### What this page does not do

- It does not teach a method. A method is a guide, and the guide is the CLI's or the table's.
- It does not carry a flag or a tool signature. The CLI and the tool server describe themselves,
  and a copy here would go stale on some release with nothing saying so.
- It is not the complete corpus. The index at \`/api/guides\` says so in its own \`corpus\` field.`,
};
