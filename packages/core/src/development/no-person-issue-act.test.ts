// REQ-68 BC-6 (ISS-687 c2): no product page asks a person to act on an issue. This walks each product
// surface a person acts from and finds no act on an issue: the web routes and components of
// requirements, feedback, Needs you and Approvals call no route that moves, runs, admits, links or
// files an issue; no Needs you decision moves one; the chat offers no button on an issue; and no
// product MCP door moves one. A stuck issue reaches a person only as a
// decision on its item (`steward/decision-ask.ts`). Planted red by putting one back: the `issue.admit`
// act in `DECISION_ACTS`, an `issuesApi.transition` call on the requirement page.
//
// @direct-test-of packages/contracts/src/needs-you-decisions.ts
// @direct-test-of packages/core/src/assistant/agreement/write-rule.ts
// @direct-test-of packages/core/src/assistant/prompt/door-web.ts
// @direct-test-of packages/core/src/mcp/registry.ts

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDEA_OFFER_TOOL, ideaOfferParamsSchema } from '@forge/contracts/idea-offer';
import { DECISION_ACTS } from '@forge/contracts/needs-you-decisions';
import { describe, expect, it } from 'vitest';
import { NOT_A_BUSINESS_WRITE } from '../assistant/agreement/write-rule.js';
import { WEB_DOOR_LAYER } from '../assistant/prompt/door-web.js';
import { PAT_GRANT_EPOCH } from '../credentials/pat-permissions.js';
import type { McpContext } from '../lib/tool.js';
import { actionCatalog } from '../mcp/action-catalog.js';
import { mcpTools } from '../mcp/server.js';
import type { PrincipalVars } from '../middleware/require-pat.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '../../../web-v2/src');

/** The web product surfaces a person acts from: their features and their routes. */
const PRODUCT_DIRS = [
  'features/requirements',
  'features/feedback',
  'features/needs-you',
  'features/approvals',
  'routes/_workspace/projects/$slug/requirements',
  'routes/_workspace/projects/$slug/feedback',
  'routes/_workspace/projects/$slug/approvals',
];

/** What an act on an issue looks like in web code: a call that moves, runs, admits, links or files one. */
const ISSUE_ACTS: { name: string; pattern: RegExp }[] = [
  { name: 'an issue move', pattern: /issuesApi\.(transition|runPipelineStep|admit|create)\b/ },
  { name: 'a release of issues', pattern: /releaseBatchApi\b/ },
  { name: "an issue's transition route", pattern: /\/issues\/[^"'`\s]*\/(transition|run|admit)\b/ },
  { name: "a requirement's issue link", pattern: /\/requirements\/[^"'`\s]*\/issues\b/ },
  { name: 'a promote of draft issues', pattern: /promote-?drafts|promoteDrafts/i },
  { name: 'an issue the triage names or titles', pattern: /createIssue:\s*\{\s*[a-z]/ },
];

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourcesUnder(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe('the web product pages hold no act on an issue', () => {
  const files = PRODUCT_DIRS.flatMap((d) => sourcesUnder(join(WEB, d)));

  it('walks every product surface it names', () => {
    for (const d of PRODUCT_DIRS) {
      expect(statSync(join(WEB, d)).isDirectory(), `${d} is no directory of the web`).toBe(true);
    }
    expect(files.length).toBeGreaterThan(50);
  });

  it('calls no route that moves, runs, admits, links or files an issue', () => {
    const found = files.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return ISSUE_ACTS.filter((a) => a.pattern.test(text)).map(
        (a) => `${relative(WEB, f)}: ${a.name}`,
      );
    });
    expect(found).toEqual([]);
  });
});

describe('Needs you holds no act that moves an issue', () => {
  // its issue area still lists a run's question on an issue: removing it is left to a follow-up
  it('has no decision act on an issue route', () => {
    const onIssues = Object.entries(DECISION_ACTS).filter(([, a]) =>
      a.path.startsWith('/api/issues/'),
    );
    expect(onIssues.map(([act]) => act)).toEqual([]);
  });
});

describe('the chat offers no button on an issue', () => {
  const offers = NOT_A_BUSINESS_WRITE.flatMap((w) => w.tools).filter((t) => t.startsWith('offer_'));

  it('offers only the idea preview, about a requirement or a feedback item', () => {
    expect(offers).toEqual([IDEA_OFFER_TOOL]);
    expect(ideaOfferParamsSchema.shape.about.safeParse('ISS-1').success).toBe(false);
    expect(ideaOfferParamsSchema.shape.about.safeParse('REQ-1').success).toBe(true);
  });

  it("tells the web turn issue moves are the agent's, and names no tool that makes one", () => {
    expect(WEB_DOOR_LAYER.text).not.toContain('offer_act');
    expect(WEB_DOOR_LAYER.text).toContain("is the project's agent's work, never a person's");
  });
});

describe('no product MCP door moves an issue', () => {
  const principal = {
    kind: 'pat',
    agency: 'human',
    agentUserId: null,
    userId: '00000000-0000-4000-8000-000000000687',
    tokenId: 'tok-687',
    scopes: ['read', 'write'],
    projectIds: null,
    permissions: ['*'],
    grantEpoch: PAT_GRANT_EPOCH,
    boundProjectId: null,
    deviceId: null,
    onBehalfOf: null,
  } as unknown as PrincipalVars['principal'];
  const catalog = [
    ...actionCatalog(mcpTools({ principal, projectSlug: null } as unknown as McpContext)).values(),
  ];

  // the product layer a person works in from an MCP client (`mcp/server.ts`); the support room's
  // door is its bot session's alone, and the channel and ecosystem doors are kept for forge-plugin
  const PRODUCT_DOORS = [
    'forge_requirements',
    'project_feedback',
    'forge_feedback',
    'forge_releases',
    'forge_design',
    'forge_questions',
    'forge_issues',
    'forge_uploads',
  ];

  it('names no action that moves, admits, links or files an issue on any other product door', () => {
    expect(PRODUCT_DOORS.filter((d) => !catalog.some((a) => a.tool === d))).toEqual([]);
    const moves = catalog
      .filter((a) => PRODUCT_DOORS.includes(a.tool))
      .filter(
        (a) =>
          /^(transition|admit|promote)/.test(a.action) ||
          (a.tool !== 'forge_issues' && /issue/.test(a.action)),
      )
      .map((a) => a.id);
    expect(moves).toEqual([]);
  });

  it('reads issues, and files one only by the create every door takes (ISS-861)', () => {
    const issues = catalog.filter((a) => a.tool === 'forge_issues').map((a) => a.action);
    expect(issues.sort()).toEqual(['create', 'get', 'list']);
  });
});
