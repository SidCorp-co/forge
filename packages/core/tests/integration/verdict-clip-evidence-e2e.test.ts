/**
 * REQ-40 BC-4: QA keeps a short screen clip of each observable criterion it judges, as verdict
 * evidence. The clip goes up as an issue attachment (`POST /api/issues/:id/attachments`, a webm
 * part), the verdict cites it by the name core kept, and the file plays back from its download URL
 * with its own type. Through the app's own routes, against real Postgres.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../src/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';

const SHIPPED = '0d91ae7c74f70295ede115463b17559e650b5207';
// the EBML header every webm opens with, then filler: core stores bytes, it does not decode video
const webm = (bytes: number): Uint8Array<ArrayBuffer> => {
  const b = new Uint8Array(bytes);
  b.set([0x1a, 0x45, 0xdf, 0xa3]);
  return b;
};

let token: string;
let issueId: string;

beforeEach(async () => {
  await truncateAll();
  const ownerId = (await createTestUser({ verified: true })).id;
  const projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  issueId = (
    await createTestIssue(projectId, ownerId, 1, {
      status: 'in_progress',
      createdAt: new Date(),
    })
  ).id;
  const set = await api(token, 'PATCH', `/api/issues/${issueId}`, {
    acceptanceCriteria: '1. The report names its source',
  });
  expect(set.status, JSON.stringify(set.body)).toBeLessThan(300);
});

const upload = (name: string, type: string, bytes: Uint8Array<ArrayBuffer>) => {
  const fd = new FormData();
  fd.append('file', new File([bytes], name, { type }));
  return app.fetch(
    new Request(`http://forge.test/api/issues/${issueId}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: fd,
    }),
  );
};

describe('a verdict cites a clip kept as an issue attachment', () => {
  it('stores the webm under its own type, cites it, and plays it back byte for byte', async () => {
    const clip = webm(4096);
    const up = await upload('bc-1.webm', 'video/webm', clip);
    expect(up.status, await up.clone().text()).toBe(201);
    const kept = (await up.json()) as { id: string; name: string; mime: string };
    expect(kept).toMatchObject({ name: 'bc-1.webm', mime: 'video/webm' });

    const v = await api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
      criterion: 1,
      verdict: 'pass',
      reason: 'Opened the report; the source line names run r-7',
      identity: { kind: 'commit', sha: SHIPPED },
      evidence: [kept.name],
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);

    const rows = await api(token, 'GET', `/api/issues/${issueId}/criteria`);
    const latest = (rows.body.criteria as Array<{ latest: { evidence: string[] } | null }>)[0]
      ?.latest;
    expect(latest?.evidence).toEqual(['bc-1.webm']);

    const listed = await api(token, 'GET', `/api/issues/${issueId}/attachments`);
    expect(
      (listed.body as unknown as Array<{ name: string; mime: string }>).map((a) => [
        a.name,
        a.mime,
      ]),
    ).toEqual([['bc-1.webm', 'video/webm']]);
    const played = await app.fetch(
      new Request(`http://forge.test/api/attachments/${kept.id}/download`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(played.status).toBe(200);
    expect(played.headers.get('content-type')).toContain('video/webm');
    expect(new Uint8Array(await played.arrayBuffer())).toEqual(clip);
  });

  it('takes an mp4 clip too, and refuses a type that is neither a picture nor a clip by name', async () => {
    const mp4 = await upload('bc-1.mp4', 'video/mp4', new Uint8Array(512).fill(7));
    expect(mp4.status, await mp4.clone().text()).toBe(201);
    const exe = await upload('bc-1.exe', 'application/x-msdownload', new Uint8Array(64).fill(1));
    expect(exe.status).toBeGreaterThanOrEqual(400);
    expect(exe.status).toBeLessThan(500);
    expect(JSON.stringify(await exe.json())).toMatch(/not allowed|unsupported|mime|type/i);
  });
});
