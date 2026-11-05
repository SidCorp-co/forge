/**
 * A support room's pictures reach its session (ISS-1010, from FB-518): the agenfold owner posts
 * screenshots as chat uploads, and the channel agent's box has no route to the chat server, so a
 * session handed only a file-upload link asked the person to describe the picture. Core records each
 * picture a member's message carries (its ref, name and type, under the chat-room Assistant's caps),
 * tells the session the message has them and how to read them, hands each back through
 * `support.image` fetched with the bot's credential — a viewable image block over MCP, base64 with
 * its type over REST — and attaches them to the Feedback filed from the thread, where uploads.read
 * reads them. A picture core cannot fetch is refused by name with why.
 *
 * @direct-test-of packages/core/src/support/images.ts
 * @direct-test-of packages/core/src/support/inbound.ts
 * @direct-test-of packages/core/src/support/prompt.ts
 * @direct-test-of packages/core/src/support/tool.ts
 * @direct-test-of packages/core/src/support/acts.ts
 * @direct-test-of packages/core/src/support/routes.ts
 * @direct-test-of packages/core/src/support/record.ts
 * @direct-test-of packages/core/src/support/fixes.ts
 * @direct-test-of packages/core/src/feedback/attachments.ts
 * @direct-test-of packages/core/src/integrations/rocketchat/rest-client.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { ROCKETCHAT_IMAGE_CAPS } from '../../src/integrations/rocketchat/index.js';
import { api, patToken } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { refusalCodes, SupportWorld, type TurnMessage } from '../helpers/support-world.js';

// a 1x1 PNG: a feedback attachment's bytes are sniffed, so it must be one
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG, 'base64');

const w = new SupportWorld();
let chat: StandInRocketChat;

beforeAll(async () => {
  await w.start();
  await w.bind();
  chat = w.chat as StandInRocketChat;
}, 120_000);

afterAll(() => w.stop());

type Answer = Record<string, unknown> & {
  content?: { type: string; text?: string; data?: string; mimeType?: string }[];
  structuredContent?: Record<string, unknown> | null;
};

/** The image block an MCP answer carries, decoded. */
const imageOf = (a: Answer) => {
  const block = a.content?.find((c) => c.type === 'image');
  return block ? { mime: block.mimeType, bytes: Buffer.from(block.data ?? '', 'base64') } : null;
};

/** The thread the first test opens, with its pictures, which the filing test files from. */
let thread = '';

describe('ISS-1010: a support room message hands its pictures to the session', () => {
  it('records each picture under the caps, names them in the message, and reads each through Forge, refusing by name what it cannot fetch', async () => {
    await w.settleWarm();
    let seen: TurnMessage | null = null;
    const reads: Answer[] = [];
    let rest: { status: number; body: Record<string, unknown> } | null = null;
    w.box.model = async (turn, act) => {
      for (const m of turn.messages) {
        if (m.from === 'forge' || !m.images || seen) continue;
        seen = m;
        for (const n of [1, 2, 3, 4, 5]) {
          reads.push((await act({ action: 'image', message: m.message, n })) as Answer);
        }
        // n defaults to the first picture
        reads.push((await act({ action: 'image', message: m.message })) as Answer);
        rest = await api(
          turn.token,
          'POST',
          `/api/projects/${w.projectId}/support/session/images`,
          { message: m.message, n: 1 },
        );
      }
    };
    const posted = await chat.sayWithImages(w.chat.alice, 'Nút thanh toán bị che mất', [
      { name: 'checkout.png', mime: 'image/png', bytes: PNG_BYTES },
      { name: 'gone.png', mime: 'image/png', bytes: PNG_BYTES, status: 404 },
      {
        name: 'huge.png',
        mime: 'image/png',
        bytes: Buffer.alloc(ROCKETCHAT_IMAGE_CAPS.bytes + 1, 1),
      },
      { name: 'denied.png', mime: 'image/png', bytes: PNG_BYTES, status: 403 },
      { name: 'fifth.png', mime: 'image/png', bytes: PNG_BYTES },
    ]);
    thread = posted.id;
    await expect.poll(() => reads.length === 6 && rest !== null, { timeout: 20_000 }).toBe(true);

    // recorded with the message: the first four, under the per-message cap, and the one left over
    const [row] = await rows<{ input: { images?: unknown[]; imagesOmitted?: number } }>(
      sql`SELECT input FROM support_actions WHERE external_id = ${posted.id} AND kind = 'message_in'`,
    );
    expect(row?.input.images).toEqual(
      ['checkout.png', 'gone.png', 'huge.png', 'denied.png'].map((name, i) => ({
        name,
        mime: 'image/png',
        ref: `${chat.serverUrl}/file-upload/${posted.uploads[i]}/${name}`,
      })),
    );
    expect(row?.input.imagesOmitted).toBe(1);

    // the message the session is handed names its pictures and the act that reads them
    const head = seen as unknown as TurnMessage;
    expect(head.images).toEqual({
      count: 4,
      mimes: ['image/png', 'image/png', 'image/png', 'image/png'],
      read: `support.image { message: "${posted.id}", n } with n 1..4`,
      omitted: 1,
    });

    // the first picture comes back as a viewable block, its name framed as data
    const [first, gone, huge, denied, past, byDefault] = reads as [
      Answer,
      Answer,
      Answer,
      Answer,
      Answer,
      Answer,
    ];
    expect(first.isError, JSON.stringify(first)).toBe(false);
    expect(imageOf(first)).toEqual({ mime: 'image/png', bytes: PNG_BYTES });
    expect(first.content?.[0]?.text).toContain('checkout.png');
    expect(first.content?.[0]?.text).toContain('support group member picture');
    expect(first.structuredContent).toEqual({
      message: posted.id,
      n: 1,
      count: 4,
      mime: 'image/png',
      size: PNG_BYTES.byteLength,
      image: { contentIndex: 1, mimeType: 'image/png' },
      note: expect.any(String),
    });
    expect(imageOf(byDefault)).toEqual({ mime: 'image/png', bytes: PNG_BYTES });

    // each one core cannot fetch is refused by name, with why
    expect(refusalCodes(gone), JSON.stringify(gone)).toEqual(['SUPPORT_IMAGE_GONE']);
    expect(JSON.stringify(gone)).toContain('no longer holds it');
    expect(refusalCodes(huge), JSON.stringify(huge)).toEqual(['SUPPORT_IMAGE_TOO_LARGE']);
    expect(refusalCodes(denied), JSON.stringify(denied)).toEqual(['SUPPORT_IMAGE_REFUSED']);
    expect(JSON.stringify(denied)).toContain('answered 403');
    expect(refusalCodes(past), JSON.stringify(past)).toEqual(['SUPPORT_IMAGE_UNKNOWN']);
    expect(JSON.stringify(past)).toContain('n is 1..4');

    // the REST door hands the bytes as base64 with their type
    const got = rest as unknown as { status: number; body: Record<string, unknown> };
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body).toMatchObject({
      message: posted.id,
      n: 1,
      mime: 'image/png',
      dataBase64: PNG,
    });

    // reading posts nothing in the thread
    expect(await w.linesIn(posted.id)).toEqual([]);
  });

  it("never sends the bot's credential to a picture named on another host, and refuses a message the room never received", async () => {
    await w.settleWarm();
    const reads: Answer[] = [];
    w.box.model = async (_turn, act) => {
      for (const m of _turn.messages) {
        if (m.from === 'forge' || !m.text.includes('ảnh ngoài')) continue;
        reads.push((await act({ action: 'image', message: m.message, n: 1 })) as Answer);
        reads.push((await act({ action: 'image', message: 'mNEVER1', n: 1 })) as Answer);
      }
    };
    const readsBefore = chat.uploadReads.length;
    await chat.sayWithImages(w.chat.alice, 'ảnh ngoài', [
      { name: 'elsewhere.png', mime: 'image/png', url: 'http://127.0.0.1:9/elsewhere.png' },
    ]);
    await expect.poll(() => reads.length, { timeout: 20_000 }).toBe(2);
    expect(refusalCodes(reads[0]), JSON.stringify(reads[0])).toEqual(['SUPPORT_IMAGE_OFF_SERVER']);
    expect(refusalCodes(reads[1]), JSON.stringify(reads[1])).toEqual(['SUPPORT_MESSAGE_UNKNOWN']);
    expect(chat.uploadReads.length).toBe(readsBefore);
  });

  it('attaches the thread’s pictures to the Feedback filed from it, readable with uploads.read, and names each that could not go', async () => {
    expect(thread).not.toBe('');
    await w.settleWarm();
    let offer: Record<string, unknown> | null = null;
    w.box.model = async (turn, act) => {
      for (const m of turn.messages) {
        if (m.from === 'forge' || !m.text.includes('ghi lại giúp')) continue;
        offer = await act({
          action: 'record',
          thread: m.thread,
          kind: 'defect',
          title: 'Checkout button is hidden',
          summary: 'The checkout button is cut off on the cart page, as the screenshots show.',
        });
      }
    };
    await w.chat.say(w.chat.alice, 'ghi lại giúp mình nhé', thread);
    await expect.poll(() => offer, { timeout: 15_000 }).not.toBeNull();
    const proposal = String((offer as unknown as Record<string, unknown>).proposal);
    const { out } = await w.agreeBy(w.chat.alice, 'ừ, ghi đi', thread, proposal);
    expect(out, JSON.stringify(out)).toMatchObject({
      recorded: true,
      pictures: {
        attached: 1,
        notAttached: [
          { message: thread, n: 2, code: 'SUPPORT_IMAGE_GONE' },
          { message: thread, n: 3, code: 'SUPPORT_IMAGE_TOO_LARGE' },
          { message: thread, n: 4, code: 'SUPPORT_IMAGE_REFUSED' },
        ],
      },
    });
    expect(String(out.what)).toContain("with 1 of the thread's pictures attached");

    const fb = await w.lastGroupFiling();
    const attached = await rows<{ id: string; name: string; mime: string; size: number }>(sql`
      SELECT a.id, a.name, a.mime, a.size FROM feedback_attachments a JOIN feedback f ON f.id = a.feedback_id
       WHERE f.project_id = ${w.projectId}::uuid AND f.fb_seq = ${fb.fb_seq}`);
    expect(attached).toEqual([
      {
        id: expect.any(String),
        name: 'checkout.png',
        mime: 'image/png',
        size: PNG_BYTES.byteLength,
      },
    ]);

    // the master reads it as it reads any attachment
    const pat = await patToken(w.ownerId, [w.projectId]);
    const fetched = await api(
      pat,
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'forge_uploads',
          arguments: { data: { target: 'feedback', attachmentId: attached[0]?.id } },
        },
      },
      { accept: 'application/json, text/event-stream' },
    );
    expect(fetched.status, JSON.stringify(fetched.body)).toBe(200);
    const result = (fetched.body as { result: Answer }).result;
    expect(imageOf(result)).toEqual({ mime: 'image/png', bytes: PNG_BYTES });
  });
});
