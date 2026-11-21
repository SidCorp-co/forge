import type { ChatRole } from '@forge/contracts/support-operations';
import { describe, expect, it } from 'vitest';
import { BRIEF_CHANGED_LEAD } from '../brief-told.js';
import { operationsBrief } from '../ops-prompt.js';
import { grantRefusal } from '../ops-role.js';
import { roomDayOf } from '../room-day.js';
import { correctionIn, screenClaimIn } from './code-lines.js';
import { judgeReply } from './judge.js';
import TURNS from './live-turns-1711.json' with { type: 'json' };
import PGPRINTS from './pgprints-1911.json' with { type: 'json' };

// @direct-test-of packages/core/src/support/reply-audit/code-lines.ts
// @direct-test-of packages/core/src/support/ops-prompt.ts
// @direct-test-of packages/core/src/support/ops-role.ts
// @direct-test-of packages/core/src/support/brief-told.ts
// @direct-test-of packages/core/src/support/room-day.ts
// @direct-test-of packages/core/src/support/screen-claims.ts
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
  judgeReply(
    {
      text: reply,
      language: { language: 'vi', from: 'asker' },
      roomKind: 'operations',
      apiHosts: [],
    },
    [],
  );

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

// ISS-1356 c6 (owner 2026-11-19: "it confirms UI that is not there"): the PGPrints thread of 19/11,
// replayed from the lines the issue quotes (`pgprints-1911.json`: the one member line, the owner's
// three, and the agent's posts, a paraphrased one marked so). No turn of it looked at a screen, and
// its day is counted as the room's daily line counts it; the replies the turns owed, each made after
// a look or saying it has not seen the screen, pass and leave the day clean.
describe('the 19/11 PGPrints thread, replayed through the audit and the daily line (ISS-1356)', () => {
  const noLook = { thisTurn: false, earlierAt: null, looked: false };
  const looked = { thisTurn: true, earlierAt: null, looked: true };
  const judgedIn = (text: string, reads: typeof noLook) =>
    judgeReply(
      { text, language: { language: 'vi', from: 'asker' }, roomKind: 'agent', apiHosts: [], reads },
      [],
    );
  const at = (s: string) => new Date(s);
  const posted = (n: number) => PGPRINTS.agent[n]?.text ?? '';
  const OWED = {
    // asked that the mapping item is not there, from a look on staging, the hidden item filed
    mapping:
      'Em vừa xem màn hình nhà cung cấp trên staging: mục Product Type Mapping chưa hiện trong menu. Em đã báo lỗi này cho đội AdminHub, có kết quả em báo chị ngay ạ.', // i18n-allow: the reply the quoted turn owed
    // where no look could be taken: said so, and what is being done
    unseen:
      'Em chưa xem được màn hình này, em đang nhờ đội AdminHub mở trên staging và sẽ báo chị ạ.', // i18n-allow: the reply the quoted turn owed
  };

  it('fails the 05:53 and 06:38 posts on accurate, each saying what the menu shows with no look', () => {
    for (const n of [2, 3]) {
      const j = judgedIn(posted(n), noLook);
      expect(j.failed, posted(n)).toEqual(['accurate']);
      expect(j.findings[0]?.why).toMatch(
        /^it says what a screen shows \(".+"\) and this turn took no look at it$/,
      );
    }
  });

  it('fails the guide step that types ?tab=2 into the address bar, a hidden item to file, not a step to send', () => {
    const j = judgedIn(posted(1), noLook);
    expect(j.failed).toEqual(['no_ui_directions']);
    expect(j.findings[0]?.why).toContain("goes to the project's master as a UI defect");
  });

  it('passes the replies the turns owed: what a look showed, or that the screen was not seen yet', () => {
    expect(judgedIn(OWED.mapping, looked)).toMatchObject({ verdict: 'pass', failed: [] });
    expect(judgedIn(OWED.unseen, noLook)).toMatchObject({ verdict: 'pass', failed: [] });
    // a plant: a master said the feature is live, the screen lacks it, and the reply says so from a look
    const plant =
      'Em vừa xem trang đơn hàng trên staging: chưa thấy nút Xuất CSV, em báo đội kỹ thuật ạ.'; // i18n-allow: the planted reply
    expect(judgedIn(plant, looked).verdict).toBe('pass');
    const confirmed = 'Dạ tính năng đã có rồi ạ, nút Xuất CSV hiện ngay trên trang đơn hàng.'; // i18n-allow: the planted wrong reply
    expect(judgedIn(confirmed, noLook).failed).toEqual(['accurate']);
  });

  it("counts the day's corrections, unseen screen claims and waiting owner messages, before and after", () => {
    const until = at('2026-11-19T07:00:00Z');
    const day = (
      texts: readonly string[],
      looks: boolean,
      answers: { thread: string; at: Date }[],
    ) =>
      roomDayOf({
        since: at('2026-11-19T00:00:00Z'),
        until,
        replies: PGPRINTS.agent.map((a, i) => {
          const text = texts[i] ?? '';
          const claim = screenClaimIn(text);
          const correction = correctionIn(text);
          return {
            thread: a.thread,
            message: `m${i}`,
            turn: `t${i}`,
            at: at(a.at),
            marks: {
              ...(claim ? { screen: { claim, looks: looks ? ['box-1'] : [] } } : {}),
              ...(correction ? { correction } : {}),
            },
          };
        }),
        reAsked: new Set(),
        owner: PGPRINTS.owner.map((o, i) => ({ thread: o.thread, message: `o${i}`, at: at(o.at) })),
        answers: answers.map((a) => ({ ...a, message: null })),
      });
    const before = day(
      PGPRINTS.agent.map((a) => a.text),
      false,
      [],
    );
    expect(before.corrections.count).toBe(1);
    expect(before.corrections.items[0]?.words).toBe('xin sửa lại'); // i18n-allow: the quoted correction
    expect(before.screenClaims).toMatchObject({ count: 2, looked: 0 });
    expect(before.ownerWaiting.map((w) => [w.thread, w.answeredAt])).toEqual([
      ['orbit', null],
      ['gwork', null],
      ['sid-mail', null],
    ]);
    expect(before.ownerWaiting[0]?.minutes).toBe(264);
    const after = day(
      [OWED.unseen, OWED.unseen, OWED.mapping, OWED.mapping],
      true,
      PGPRINTS.owner.map((o) => ({
        thread: o.thread,
        at: new Date(at(o.at).getTime() + 10 * 60_000),
      })),
    );
    expect(after.corrections.count).toBe(0);
    expect(after.screenClaims).toMatchObject({ count: 2, looked: 2, unseen: [] });
    expect(after.ownerWaiting).toEqual([]);
  });

  it('reads a correction in either language, and no plain reply as one', () => {
    expect(correctionIn('Correction: the export runs nightly.')).toBe('Correction:');
    expect(correctionIn('Em nhầm, ô này không phụ thuộc Service ạ.')).toBe('Em nhầm'); // i18n-allow: a correction being counted
    expect(correctionIn(OWED.mapping)).toBeNull();
  });

  it('names an owner message answered 30 minutes or more after it, with when', () => {
    const line = roomDayOf({
      since: at('2026-11-19T00:00:00Z'),
      until: at('2026-11-19T07:00:00Z'),
      replies: [],
      reAsked: new Set(),
      owner: [{ thread: 'orbit', message: 'o1', at: at('2026-11-19T02:36:00Z') }],
      answers: [{ thread: 'orbit', message: 'r1', at: at('2026-11-19T03:06:00Z') }],
    });
    expect(line.ownerWaiting).toEqual([
      {
        thread: 'orbit',
        message: 'o1',
        at: '2026-11-19T02:36:00.000Z',
        answeredAt: '2026-11-19T03:06:00.000Z',
        minutes: 30,
      },
    ]);
    const quick = roomDayOf({
      since: at('2026-11-19T00:00:00Z'),
      until: at('2026-11-19T07:00:00Z'),
      replies: [],
      reAsked: new Set(['r1']),
      owner: [{ thread: 'orbit', message: 'o1', at: at('2026-11-19T02:36:00Z') }],
      answers: [{ thread: 'orbit', message: 'r1', at: at('2026-11-19T03:05:00Z') }],
    });
    expect(quick.ownerWaiting).toEqual([]);
  });
});
