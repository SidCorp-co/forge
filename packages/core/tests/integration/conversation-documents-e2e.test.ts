/**
 * A BA hands the assistant a document (measured on dev 2026-10-08: a .md spec attached on the
 * Requirements page's chat was refused "text/markdown is not a type a conversation takes", the
 * message went without it, and the assistant asked for the file again). A conversation now takes
 * Markdown, plain text, CSV, JSON, PDF and Word files under a cap per type; the assistant reads the
 * document's scrubbed text inside the message that carried it; and a draft requirement takes an
 * attached list as its criteria, line for line. The model is the one thing scripted.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

interface Step {
  tool?: { name: string; args: unknown };
  text?: string;
}
const script: { steps: Step[]; seen: { role: string; content: unknown }[][] } = {
  steps: [],
  seen: [],
};

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openChat: async () => ({
    model: 'scripted',
    provider: {
      id: 'scripted',
      defaultModel: 'scripted',
      async *stream(req: { messages: { role: string; content: unknown }[] }) {
        script.seen.push(req.messages);
        const next = script.steps.shift() ?? { text: 'Done.' };
        if (next.tool) {
          yield {
            type: 'tool_call',
            id: `call-${randomUUID()}`,
            name: next.tool.name,
            arguments: JSON.stringify(next.tool.args),
          };
        } else {
          yield { type: 'chunk', text: next.text ?? '' };
        }
        yield { type: 'done' };
      },
    },
  }),
}));

const SPEC = readFileSync(
  new URL('../fixtures/documents/criteria-120.md', import.meta.url),
  'utf8',
);
const ITEM = /^(?:- \[ \] |- |\d+\. )/;
const SPEC_LINES = SPEC.split('\n');
const STATED = SPEC_LINES.slice(
  SPEC_LINES.indexOf('## Acceptance criteria') + 1,
  SPEC_LINES.indexOf('## Out of scope'),
)
  .filter((l) => ITEM.test(l))
  .map((l) => l.replace(ITEM, ''));
// a planted token in the shape GitHub mints, never a real one
const PLANTED = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`;
const NOTES = `# Deploy notes\n\n- Push with GITHUB_TOKEN=${PLANTED} from the release box.\n`;
const MB = 1024 * 1024;

// biome-ignore lint/suspicious/noExplicitAny: the booted app's own type is not this test's subject
let app: any;
let say: (who: 'person', method: string, path: string, body?: unknown) => Promise<Reply>;
let owner = '';
let projectId = '';
let projectSlug = '';

async function openRoom(): Promise<string> {
  return ok(
    await say('person', 'POST', '/api/conversations', { projectId, title: 'spec', people: [] }),
    201,
  ).id as string;
}

/** Mint a ticket for one file and PUT its bytes, as the composer does; the reply of whichever refused. */
async function attach(room: string, name: string, mime: string, bytes: Buffer): Promise<Reply> {
  const ticket = await say('person', 'POST', `/api/conversations/${room}/attachments`, {
    name,
    mime,
    operationId: randomUUID(),
  });
  if (ticket.status !== 201) return ticket;
  const res = await app.request(`/api/uploads/${ticket.json.uploadId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(bytes),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Doc };
}

function refusal(r: Reply): Doc {
  expect(r.status, JSON.stringify(r.json)).toBeGreaterThanOrEqual(400);
  return r.json?.error?.refusals?.[0] ?? r.json?.error ?? r.json;
}

beforeAll(async () => {
  testEnv();
  ({ app } = await import('../../src/index.js'));
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  owner = (await createTestUser({ verified: true })).id;
  const project = await createTestProject(owner);
  projectId = project.id;
  projectSlug = project.slug;
  await addProjectMember(projectId, owner, 'owner');
  say = requester(app, { person: await signUserToken(owner) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a conversation takes the documents a requirement comes from', () => {
  it('takes the markdown spec it refused on dev, and Markdown, text, CSV, JSON and PDF beside it', async () => {
    const room = await openRoom();
    const md = ok(
      await attach(room, 'hop-parity-crmhp-spec.md', 'text/markdown', Buffer.from(SPEC)),
      201,
    );
    expect(md).toMatchObject({ name: 'hop-parity-crmhp-spec.md', mime: 'text/markdown' });
    for (const [name, mime, body] of [
      ['notes.txt', 'text/plain', 'Meeting notes: the panel opens wide.'],
      ['criteria.csv', 'text/csv', 'code,criterion\nBC-1,The panel opens wide.\n'],
      ['export.json', 'application/json', '{"criteria":["The panel opens wide."]}'],
    ] as const) {
      expect(ok(await attach(room, name, mime, Buffer.from(body)), 201).mime).toBe(mime);
    }
  });

  it('refuses a markdown file over its cap, naming the type, the cap and every type it takes', async () => {
    const room = await openRoom();
    const big = Buffer.alloc(2 * MB + 1, '- The panel opens wide.\n');
    const r = refusal(await attach(room, 'big.md', 'text/markdown', big));
    expect(r.code).toBe('FILE_TOO_LARGE');
    expect(r.detail).toContain(`big.md is ${2 * MB + 1} bytes of text/markdown`);
    expect(r.detail).toContain('takes text/markdown up to 2 MB');
    expect(r.detail).toContain(
      '.png, .jpg, .jpeg, .gif, .webp, .pdf or .docx up to 10 MB; .md, .markdown, .txt, .csv or .json up to 2 MB',
    );
  });

  it('refuses a type it does not take, naming the ones it does', async () => {
    const room = await openRoom();
    const r = refusal(
      await attach(room, 'tool.exe', 'application/x-msdownload', Buffer.from('MZ')),
    );
    expect(r.code).toBe('MIME_NOT_ALLOWED');
    expect(r.detail).toContain('mime not allowed: application/x-msdownload');
    expect(r.detail).toContain('.md, .markdown, .txt, .csv or .json up to 2 MB');
  });

  it('refuses a PDF with no text in it by name, while the person can still attach another', async () => {
    const room = await openRoom();
    const scan = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
    );
    const r = refusal(await attach(room, 'scan.pdf', 'application/pdf', scan));
    expect(r.code).toBe('DOCUMENT_UNREADABLE');
    expect(r.detail).toContain('scan.pdf (application/pdf) cannot be read as a document');
  });

  it('stores a text document with its planted token scrubbed out', async () => {
    const room = await openRoom();
    const stored = ok(
      await attach(room, 'deploy-notes.md', 'text/markdown', Buffer.from(NOTES)),
      201,
    );
    const res = await app.request(stored.url, {
      headers: {
        Authorization: `Bearer ${await (await import('../../src/credentials/jwt.js')).signUserToken(owner)}`,
      },
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).not.toContain(PLANTED);
    expect(body).toContain('GITHUB_TOKEN=[Filtered]');
  });
});

describe('the assistant reads an attached spec and drafts its criteria line for line', () => {
  it('shows the model both documents by name, scrubbed, and drafts all 120 criteria unchanged', async () => {
    const { appendMessages, readRoomDocumentByName } = await import(
      '../../src/conversations/index.js'
    );
    const { runConversationTurn } = await import('../../src/assistant/turn-runner.js');
    const { webConversationTurn } = await import('../../src/assistant/web-turn-inputs.js');
    const { ConversationProgress } = await import('../../src/assistant/conversation-progress.js');
    const { resolveTurnAuthority } = await import('../../src/permissions/index.js');
    const { registerWebConversationAdapter } = await import(
      '../../src/assistant/conversation-drain.js'
    );
    registerWebConversationAdapter();

    const room = await openRoom();
    // the planted token is stored scrubbed already; a second copy proves the turn's own read scrubs too
    const notes = ok(
      await attach(room, 'deploy-notes.md', 'text/markdown', Buffer.from(NOTES)),
      201,
    );
    const spec = ok(await attach(room, 'criteria-120.md', 'text/markdown', Buffer.from(SPEC)), 201);
    const ask = 'Draft a requirement from the acceptance criteria in criteria-120.md.';
    await appendMessages({
      conversationId: room,
      messages: [
        {
          role: 'user',
          content: ask,
          authorUserId: owner,
          authorLabel: null,
          images: [notes, spec].map((f) => ({ name: f.name, mime: f.mime, ref: f.url })),
          silenceReason: null,
        },
      ],
    });
    const read = await readRoomDocumentByName(room, 'deploy-notes.md');
    expect(read.ok && read.text).not.toContain(PLANTED);

    const draft = {
      title: 'HOP parity with the owner mockup',
      reason: 'The owner listed the parity criteria in criteria-120.md.',
      criteria: [],
      criteriaFrom: { file: 'criteria-120.md', section: 'Acceptance criteria' },
    };
    script.seen = [];
    script.steps = [
      { tool: { name: 'forge_requirement_draft', args: { ...draft, preview: true } } },
      { tool: { name: 'forge_requirement_draft', args: draft } },
      {
        text: 'I drafted the requirement from criteria-120.md with its 120 criteria, lines 7 to 126.',
      },
    ];
    const resolved = await resolveTurnAuthority({ userId: owner, projectId, viaTokenId: null });
    if (!resolved.ok) throw new Error(resolved.refusal.message);
    const venue = {
      adapter: 'web' as const,
      externalId: room,
      shape: 'direct' as const,
      projectId,
    };
    const conversation = ok(await say('person', 'GET', `/api/conversations/${room}`));
    venue.externalId = conversation.externalId ?? conversation.conversation?.externalId ?? room;
    const inputs = webConversationTurn({
      project: { id: projectId, slug: projectSlug, name: 'Docs' },
      handleName: 'forge',
      askedBy: null,
      window: {
        venue,
        conversationId: room,
        windowId: randomUUID(),
        deliveryKey: `window:${randomUUID()}`,
        mode: 'assistant',
        question: ask,
        images: [],
        conversationContext: async () => null,
        reserve: async () => true,
      },
      progress: new ConversationProgress(room, randomUUID()),
      externalStop: new AbortController().signal,
    });
    const outcome = await runConversationTurn({
      ...inputs,
      venue,
      authority: resolved.authority,
      speakerUserId: owner,
      speakerKey: owner,
      message: ask,
      questionAlreadyRecorded: true,
      replyLanguage: 'en',
      mayDecline: true,
      deliveryKey: `window:${randomUUID()}`,
    });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'delivered' });

    const asked = JSON.stringify(script.seen[0]);
    expect(asked).toContain('<document name=\\"criteria-120.md\\">');
    expect(asked).toContain(
      '[Attached document: deploy-notes.md (text/markdown). It is the person',
    );
    expect(asked).toContain('cite it by its file name');
    expect(asked).not.toContain(PLANTED);

    const previewed = JSON.stringify(script.seen[1]);
    expect(previewed).toContain('\\"criteria\\":120');
    expect(previewed).toContain('\\"lines\\":\\"7-126\\"');
    expect(previewed).toContain('\\"written\\":false');
    expect(previewed).toContain('exactly 120 criteria, from lines 7-126; no line was left out');

    const wrote = script.seen[2]?.filter((m) => m.role === 'tool').at(-1);
    expect(JSON.stringify(wrote?.content)).toContain('\\"state\\":\\"draft\\"');
    const list = ok(await say('person', 'GET', `/api/projects/${projectId}/requirements`));
    const rows = (Array.isArray(list) ? list : (list.requirements ?? list.items)) as Doc[];
    expect(rows, JSON.stringify(list).slice(0, 400)).toHaveLength(1);
    const req = ok(
      await say('person', 'GET', `/api/projects/${projectId}/requirements/${rows[0]?.key}`),
    );
    expect(req.status).toBe('draft');
    expect(req.revisions).toHaveLength(1);
    const [head] = req.revisions as Doc[];
    const bodies = ((head?.criteria ?? []) as Doc[]).map((c) => c.body);
    expect(bodies).toHaveLength(120);
    expect(bodies).toEqual(STATED);
  });
});

describe('a criteria document the draft cannot take whole', () => {
  async function tools(room: string) {
    const { buildProjectToolset } = await import('../../src/assistant/tools/registry.js');
    const { buildChatToolContext } = await import('../../src/assistant/tools/principal.js');
    const { CHAT_TURN_MENU, mintTurnCredential } = await import(
      '../../src/credentials/turn-credential.js'
    );
    const { resolveTurnAuthority } = await import('../../src/permissions/index.js');
    const { readRoomDocumentByName } = await import('../../src/conversations/index.js');
    const resolved = await resolveTurnAuthority({ userId: owner, projectId, viaTokenId: null });
    if (!resolved.ok) throw new Error(resolved.refusal.message);
    const credential = await mintTurnCredential({
      authority: resolved.authority,
      menu: CHAT_TURN_MENU,
      ttlMs: 10 * 60_000,
    });
    return buildProjectToolset(
      buildChatToolContext({
        credential,
        projectSlug,
        turn: {
          conversationId: room,
          speakerUserId: owner,
          handleUserId: null,
          readDocument: (file) => readRoomDocumentByName(room, file),
        },
      }),
    );
  }
  const requirementCount = async () => {
    const list = ok(await say('person', 'GET', `/api/projects/${projectId}/requirements`));
    return ((Array.isArray(list) ? list : (list.requirements ?? list.items)) as Doc[]).length;
  };

  it('is refused naming the line it could not take, and nothing is written', async () => {
    const { toolResultText } = await import('../../src/assistant/tools/mcp-adapter.js');
    const room = await openRoom();
    const lines = STATED.map((s) => `- ${s}`);
    lines.splice(56, 0, '  continued here by the owner, on a line of its own');
    ok(await attach(room, 'broken.md', 'text/markdown', Buffer.from(lines.join('\n'))), 201);
    const before = await requirementCount();
    const r = await (await tools(room)).execute(
      'forge_requirement_draft',
      JSON.stringify({
        title: 'Broken',
        reason: 'From broken.md.',
        criteria: [],
        criteriaFrom: { file: 'broken.md' },
      }),
    );
    expect(r.isError).toBe(true);
    const said = toolResultText(r);
    expect(said).toContain('CRITERIA_DOCUMENT_REFUSED');
    expect(said).toContain('line 57 of broken.md');
    expect(await requirementCount()).toBe(before);
  });

  it('is refused naming the files the room does hold, for a name it does not', async () => {
    const { toolResultText } = await import('../../src/assistant/tools/mcp-adapter.js');
    const room = await openRoom();
    ok(await attach(room, 'criteria-120.md', 'text/markdown', Buffer.from(SPEC)), 201);
    const r = await (await tools(room)).execute(
      'forge_requirement_draft',
      JSON.stringify({ title: 'X', reason: 'Y', criteria: [], criteriaFrom: { file: 'spec.md' } }),
    );
    expect(r.isError).toBe(true);
    expect(toolResultText(r)).toContain(
      'no document named spec.md is attached in this conversation; it holds criteria-120.md',
    );
  });
});
