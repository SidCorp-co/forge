/**
 * A requirement written in Vietnamese is agreed on its goal's own labels. adminhub-api REQ-2 on dev,
 * 2026-10-22 (`writtenLang: vi`, goal lines "Vấn đề:", "Giá trị:", "Đo bằng:") was refused
 * CHECKLIST_INCOMPLETE "Its goal does not state the value it gives, after "Value:"". The text is kept
 * as written and never translated (`@forge/contracts/written-lang`), so its labels are read in its
 * own language, and English ones in any (requirement-lifecycle guide, the agree). // i18n-allow: the labels quoted
 *
 * @direct-test-of packages/core/src/requirements/checklist-record.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, makeAgreeReady, rows } from '../helpers/factories.js';

let projectId = '';
let ownerId = '';
let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
const as = (method: string, path: string, body?: unknown) =>
  say('owner', method, `/api/projects/${projectId}${path}`, body);

const GOAL = [
  'Người và agent làm AdminHub API có DB MySQL local giống schema release/stg, dựng hoặc reset bằng một lệnh.', // i18n-allow: the requirement as written on dev
  'Vấn đề: hiện DB test chỉ được dựng tay một lần, chưa có dữ liệu mẫu.', // i18n-allow: the requirement as written on dev
  'Giá trị: test và phát triển chạy được ngay trên máy, kết quả lặp lại được.', // i18n-allow: the requirement as written on dev
  'Đo bằng: bộ test chạy xanh trên DB mới dựng.', // i18n-allow: the requirement as written on dev
].join('\n');

/** A draft requirement whose head revision is written in `lang` with `goal`, ready for its agree. */
async function written(lang: 'vi' | 'en', goal: string): Promise<string> {
  const key = ok(
    await as('POST', '/requirements', {
      title: 'Local MySQL for every run',
      reason: 'runs share a hand-built database',
      criteria: [{ body: 'Each run gets its own database.' }],
    }),
    201,
  ).key as string;
  const seq = Number(key.slice(4));
  await makeAgreeReady(projectId, seq, ownerId);
  await rows(sql`
    UPDATE requirement_revisions rv SET written_lang = ${lang},
           spec = rv.spec || jsonb_build_object('goal', ${goal}::text)
      FROM requirements r
     WHERE rv.requirement_id = r.id AND r.project_id = ${projectId} AND r.req_seq = ${seq}`);
  ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
  ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'ok' }));
  return key;
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  say = requester(app, { owner: await signUserToken(ownerId) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("the agree reads a goal's labels in the language it is written in", () => {
  it('agrees the Vietnamese requirement adminhub-api REQ-2 was refused, on its own labels', async () => {
    const key = await written('vi', GOAL);
    const agreed = await as('POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'đồng ý',
    }); // i18n-allow: a reason in the requirement's language
    expect(agreed.status, JSON.stringify(agreed.json)).toBe(200);
  });

  it('still refuses an English requirement with no value line, naming the English label only', async () => {
    const key = await written('en', 'Problem: runs share one database.\nGiá trị: không.'); // i18n-allow: a label an English requirement does not read
    const refused = await as('POST', `/requirements/${key}/agree`, { revision: 1, reason: 'ok' });
    expect([refused.status, refused.json.code]).toEqual([422, 'CHECKLIST_INCOMPLETE']);
    expect(JSON.stringify(refused.json)).toContain('the value it gives, after \\"Value:\\"');
  });

  // ISS-732 c1: the judge's goal on dev.347, the Value: line above the unlabelled problem line
  it('agrees a goal whose unlabelled problem line sits below its Value: line', async () => {
    const key = await written(
      'en',
      'Value: every referral reaches a clinician.\nReferral managers lose referrals between intake and triage.\nMeasured by: lost referrals per month.',
    );
    const agreed = await as('POST', `/requirements/${key}/agree`, { revision: 1, reason: 'ok' });
    expect(agreed.status, JSON.stringify(agreed.json)).toBe(200);
  });

  it('refuses a goal with no problem line, naming where the line goes', async () => {
    const key = await written('en', 'Value: v.\nMeasured by: m.');
    const refused = await as('POST', `/requirements/${key}/agree`, { revision: 1, reason: 'ok' });
    expect([refused.status, refused.json.code]).toEqual([422, 'CHECKLIST_INCOMPLETE']);
    expect(JSON.stringify(refused.json)).toContain(
      'a line of its own with no label, or after \\"Problem:\\"',
    );
  });

  // ISS-770, catalog-fe REQ-9 r1: "Đo bằng:" with bullets below it read as the problem and the measure unstated
  it('agrees a goal whose Đo bằng: and Value: stand alone over a list', async () => {
    const vi = await written(
      'vi',
      'Vấn đề: DB test dựng tay.\nGiá trị: chạy được trên máy.\nĐo bằng:\n- bộ test xanh\n- DB sẵn sàng trong vài phút', // i18n-allow: the requirement as written on dev
    );
    const agreedVi = await as('POST', `/requirements/${vi}/agree`, { revision: 1, reason: 'ok' });
    expect(agreedVi.status, JSON.stringify(agreedVi.json)).toBe(200);
    const en = await written(
      'en',
      'Problem: runs share one database.\nValue:\n- every run has its own\nMeasured by: no run breaks another.',
    );
    const agreedEn = await as('POST', `/requirements/${en}/agree`, { revision: 1, reason: 'ok' });
    expect(agreedEn.status, JSON.stringify(agreedEn.json)).toBe(200);
  });

  it('still refuses a Measured by: followed directly by another label, naming it', async () => {
    const key = await written(
      'en',
      'Problem: runs share one database.\nValue: each has its own.\nMeasured by:\nRoadmap: now.',
    );
    const refused = await as('POST', `/requirements/${key}/agree`, { revision: 1, reason: 'ok' });
    expect([refused.status, refused.json.code]).toEqual([422, 'CHECKLIST_INCOMPLETE']);
    expect(JSON.stringify(refused.json)).toContain('how success is measured, after');
  });
});
