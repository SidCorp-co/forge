// @direct-test-of packages/core/src/questions/cards.ts
// @direct-test-of packages/core/src/prompt/facts/affordance-cards.ts
// A run reads its map and its release block at the moment it parks, asks, marks or aborts; each door
// it acts through teaches itself on its card (ISS-1251), read before its first use. Each act that
// says what it waits on or carries is named on its door's card with the refusals that hold it, and
// every refusal any card names is one core can return: a misspelt code teaches a refusal no reader
// will meet.

import { MERGE_REFUSAL_CODES } from '@forge/contracts/issues';
import { MEMORY_REFUSAL_CODES } from '@forge/contracts/memory';
import { QUESTION_REFUSAL_CODES, questionAboutRequestSchema } from '@forge/contracts/questions';
import { RELEASE_BLOCKER_CODES, RELEASE_REFUSAL_CODES } from '@forge/contracts/releases';
import { describe, expect, it } from 'vitest';
import { memorySources } from '../../db/schema-vocabulary.js';
import { ISSUE_FLOW_GUIDE } from '../../guides/issue-flow-guide.js';
import { type CatalogDoor, cardText } from '../../lib/door-catalog.js';
import { servedDoorCatalog } from '../../mcp/door-catalog.js';
import { releaseBatchStatePrompt } from '../state-prompts/release-batch.js';
import {
  DRIVE_RULES_TEXT,
  DRIVE_TOOL_REFERENCE_TEXT,
  STEP_TOOL_REFERENCE_TEXT,
} from './drive-rules.js';

const CODES = new Set<string>([
  ...QUESTION_REFUSAL_CODES,
  ...MERGE_REFUSAL_CODES,
  ...RELEASE_REFUSAL_CODES,
  ...RELEASE_BLOCKER_CODES,
  ...MEMORY_REFUSAL_CODES,
]);
const unknown = (text: string) =>
  [...text.matchAll(/\b(?:QUESTION|ARTIFACT_CARRIER|RELEASE|MEMORY)_[A-Z_]+\b/g)]
    .map((m) => m[0])
    .filter((code) => !CODES.has(code));

// a key quoted on its own, not under `requirement`, is the bare string the ask route refuses
const bareRequirementKeys = (text: string) =>
  text.split('"REQ-n"').length - text.split('{"requirement":"REQ-n"}').length;

const catalog = servedDoorCatalog();
const card = (id: string) =>
  cardText(catalog.doors.find((d) => d.id === id || d.card?.id === id) as CatalogDoor);
const ASK = card('POST /api/questions');
const MOVE = card('POST /api/issues/:id/transition');
const MARK = card('POST /api/issues/:id/merge');

describe("a run's doors teach, on their cards, the acts that name what they wait on", () => {
  it.each([
    ['a drive run', DRIVE_TOOL_REFERENCE_TEXT],
    ['a pipeline step', STEP_TOOL_REFERENCE_TEXT],
  ])('%s is pointed at its map and at the card of a door before its first use', (_who, text) => {
    expect(text).toContain('`## Your map`');
    expect(text).toContain('`guides/doors.md?door=<the door as the map names it>`');
    expect(unknown(text)).toEqual([]);
  });

  it('parks on a merge mark by name', () => {
    for (const word of ['"awaitsMerge":{"issueId":"<id>"}', 'QUESTION_MERGE_ALREADY_MARKED']) {
      expect(MOVE).toContain(word);
    }
  });

  it('sends ordering between issues to a blocks edge, not a park (ISS-738)', () => {
    for (const word of [
      'a park is only for an act a person owes',
      "your issue waits on another issue's landing",
      '`blocks` edge',
      'QUESTION_MERGE_IS_ORDERING',
      'naming this issue instead of describing it',
    ]) {
      expect(MOVE).toContain(word);
    }
  });

  it('asks a business question about its requirement', () => {
    for (const word of [
      '{"requirement":null}',
      '{"contract":"<project>/<contract>"}',
      'QUESTION_ABOUT_UNKNOWN',
      'QUESTION_ABOUT_NO_REQUIREMENT',
      'QUESTION_ABOUT_ON_MERGE_WAIT',
      'QUESTION_ABOUT_ON_DESIGN_WAIT',
      'park once with `needs` and the same `about`',
      '{"requirement":"REQ-n"}',
      'QUESTION_ABOUT_SHAPE',
    ]) {
      expect(ASK).toContain(word);
    }
    expect(MOVE).toContain('QUESTION_ABOUT_REQUIRED');
  });

  it('teaches `about` only in the shape the ask route takes', () => {
    const taught = [
      ...ASK.matchAll(/\{"(?:requirement|contract|feedback)":(?:null|"[^"]*")\}/g),
    ].map((m) => m[0]);
    expect(taught.length).toBeGreaterThanOrEqual(4);
    for (const about of taught) {
      const sent = JSON.parse(about.replace('<project>/<contract>', 'billing/invoices'));
      expect(questionAboutRequestSchema.safeParse(sent).success, about).toBe(true);
    }
    expect(bareRequirementKeys(ASK)).toBe(0);
  });

  it('catches a requirement key offered bare as `about`', () => {
    expect(bareRequirementKeys('`{"requirement":null}`; or `"REQ-n"`')).toBe(1);
  });

  it('marks an artifact another issue carries', () => {
    for (const word of ['"carriedBy":"<that issue\'s key>"', 'ARTIFACT_CARRIER_SHIPPED']) {
      expect(MARK).toContain(word);
    }
  });

  it('every card names only refusals core returns', () => {
    const named = catalog.doors.flatMap((d) =>
      d.card ? unknown(cardText(d)).map((code) => `${d.id}: ${code}`) : [],
    );
    expect(named).toEqual([]);
  });
});

describe('a release run says what left when it stops', () => {
  it('names carried, the refusal a silence earns, and the contradiction', () => {
    for (const word of [
      '"carried":[{"kind":"tag","name":"v1.4.0"}]',
      '"carried":[]',
      'RELEASE_VERSION_UNDECIDED',
      'RELEASE_CARRIED_CONTRADICTS',
    ]) {
      expect(releaseBatchStatePrompt).toContain(word);
    }
  });

  it('names only refusals core returns', () => {
    expect(unknown(releaseBatchStatePrompt)).toEqual([]);
  });

  // REQ-40 BC-7, BC-9: the release page reads what an admin must do from the range the run reports
  it('reports its range from the checkout before finish, by the verb the runner ships', () => {
    const report = releaseBatchStatePrompt.indexOf(
      'forge-runner release range --project-id <projectId> --run <runId> --head <sha>',
    );
    expect(report).toBeGreaterThan(-1);
    expect(report).toBeLessThan(releaseBatchStatePrompt.indexOf('/finish -X POST'));
  });

  it('catches a refusal no code list holds', () => {
    expect(unknown('refused `RELEASE_VERSION_UNDECIDE`')).toEqual(['RELEASE_VERSION_UNDECIDE']);
  });

  // ISS-1076 (FB-542): agenfold's `batch-release-0.189.0` and `gate-v0.190.0` outlived their release
  it('removes the trees it made once it finishes or aborts, and names one it cannot', () => {
    const rule = releaseBatchStatePrompt.slice(releaseBatchStatePrompt.indexOf('Leave no tree'));
    expect(rule).toContain('git worktree remove --force <path>');
    expect(rule).toContain('status --porcelain');
    expect(rule).toContain("as the master's to remove");
  });
});

describe('a run writes memory another reader can trust', () => {
  it('names a foreign key by its project, keeps logs out, and gives an outdated verdict its reason', () => {
    for (const word of [
      '`<its slug> ISS-n`',
      'never as a `decision`',
      'MEMORY_EVIDENCE_REQUIRED',
      'MEMORY_DECISION_NOT_MEMORY',
      'an `unverified` hit is a lead to check, never a fact',
    ]) {
      expect(DRIVE_RULES_TEXT).toContain(word);
    }
    expect(MEMORY_REFUSAL_CODES).toContain('MEMORY_EVIDENCE_REQUIRED');
    expect(MEMORY_REFUSAL_CODES).toContain('MEMORY_DECISION_NOT_MEMORY');
  });

  // REQ-23 BC-2: the prompt names the guide that says it, and the guide says it
  it('says a flagged hit carries its reason and its curation, and a write carries its four answers (ISS-1121)', () => {
    expect(DRIVE_RULES_TEXT).toContain(
      "What a hit's `staleReason` and `curation` mean: `GET /api/guides/issue-flow.md`.",
    );
    for (const word of ['"value":', '"type":', '"scope":', '"recheckWhen":', '`updates`']) {
      expect(DRIVE_RULES_TEXT).toContain(word);
    }
    expect(ISSUE_FLOW_GUIDE.body.replace(/\s+/g, ' ')).toContain(
      "a hit's `curation` says its type, and a `hypothesis` is a lead, never a fact",
    );
    expect(memorySources).not.toContain('bookkeeping');
  });
});
