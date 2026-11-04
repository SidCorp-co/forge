// REQ-68 BC-6 (ISS-687 c2): no product page asks a person to act on an issue. This walks each product
// surface a person acts from and finds no act on an issue: the web routes and components of
// requirements, feedback, Needs you and Approvals call no route that moves, runs, admits, links or
// files an issue; Needs you lists no issue and no decision opens or moves one; the chat offers no
// button on an issue; and no product MCP door moves one. A stuck issue reaches a person only as a
// decision on its item (`steward/decision-ask.ts`). Planted red by putting one back: the `issue.admit`
// act in `DECISION_ACTS`, an `issuesApi.transition` call on the requirement page, the `issues` area in
// `NEEDS_YOU_AREAS`, the `admit` field on the `forge_issues` door.
// The fix round after judge K163 (c1 and c3 failed at 0.4.0-dev.480): the Issues list grouped issues
// under Needs you asking "You · take on or drop", "You · resume once", "You · answer a question", and
// the issue page drew a primary Run pipeline and a Pause. No issue's standing groups Needs you or
// names its reader, and the issue page's own files hold no move, run, pause, resume or release.
// Planted red by putting `needs_you` back in `ISSUE_ATTENTION_GROUPS` and the old header back.
// Fix round 2 (judge run 6c6e24b4 at dev.485): four needs_info rows still read "orchestrator, qa ·
// answer a question". An issue's standing writers say no person's act on a question at all: it waits
// on the answer (`issues/standing.ts:answerTurn`), and the steward's notes are told the same. Planted
// red by putting `issues.standing.act.answer` back in the needs_info turn.
// Round 4 (judge run d47d6de0 at dev.489): ISS-639's Criteria section drew "Tie to REQ-66 criteria".
// The issue page's Criteria files are walked too, and hold no tie. Planted red by restoring
// `TieCriteria` in `criteria-acts.tsx` and its call in `issue-criteria.tsx`.
// Round 5 (judge run 13b796d4 at dev.493): the BA door's Ask Agent told a person to "have the lease
// holder schedule and land a correction". Every door a person talks to carries the one issue-work
// line. Planted red by taking it out of the BA door.
//
// @direct-test-of packages/contracts/src/issue-standing.ts
// @direct-test-of packages/contracts/src/modules.ts
// @direct-test-of packages/contracts/src/needs-you.ts
// @direct-test-of packages/contracts/src/needs-you-decisions.ts
// @direct-test-of packages/contracts/src/chat-decide.ts
// @direct-test-of packages/core/src/assistant/agreement/write-rule.ts
// @direct-test-of packages/core/src/assistant/prompt/door-web.ts
// @direct-test-of packages/core/src/assistant/prompt/door-ba.ts
// @direct-test-of packages/core/src/assistant/prompt/door-web-agent.ts
// @direct-test-of packages/core/src/assistant/prompt/issue-work-line.ts
// @direct-test-of packages/core/src/mcp/registry.ts
// @direct-test-of packages/core/src/mcp/server.ts
// @direct-test-of packages/core/src/product-door/issues-tool.ts
// @direct-test-of packages/core/src/issues/standing.ts
// @direct-test-of packages/core/src/steward/prompts.ts

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decisionOutcomeRequestSchema } from '@forge/contracts/chat-decide';
import { IDEA_OFFER_TOOL, ideaOfferParamsSchema } from '@forge/contracts/idea-offer';
import { ISSUE_ATTENTION_GROUPS, ISSUE_WAITING_KINDS } from '@forge/contracts/issue-standing';
import { MODULE_ATTENTION_GROUPS, MODULE_OPEN_KINDS } from '@forge/contracts/modules';
import { NEEDS_YOU_AREAS, NEEDS_YOU_ENTITIES } from '@forge/contracts/needs-you';
import { DECISION_ACTS, decisionOpensSchema } from '@forge/contracts/needs-you-decisions';
import { describe, expect, it } from 'vitest';
import { NOT_A_BUSINESS_WRITE } from '../assistant/agreement/write-rule.js';
import { BA_DOOR_LAYER } from '../assistant/prompt/door-ba.js';
import { WEB_DOOR_LAYER } from '../assistant/prompt/door-web.js';
import { WEB_AGENT_DOOR_LAYER } from '../assistant/prompt/door-web-agent.js';
import { ISSUE_WORK_LINE } from '../assistant/prompt/issue-work-line.js';
import { PAT_GRANT_EPOCH } from '../credentials/pat-permissions.js';
import type { McpContext } from '../lib/tool.js';
import { actionCatalog } from '../mcp/action-catalog.js';
import { forgeMcpInstructions, mcpTools } from '../mcp/server.js';
import type { PrincipalVars } from '../middleware/require-pat.js';
import { actPrompt } from '../steward/prompts.js';

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

/** The issue page's own files: its screen, its header, its main column and its banners. */
const ISSUE_PAGE = [
  'features/issues/components/issue-detail-screen.tsx',
  'features/issues/components/detail',
  'features/issues/components/blocker-banner.tsx',
  'features/issues/components/awaiting-release-banner.tsx',
  // its Criteria section, where round 4's judge (d47d6de0, dev.489) read "Tie to REQ-66 criteria"
  'features/issues/components/issue-criteria.tsx',
  'features/issues/components/criteria-acts.tsx',
  'features/issues/criteria.ts',
];

/** What a person's act on an issue looks like on its page: a hook or control that moves, runs, pauses, resumes or releases it. */
const PAGE_ACTS: { name: string; pattern: RegExp }[] = [
  ...ISSUE_ACTS,
  { name: 'a status move', pattern: /useGuardedTransition|useTransitionIssue|<StatusEdit\b/ },
  { name: 'a run paused or resumed', pattern: /useResumeRun|usePauseRun|useCancelRun/ },
  { name: 'a release cut from the issue', pattern: /useBatchRelease|ReleaseNowAct/ },
  { name: "the blocker's button", pattern: /BlockerAct\b|onResumePark|onResumeRun/ },
  {
    name: 'a header act',
    pattern: /issues\.actions\.(runPipeline|viewPipeline|pause|pauseHold)\b/,
  },
  {
    name: "a tie of the issue to its requirement's criteria",
    pattern: /criteria\/traces|TieCriteria|useTraceCriteria|issues\.tieAct\./,
  },
];

describe('the issue page and the Issues list ask a person to do nothing to an issue', () => {
  const files = ISSUE_PAGE.flatMap((p) => {
    const path = join(WEB, p);
    return statSync(path).isDirectory() ? sourcesUnder(path) : [path];
  });

  it('holds no move, run, pause, resume or release of the issue in its own files', () => {
    expect(files.length).toBeGreaterThan(6);
    const found = files.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return PAGE_ACTS.filter((a) => a.pattern.test(text)).map(
        (a) => `${relative(WEB, f)}: ${a.name}`,
      );
    });
    expect(found).toEqual([]);
  });

  it('groups no issue and no module under Needs you, and waits on no reader as You', () => {
    expect(ISSUE_ATTENTION_GROUPS as readonly string[]).not.toContain('needs_you');
    expect(ISSUE_WAITING_KINDS as readonly string[]).not.toContain('you');
    expect(MODULE_ATTENTION_GROUPS as readonly string[]).not.toContain('needs_you');
    expect(MODULE_OPEN_KINDS as readonly string[]).not.toContain('needs_you');
  });
});

describe('Needs you asks a person nothing about an issue', () => {
  it('has no issue area and lists no issue row', () => {
    expect(NEEDS_YOU_AREAS as readonly string[]).not.toContain('issues');
    expect(NEEDS_YOU_ENTITIES as readonly string[]).not.toContain('issue');
  });

  it('has no decision act on an issue route, and no decision opens an issue', () => {
    const onIssues = Object.entries(DECISION_ACTS).filter(([, a]) =>
      a.path.startsWith('/api/issues/'),
    );
    expect(onIssues.map(([act]) => act)).toEqual([]);
    expect(decisionOpensSchema.safeParse({ kind: 'issue', key: 'ISS-1' }).success).toBe(false);
    expect(
      decisionOutcomeRequestSchema.safeParse({
        decision: 'd',
        opens: { kind: 'issue', key: 'ISS-1' },
        ok: true,
      }).success,
    ).toBe(false);
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
    expect(WEB_DOOR_LAYER.text).toContain(ISSUE_WORK_LINE);
  });

  it("tells every door a person talks to that issue work is the agents', the BA door included", () => {
    for (const door of [WEB_DOOR_LAYER, WEB_AGENT_DOOR_LAYER, BA_DOOR_LAYER]) {
      expect(door.text, door.id).toContain(ISSUE_WORK_LINE);
    }
    expect(ISSUE_WORK_LINE).toContain(
      'Never tell a person, or a role such as the lease holder, to act on an issue',
    );
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

  // the master admits a draft (REQ-68 BC-6): the person's create files one at draft and asks nothing
  // more of it, and an `admit` sent anyway is refused by name, never dropped
  const door = mcpTools({ principal, projectSlug: null } as unknown as McpContext).find(
    (t) => t.name === 'forge_issues',
  );

  it("takes no admit on the issues door's create, and refuses one sent by name", async () => {
    if (!door) throw new Error('the product MCP server lists no forge_issues door');
    const props = (door.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props)).not.toContain('admit');
    expect(door.description).not.toMatch(/\badmit\b/);
    expect(door.description).toContain("born at `draft`, where the project's master admits it");
    const sent = door.handler({
      action: 'create',
      projectId: '00000000-0000-4000-8000-000000000687',
      title: 'A draft',
      admit: true,
    });
    await expect(sent).rejects.toThrow(/admit/);
    await expect(sent).rejects.toMatchObject({ name: 'RefusalError', fallbackCode: 'BAD_REQUEST' });
  });

  it('says in the server instructions that the issues door admits, moves and links no issue', () => {
    const text = forgeMcpInstructions();
    expect(text).toContain('no door here admits, moves or links an issue');
    expect(text).not.toContain('MCP_FILES_FEEDBACK_NOT_ISSUES');
  });
});

describe("no issue's standing says a person's act on a question (fix round 2)", () => {
  const CORE = join(dirname(fileURLToPath(import.meta.url)), '..');
  // what a person owes on a question, as an act: Needs you's own row and a requirement may say it
  const ANSWER_ACTS = /issues\.standing\.act\.(answer|answerOther|decide|supply)'/;
  const writers = readdirSync(join(CORE, 'issues'))
    .filter((n) => /^standing.*\.ts$/.test(n) && !n.endsWith('.test.ts'))
    .map((n) => join(CORE, 'issues', n));

  it('walks every issue standing writer', () => {
    expect(writers.map((f) => relative(CORE, f))).toContain('issues/standing.ts');
    expect(writers.length).toBeGreaterThan(5);
  });

  it('says no answer, decision or supply act in any of them', () => {
    const found = writers.filter((f) => ANSWER_ACTS.test(readFileSync(f, 'utf8')));
    expect(found.map((f) => relative(CORE, f))).toEqual([]);
  });

  it('tells the steward no note names a person or role who must act on an issue', () => {
    expect(actPrompt('note')).toContain(
      'No note names a person or a role who must act on an issue',
    );
  });
});
