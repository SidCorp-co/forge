// The in-band executor's wire held to the provider's documented contract, request by request, as the
// bytes `fetch` would send (REQ-32 BC-14). The shapes are platform.claude.com/docs as read on
// 2026-10-09: build-with-claude/files ("Uploading a file": POST /v1/files, multipart field `file`,
// headers x-api-key and anthropic-version 2023-06-01, no beta header since the Files API is GA;
// "File expiration": an `expires_in_seconds` form field of 3,600 to 7,776,000) and
// agents-and-tools/tool-use/code-execution-tool ("Tool versions": `code_execution_20260521` needs no
// beta header; "Upload and analyze your own files": a `container_upload` block per file_id;
// "Response format": `server_tool_use` and `bash_code_execution_tool_result` blocks, a top-level
// `container`). The answers replayed are recorded: the docs' examples for the Claude API, and what
// dev's chat gateway answered the same upload on 2026-10-09, which is the QA's failure.

import type { ExecutionRequest } from '@forge/contracts/report-executions';
import { describe, expect, it } from 'vitest';
import { createCodeExecutor } from './code-execution.js';

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

const json = (status: number, body: unknown, type = 'application/json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': type },
  });

/** The docs' upload answer ("Uploading a file"), its id and name the only fields changed. */
const UPLOADED = (n: number, filename: string) => ({
  id: `file_011CNha8iCJcU1wXNR6q4V8${n}`,
  type: 'file',
  filename,
  mime_type: 'text/plain',
  size_bytes: 1024,
  created_at: '2025-01-01T00:00:00Z',
  downloadable: false,
  expires_at: '2025-01-01T01:00:00Z',
});

/** What dev's ANTHROPIC_API_URL (an Anthropic-format gateway) answered, recorded 2026-10-09. */
const GATEWAY_UPLOAD = {
  error: {
    message: 'Request body is not valid JSON',
    type: 'invalid_request_error',
    param: null,
    code: 'invalid_json',
  },
};

/** A fetch that serialises each request as the wire carries it, and answers it from a script. */
function recorder(answer: (req: Sent, seq: number) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(String(input), init);
    const one: Sent = {
      method: req.method,
      url: req.url,
      headers: Object.fromEntries(req.headers.entries()),
      body: req.body ? await req.text() : '',
    };
    sent.push(one);
    return answer(one, sent.length);
  }) as typeof fetch;
  return { sent, fetchImpl };
}

const request: ExecutionRequest = {
  language: 'python',
  script: 'import json\nprint(len(json.load(open("inputs.json"))))',
  inputs: [{ fields: [{ name: 'n', type: 'number', label: 'N' }], rows: [{ n: 1 }] }],
  limits: { wallMs: 30_000, cpu: 1, memoryMb: 512, outputBytes: 256_000 },
};
const scope = { projectId: 'p-1', conversationId: 'c-1', askedBy: 'u-1' };

/** The Claude API as the docs answer it: three uploads, one relay call, one frames file back. */
function claudeApi() {
  const names = new Map<string, string>();
  return recorder(async (req, seq) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'POST' && path === '/v1/files') {
      const filename = /filename="([^"]+)"/.exec(req.body)?.[1] ?? 'unknown';
      const file = UPLOADED(seq, filename);
      names.set(file.id, filename);
      return json(200, file);
    }
    if (req.method === 'POST' && path === '/v1/messages') {
      const body = JSON.parse(req.body) as { messages: { content: { text?: string }[] }[] };
      const command = (body.messages[0]?.content[0]?.text ?? '').replace(/^Command:\n/, '');
      const run = [...names.values()].find((n) => n.endsWith('-run.sh')) ?? '';
      const tag = /^forge-([0-9a-f]+)-run\.sh$/.exec(run)?.[1] ?? '';
      names.set('file_out', `forge-${tag}-frames.json`);
      return json(200, {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        stop_reason: 'end_turn',
        container: { id: 'container_011CPR5CNjB747bTd36fQLFk', expires_at: '2026-11-07T00:00:00Z' },
        content: [
          {
            type: 'server_tool_use',
            id: 'srvtoolu_01',
            name: 'bash_code_execution',
            input: { command },
          },
          {
            type: 'bash_code_execution_tool_result',
            tool_use_id: 'srvtoolu_01',
            content: {
              type: 'bash_code_execution_result',
              stdout: '1\n',
              stderr: '',
              return_code: 0,
              content: [{ file_id: 'file_out' }],
            },
          },
          { type: 'text', text: 'done' },
        ],
      });
    }
    const meta = /^\/v1\/files\/([^/]+)(\/content)?$/.exec(path);
    if (meta && req.method === 'DELETE') return json(200, { id: meta[1], type: 'file_deleted' });
    if (meta?.[2]) return new Response('{"frames":[{"fields":[],"rows":[]}]}', { status: 200 });
    if (meta) {
      return json(200, {
        ...UPLOADED(0, names.get(meta[1] ?? '') ?? ''),
        id: meta[1],
        size_bytes: 36,
      });
    }
    throw new Error(`no recorded answer for ${req.method} ${path}`);
  });
}

describe('the requests the in-band executor sends, as the docs shape them', () => {
  it('uploads each file as documented multipart with its expiry, and no beta header', async () => {
    const api = claudeApi();
    const executor = createCodeExecutor({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-sonnet-5',
      fetchImpl: api.fetchImpl,
    });
    const result = await executor.execute(request, scope);
    expect(result.exit).toBe(0);

    const uploads = api.sent.filter((s) => s.method === 'POST' && s.url.endsWith('/v1/files'));
    expect(uploads).toHaveLength(3);
    for (const up of uploads) {
      expect(up.url).toBe('https://api.anthropic.com/v1/files');
      expect(up.headers['x-api-key']).toBe('test-key');
      expect(up.headers['anthropic-version']).toBe('2023-06-01');
      expect(up.headers['anthropic-beta']).toBeUndefined();
      expect(up.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
      expect(up.body).toMatch(
        /Content-Disposition: form-data; name="file"; filename="forge-[0-9a-f]+-/,
      );
      expect(up.body).toMatch(
        /Content-Disposition: form-data; name="expires_in_seconds"\r\n\r\n3600\r\n/,
      );
    }
  });

  it('relays one JSON Messages call offering the current tool and a container_upload per file', async () => {
    const api = claudeApi();
    const executor = createCodeExecutor({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-sonnet-5',
      fetchImpl: api.fetchImpl,
    });
    await executor.execute(request, scope);
    const [call] = api.sent.filter((s) => s.url.endsWith('/v1/messages'));
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.headers['anthropic-beta']).toBeUndefined();
    const body = JSON.parse(call?.body ?? '{}');
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.tools).toEqual([{ type: 'code_execution_20260521', name: 'code_execution' }]);
    expect(
      body.messages[0].content.filter((c: { type: string }) => c.type === 'container_upload'),
    ).toHaveLength(3);
    const deleted = api.sent
      .filter((s) => s.method === 'DELETE')
      .map((d) => new URL(d.url).pathname);
    expect(new Set(deleted).size).toBe(4);
    expect(deleted).toContain('/v1/files/file_out');
  });

  it("replays the gateway's recorded answer: the same documented upload fails as the QA saw it", async () => {
    const gateway = recorder(() => json(400, GATEWAY_UPLOAD));
    const executor = createCodeExecutor({
      baseUrl: 'https://serp-api.musetools.com',
      apiKey: 'test-key',
      model: 'cx/gpt-5.6-terra',
      fetchImpl: gateway.fetchImpl,
    });
    await expect(executor.execute(request, scope)).rejects.toThrow(
      /the file upload of forge-[0-9a-f]+-script\.py answered http 400 invalid_request_error: Request body is not valid JSON/,
    );
    expect(gateway.sent[0]?.headers['content-type']).toMatch(/^multipart\/form-data/);
  });
});
