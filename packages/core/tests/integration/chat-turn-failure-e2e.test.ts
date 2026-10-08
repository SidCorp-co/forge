/**
 * A chat turn that ends without its answer still hands the person what it did and found, with a
 * failure line in their language (dev QA 2026-10-07, conversation 3d24ec07: a Vietnamese long-spec
 * ask read the project, streamed an English draft for ~45 s, its stream broke, and the window closed
 * ASSISTANT_TURN_FAILED with "forge could not reach its model, so nothing was sent"). The ask is the
 * production one; the model is the one thing scripted: it reads, streams, and its stream breaks.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

interface Request {
  /** A tool the round calls, or the text it streams. */
  tool?: { name: string; args: unknown };
  text?: string;
  /** The stream breaks after the text, with this provider error. */
  breaks?: string;
}
const script: { requests: Request[]; asked: string[] } = { requests: [], asked: [] };

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openChat: async () => ({
    model: 'scripted',
    provider: {
      id: 'scripted',
      defaultModel: 'scripted',
      async *stream(req: { messages: { role: string; content: unknown }[] }) {
        const users = req.messages.filter((m) => m.role === 'user');
        script.asked.push(String(users.at(-1)?.content ?? ''));
        const next = script.requests.shift() ?? { text: 'Xong.' };
        if (next.tool) {
          yield {
            type: 'tool_call',
            id: `call-${randomUUID()}`,
            name: next.tool.name,
            arguments: JSON.stringify(next.tool.args),
          };
          yield { type: 'done' };
          return;
        }
        for (const piece of (next.text ?? '').split(/(?<=\. )/))
          yield { type: 'chunk', text: piece };
        if (next.breaks) {
          yield { type: 'error', message: next.breaks };
          return;
        }
        yield { type: 'done' };
      },
    },
  }),
}));

const { runConversationTurn } = await import('../../src/assistant/turn-runner.js');
const { webConversationTurn } = await import('../../src/assistant/web-turn-inputs.js');
const { ConversationProgress } = await import('../../src/assistant/conversation-progress.js');
const { api, userToken } = await import('../helpers/api.js');
const { createTestProject, createTestUser } = await import('../helpers/factories.js');

let token = '';
let projectId = '';
let owner = '';

const SPEC_ASK =
  'Soạn giúp mình một spec issue thật dài và chi tiết cho tính năng xuất báo cáo tiến độ hằng tuần của một project ra PDF: bối cảnh, mục tiêu, người dùng, phạm vi và ngoài phạm vi, luồng chính, các trường hợp lỗi, tiêu chí nghiệm thu (ít nhất 12 tiêu chí), rủi ro, kế hoạch kiểm thử và câu hỏi mở. Chỉ soạn, đừng tạo issue.'; // i18n-allow: the production ask replayed as the test case

const VI_DRAFT =
  'Spec: Xuất báo cáo tiến độ hằng tuần ra PDF. 1. Bối cảnh: người quản lý dự án cần gửi một bản tóm tắt tiến độ mỗi tuần mà không phải chép tay từ nhiều màn hình. 2. Mục tiêu: '; // i18n-allow: the draft a Vietnamese turn streams
const EN_DRAFT =
  '[Feature] Export weekly project progress report to PDF. 1. Context: Project stakeholders need a consistent, shareable weekly view of project progress without manually collecting data from multiple Forge screens. Today, project information is available through the project overview and the issue workflows, but it is made for viewing in the app. 2. Goal: ';

function knowledgeTools() {
  return {
    tools: [
      {
        type: 'function' as const,
        function: {
          name: 'forge_knowledge',
          description: 'knowledge',
          parameters: { type: 'object' },
        },
      },
    ],
    ranAs: () => owner,
    // the grant the real forge_knowledge read declares, which the agreement gate reads to let a
    // read through (REQ-30 BC-4, ISS-439 round 3)
    grantOf: () => 'knowledge:read' as const,
    async execute() {
      return {
        content: [{ type: 'text' as const, text: 'knowledge: reports are read on the overview' }],
      };
    },
  };
}

async function turn(message: string) {
  const res = await api(token, 'POST', '/api/conversations', {
    projectId,
    title: 'spec',
    people: [],
  });
  expect(res.status).toBe(201);
  const room = res.body as unknown as { id: string; externalId: string; shape: 'direct' | 'group' };
  const venue = {
    adapter: 'web' as const,
    externalId: room.externalId,
    shape: room.shape,
    projectId,
  };
  const inputs = webConversationTurn({
    project: { id: projectId, slug: 'failures', name: 'Failures' },
    handleName: 'forge',
    askedBy: null,
    window: {
      venue,
      conversationId: room.id,
      windowId: randomUUID(),
      deliveryKey: `window:${randomUUID()}`,
      mode: 'assistant',
      question: message,
      images: [],
      conversationContext: async () => null,
      reserve: async () => true,
    },
    progress: new ConversationProgress(room.id, randomUUID()),
    externalStop: new AbortController().signal,
  });
  const tools = knowledgeTools();
  return runConversationTurn({
    ...inputs,
    prepare: async () => ({ tools }),
    venue,
    authority: {
      userId: owner,
      projectId,
      origin: 'message' as const,
      viaTokenId: null,
      grant: null,
      fence: null,
      scopes: [],
      grantEpoch: 0,
    },
    speakerUserId: owner,
    speakerKey: owner,
    message,
    replyLanguage: 'vi',
    mayDecline: true,
    deliveryKey: `window:${randomUUID()}`,
  });
}

beforeAll(async () => {
  owner = (await createTestUser({ verified: true })).id;
  token = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
});

describe('a turn whose model stream breaks partway', () => {
  it('is asked again, and the answer the second request gives is delivered', async () => {
    script.asked = [];
    script.requests = [
      { tool: { name: 'forge_knowledge', args: { action: 'list' } } },
      { text: VI_DRAFT, breaks: 'anthropic stream ended: overloaded_error' },
      { text: `${VI_DRAFT}gửi PDF trong một lần bấm.` },
    ];
    const outcome = await turn(SPEC_ASK);
    expect(outcome).toMatchObject({ kind: 'delivered' });
  });

  it('that breaks again ends failed, and its report says why in Vietnamese with what it read and drafted', async () => {
    script.asked = [];
    script.requests = [
      { tool: { name: 'forge_knowledge', args: { action: 'list' } } },
      { text: VI_DRAFT, breaks: 'stream disconnected' },
      { text: VI_DRAFT, breaks: 'stream disconnected' },
    ];
    const outcome = await turn(SPEC_ASK);
    expect(outcome).toMatchObject({
      kind: 'failed',
      code: 'ASSISTANT_TURN_FAILED',
      cause: 'provider',
    });
    const report = outcome.kind === 'failed' ? outcome.report.text : '';
    expect(report).toContain(
      'forge chưa trả lời xong: mô hình ngừng trả lời giữa chừng. (ASSISTANT_TURN_FAILED)', // i18n-allow: the Vietnamese report under test
    );
    expect(report).toContain('Đã đọc: đọc tri thức dự án.'); // i18n-allow: the Vietnamese report under test
    expect(report).toContain('Phần đã viết được, chưa xong'); // i18n-allow: the Vietnamese report under test
    expect(report).toContain('1. Bối cảnh: người quản lý dự án'); // i18n-allow: the Vietnamese report under test
    expect(report).not.toContain('chưa gửi gì'); // i18n-allow: the line that must not stand
  });

  it('an English draft to a Vietnamese ask is not shown as found: it fails the reply check, and the report says so', async () => {
    script.asked = [];
    script.requests = [
      { tool: { name: 'forge_knowledge', args: { action: 'list' } } },
      { text: EN_DRAFT, breaks: 'stream disconnected' },
      { text: EN_DRAFT, breaks: 'stream disconnected' },
    ];
    const outcome = await turn(SPEC_ASK);
    const report = outcome.kind === 'failed' ? outcome.report.text : '';
    expect(report).toContain('Đã đọc: đọc tri thức dự án.'); // i18n-allow: the Vietnamese report under test
    expect(report).not.toContain('Export weekly project progress');
    expect(report).toContain('bản nháp chưa qua bước kiểm tra'); // i18n-allow: the Vietnamese report under test
  });
});

describe('the turn is told the language the person asked in, from its first request', () => {
  it('a Vietnamese ask carries the reply language beside the message on every request', async () => {
    script.asked = [];
    script.requests = [
      { tool: { name: 'forge_knowledge', args: { action: 'list' } } },
      { text: 'Bản spec đây.' }, // i18n-allow: the reply a Vietnamese turn gives
    ];
    await turn(SPEC_ASK);
    expect(script.asked.length).toBeGreaterThanOrEqual(2);
    for (const asked of script.asked) {
      expect(asked).toContain('Reply language: this message is written in Vietnamese.');
    }
  });

  it('"chạy ISS-365", two words, is told as Vietnamese too', async () => {
    script.asked = [];
    script.requests = [
      { tool: { name: 'forge_knowledge', args: { action: 'list' } } },
      { text: 'ISS-365 đã đóng nên không chạy lại được.' }, // i18n-allow: the reply a Vietnamese turn gives
    ];
    await turn('chạy ISS-365'); // i18n-allow: the production ask replayed as the test case
    expect(script.asked[0]).toContain('Reply language: this message is written in Vietnamese.');
  });
});
