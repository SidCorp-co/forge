import type { ChatRole } from '@forge/contracts/support-operations';
import { describe, expect, it } from 'vitest';
import { BRIEF_CHANGED_LEAD } from '../brief-told.js';
import { operationsBrief } from '../ops-prompt.js';
import { grantRefusal } from '../ops-role.js';
import { judgeReply } from './judge.js';
import TURNS from './live-turns-1711.json' with { type: 'json' };

// @direct-test-of packages/core/src/support/reply-audit/code-lines.ts
// @direct-test-of packages/core/src/support/ops-prompt.ts
// @direct-test-of packages/core/src/support/ops-role.ts
// @direct-test-of packages/core/src/support/brief-told.ts
//
// ISS-1251 c11: on dev.709 Babo repeated two of the five ISS-1250 defects live, in Forge-Communicate's
// thread 86aGq at 17/11 05:55:33 and 05:58:32: grant talk ("my role may only read…") and the owner
// sent to the UI ("please create it in the Feedback section"). A scenario that matched teaching text passed
// while the agent failed. Here each turn is replayed from what its agent was really handed (the brief
// its resident session held, told on 15/11; the turn's text; the refusal its act got), and its real
// reply is judged by the rubric lines code tells. The replies fail; the input the agent held taught
// what it did, and the input this build hands the same session teaches the need raised in the
// technical channel and one line to the thread, never the grant and never a screen.

const BABO: ChatRole = { name: 'babo', persona: '', grants: ['read', 'deliver'] };

const judged = (reply: string) =>
  judgeReply({ text: reply, language: 'vi', roomKind: 'operations', apiHosts: [] }, []);

/** What an agent following a turn's input must be told, each the opposite of what Babo did. */
const NEEDS: readonly [string, RegExp][] = [
  ['raise a missing grant in the technical channel', /support\.technical \{ thread, need/],
  [
    'never say what the role may not do',
    /never (?:tell it )?what (?:you or your role|this role) may not do/i,
  ],
  ['never send anyone to a screen', /never (?:send anyone to )?a page,? (?:or )?a section/i],
  ['keep who wrote it in the member record', /support\.member \{ member, roles, message \}/],
];

const missing = (input: string) => NEEDS.filter(([, re]) => !re.test(input)).map(([n]) => n);

const [first, second] = TURNS.turns;
if (!first?.refusal || !second) throw new Error('live-turns-1711.json holds the two 17/11 turns');

describe('the 17/11 Forge-Communicate turns, replayed from their real input (c11)', () => {
  it('fails each real reply on the lines code tells', () => {
    expect(judged(first.reply).failed.sort()).toEqual(['no_grant_talk', 'no_ui_directions']);
    expect(judged(second.reply).failed).toEqual(['no_ui_directions']);
  });

  it('passes the reply the turn owed: one line that it is in hand', () => {
    const owed = 'Dạ, em đã chuyển hai ý của anh cho ePOD, việc này đang được xử lý ạ.'; // i18n-allow: the reply the quoted turn owed
    expect(judged(owed)).toMatchObject({ verdict: 'pass', failed: [] });
  });

  it('reads in what the session held the grant talk it repeated, and none of what it owed', () => {
    const held = [TURNS.heldBrief.text, first.handed, first.refusal].join('\n\n');
    expect(held).toContain('say in the thread what the refusal says and who can do it instead');
    expect(missing(held)).toEqual([
      'raise a missing grant in the technical channel',
      'never say what the role may not do',
      'never send anyone to a screen',
      'keep who wrote it in the member record',
    ]);
  });

  it('hands the same session, on the same turn, the brief again and a refusal that teach each need', () => {
    const brief = operationsBrief({
      role: BABO,
      scope: 'forge',
      reach: [{ slug: 'epod', name: 'ePOD', issuePrefix: 'ISS' }] as never,
    });
    const refusal = grantRefusal(BABO, 'draft_feedback');
    if (!refusal || refusal.ok) throw new Error('babo is refused draft_feedback');
    const detail = refusal.refusals[0]?.detail ?? '';
    const now = [`${BRIEF_CHANGED_LEAD}\n\n${brief}`, first.handed, detail].join('\n\n');
    expect(missing(now)).toEqual([]);
    expect(now).not.toContain('who can do it instead');
    // the refusal alone teaches the next step, for a session that reads nothing else
    expect(missing(detail)).toEqual(['keep who wrote it in the member record']);
  });
});
