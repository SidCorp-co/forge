import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ChannelWorld,
  changeRequest,
  decision,
  ok,
  openChannelWorld,
  refusal,
  rfi,
  type Speaker,
  speaker,
} from '../helpers/channel-world.js';
import { type Doc, refusedByDb } from '../helpers/ecosystem-world.js';

let w: ChannelWorld;
let say: ReturnType<typeof speaker>;

beforeAll(async () => {
  w = await openChannelWorld();
  say = speaker(w);
}, 120_000);

afterAll(async () => {
  await w.harness.cleanup();
});

const forge = () => `/api/projects/${w.project.forge}/channel`;
const plugin = () => `/api/projects/${w.project.plugin}/channel`;
const store = () => `/api/projects/${w.project.store}/channel`;

async function draft(who: Speaker, base: string, d: Doc): Promise<string> {
  return ok(await say(who, 'POST', `${base}/drafts`, d)).id;
}
const submit = (who: Speaker, base: string, id: string) =>
  say(who, 'POST', `${base}/documents/${id}/submit`);

describe('a person holds a conversation, and no agent adds to it until it is released', () => {
  it('opens FP-CR-1 from the plugin master', async () => {
    const id = await draft('masterPlugin', plugin(), changeRequest(w));
    expect(ok(await submit('masterPlugin', plugin(), id)).document.number).toBe('FP-CR-1');
  });

  it('refuses a hold without a reason, by an agent, by a viewer, and for a non-party', async () => {
    const hold = (who: Speaker, base: string, body: Doc) =>
      say(who, 'POST', `${base}/threads/FP-CR-1/hold`, body);
    expect(refusal(await hold('platform', forge(), {}))).toEqual(['HOLD_WITHOUT_REASON /reason']);
    expect(refusal(await hold('masterForge', forge(), { reason: 'stop' }))).toEqual([
      'HOLD_NOT_AUTHORISED /by',
    ]);
    expect(refusal(await hold('viewer', plugin(), { reason: 'stop' }))).toEqual([
      'HOLD_NOT_AUTHORISED /by',
    ]);
    expect(refusal(await hold('store', store(), { reason: 'stop' }))).toEqual([
      'HOLD_NOT_AUTHORISED /side',
    ]);
    expect(refusal(await hold('platform', forge(), { reason: '' }))).toEqual([
      'HOLD_WITHOUT_REASON /reason',
    ]);
  });

  it('refuses a hold on a reply or on a number nobody published', async () => {
    const reply = await say('platform', 'POST', `${forge()}/threads/FP-CR-99/hold`, {
      reason: 'x',
    });
    expect(refusal(reply)).toEqual(['REF_UNRESOLVED /thread']);
  });

  it('holds it through the assistant, under the person', async () => {
    const res = ok(
      await say('platformTurn', 'POST', `${forge()}/threads/FP-CR-1/hold`, {
        reason: 'I want to talk the scope through first',
      }),
    );
    expect(res).toMatchObject({ held: true });
    expect(res.hold.by).toEqual({ kind: 'person', id: w.user.platform, via: 'assistant' });
    const again = await say('platform', 'POST', `${forge()}/threads/FP-CR-1/hold`, { reason: 'x' });
    expect(refusal(again)).toEqual(['THREAD_ALREADY_HELD /thread']);
  });

  it('shows the hold to both sides', async () => {
    const theirs = ok(await say('plugin', 'GET', `${plugin()}/documents/FP-CR-1`));
    expect(theirs.hold).toMatchObject({ action: 'hold', side: w.project.forge });
    const thread = ok(await say('platform', 'GET', `${forge()}/threads/FP-CR-1`));
    expect(thread.holds).toHaveLength(1);
  });

  it('refuses the forge master answering it, and spends no number', async () => {
    const id = await draft('masterForge', forge(), decision(w, 'FP-CR-1'));
    expect(refusal(await submit('masterForge', forge(), id))).toEqual(['THREAD_HELD /inReplyTo']);
    const stored = ok(await say('masterForge', 'GET', `${forge()}/documents/${id}`));
    expect(stored.document).toMatchObject({ state: 'draft', number: null });
  });

  it('lets the person answer it themselves, as the author', async () => {
    const id = await draft('platform', forge(), decision(w, 'FP-CR-1'));
    const res = ok(await submit('platform', forge(), id));
    expect(res.document).toMatchObject({
      number: 'FP-DEC-1',
      authoredBy: { kind: 'person', id: w.user.platform, via: 'web' },
    });
  });

  it('takes the submitter as the author, so an agent cannot publish into it through a person draft', async () => {
    const id = await draft('platform', forge(), decision(w, 'FP-CR-1'));
    expect(refusal(await submit('masterForge', forge(), id))).toEqual(['THREAD_HELD /inReplyTo']);
  });

  it('is released by a person on the other side, and the master may answer again', async () => {
    const res = ok(await say('plugin', 'POST', `${plugin()}/threads/FP-CR-1/release`, {}));
    expect(res).toMatchObject({ held: false });
    const free = await say('plugin', 'POST', `${plugin()}/threads/FP-CR-1/release`, {});
    expect(refusal(free)).toEqual(['THREAD_NOT_HELD /thread']);
    const id = await draft('masterForge', forge(), decision(w, 'FP-CR-1'));
    expect(ok(await submit('masterForge', forge(), id)).document.number).toBe('FP-DEC-2');
  });

  it('keeps holds write-once and a person’s in the database', async () => {
    await refusedByDb(
      w.harness.db.execute(sql`DELETE FROM channel_thread_holds WHERE thread = 'FP-CR-1'`),
      /channel_thread_holds is write-once/,
    );
    await refusedByDb(
      w.harness.db.execute(sql`
        INSERT INTO channel_thread_holds (id, ecosystem_id, thread, action, by_kind, by_id, by_via, user_id, side_project_id, reason)
        VALUES (gen_random_uuid(), ${w.eco}, 'FP-CR-1', 'hold', 'agent', 'm', 'master', ${w.agent.forge}, ${w.project.forge}, 'x')`),
      /channel_thread_holds_person_chk/,
    );
  });
});

describe('a type the ecosystem gates with approve waits for a person on the sending side', () => {
  const setGate = async (mode: 'approve' | 'publish') => {
    const now = ok(await say('platform', 'GET', `/api/ecosystems/${w.eco}`));
    now.document.gate.rfi = mode;
    ok(
      await say('platform', 'PUT', `/api/ecosystems/${w.eco}`, {
        baseRevision: now.revision,
        document: now.document,
      }),
    );
  };
  const gate = (who: Speaker, id: string, body: Doc) =>
    say(who, 'POST', `${forge()}/documents/${id}/gate`, body);
  let id = '';

  it('stops a submitted RFI at the gate, numbered, out of the inbox', async () => {
    await setGate('approve');
    id = await draft('masterForge', forge(), rfi(w));
    const res = ok(await submit('masterForge', forge(), id));
    expect(res.document).toMatchObject({
      state: 'submitted',
      number: 'FP-RFI-1',
      gate: { mode: 'approve' },
    });
    const inbox = ok(await say('masterPlugin', 'GET', `${plugin()}/inbox`));
    expect(inbox.documents.some((d: Doc) => d.document.number === 'FP-RFI-1')).toBe(false);
    expect((await say('plugin', 'GET', `${plugin()}/documents/FP-RFI-1`)).status).toBe(404);
  });

  it('refuses an agent at the gate, and a return without a note', async () => {
    expect(refusal(await gate('masterForge', id, { decision: 'approved' }))).toEqual([
      'GATE_NOT_AUTHORISED /gate/decidedBy',
    ]);
    expect(refusal(await gate('platform', id, { decision: 'returned' }))).toEqual([
      'GATE_RETURN_WITHOUT_NOTE /gate/note',
    ]);
  });

  it('returns it with a note, keeps the number through the edit, and resubmits', async () => {
    const back = ok(await gate('platform', id, { decision: 'returned', note: 'name the version' }));
    expect(back.document).toMatchObject({ state: 'returned', gate: { decision: 'returned' } });
    const { ecosystem: _e, ...input } = rfi(w);
    input.body.references[0].contractVersion = '2026-09-28';
    const edited = ok(await say('masterForge', 'PUT', `${forge()}/documents/${id}`, input));
    expect(edited.document).toMatchObject({ state: 'draft', number: 'FP-RFI-1' });
    expect(ok(await submit('masterForge', forge(), id)).document).toMatchObject({
      state: 'submitted',
      number: 'FP-RFI-1',
    });
  });

  it('refuses approval once the ecosystem gates the type with publish', async () => {
    await setGate('publish');
    expect(refusal(await gate('platform', id, { decision: 'approved' }))).toEqual([
      'GATE_MODE_MISMATCH /gate/mode',
    ]);
    await setGate('approve');
  });

  it('publishes on approval, and the recipient sees it', async () => {
    const res = ok(await gate('platform', id, { decision: 'approved' }));
    expect(res.document).toMatchObject({
      state: 'published',
      gate: { mode: 'approve', decision: 'approved', decidedBy: w.user.platform },
    });
    const inbox = ok(await say('masterPlugin', 'GET', `${plugin()}/inbox`));
    expect(inbox.documents.some((d: Doc) => d.document.number === 'FP-RFI-1')).toBe(true);
  });
});
