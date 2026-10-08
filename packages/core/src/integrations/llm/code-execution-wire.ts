/**
 * The HTTP half of the in-band executor: the Files API (upload, metadata, content, delete) and one
 * Messages call offering the code execution tool, spoken as JSON over `fetch` and nothing else. The
 * shapes are the vendor's, read on 2026-10-08 from platform.claude.com/docs (agents-and-tools/
 * tool-use/code-execution-tool, build-with-claude/files): neither needs a beta header, an uploaded
 * file reaches the sandbox as a `container_upload` block, a container is reused by passing its id
 * as the top-level `container`, and a file a command left in `$OUTPUT_DIR` comes back as a
 * `file_id` in its `bash_code_execution_result`. Nothing here leaves this directory.
 */

import { openAiCompatBaseUrl } from '../../lib/openai-compat-url.js';

/** The newest code execution tool version the docs list (none of the three needs a beta header). */
export const CODE_EXECUTION_TOOL = { type: 'code_execution_20260521', name: 'code_execution' };
export const BASH_TOOL_NAME = 'bash_code_execution';
const API_VERSION = '2023-06-01';

export interface WireConfig {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch | undefined;
}

/** A refusal from the provider's API: its HTTP status and its own `error.type` and message. */
export class WireError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string,
    readonly providerMessage: string,
    what: string,
  ) {
    super(`${what} answered http ${status} ${errorType}: ${providerMessage}`);
    this.name = 'WireError';
  }
}

export interface ServerToolUse {
  type: 'server_tool_use';
  id: string;
  name: string;
  input?: { command?: unknown } | undefined;
}

export interface BashResultContent {
  type: string;
  stdout?: string;
  stderr?: string;
  return_code?: number;
  content?: { file_id?: string }[];
  error_code?: string;
}

export interface BashToolResult {
  type: 'bash_code_execution_tool_result';
  tool_use_id: string;
  content: BashResultContent;
}

type ContentBlock = ServerToolUse | BashToolResult | { type: string; [k: string]: unknown };

export interface MessagesAnswer {
  id: string;
  content: ContentBlock[];
  stop_reason?: string | null;
  container?: { id: string; expires_at?: string } | null;
}

export interface FileMeta {
  id: string;
  filename: string;
  size_bytes: number;
}

export interface MessagesRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: 'user' | 'assistant'; content: unknown[] }[];
  tools: (typeof CODE_EXECUTION_TOOL)[];
  container?: string;
}

/** The Files API and the Messages call, each refusing a non-2xx answer with a WireError. */
export function codeExecutionWire(cfg: WireConfig) {
  const root = openAiCompatBaseUrl(cfg.baseUrl);
  const call = cfg.fetchImpl ?? fetch;
  const headers = { 'x-api-key': cfg.apiKey, 'anthropic-version': API_VERSION };

  async function send(
    path: string,
    init: RequestInit,
    what: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const res = await call(`${root}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      ...(signal ? { signal } : {}),
    });
    if (res.ok) return res;
    const body = await res.text();
    let errorType = 'error';
    let message = body.slice(0, 500);
    try {
      const parsed = JSON.parse(body) as { error?: { type?: string; message?: string } };
      errorType = parsed.error?.type ?? errorType;
      message = parsed.error?.message ?? message;
    } catch {
      // the body was not the API's JSON error; its first characters are the message
    }
    throw new WireError(res.status, errorType, message, what);
  }

  return {
    /** Uploads one file that expires on its own after `expiresInSeconds`, should a delete be missed. */
    async upload(
      filename: string,
      text: string,
      expiresInSeconds: number,
      signal?: AbortSignal,
    ): Promise<string> {
      const form = new FormData();
      form.append('file', new Blob([text], { type: 'text/plain' }), filename);
      form.append('expires_in_seconds', String(expiresInSeconds));
      const res = await send(
        '/files',
        { method: 'POST', body: form },
        `the file upload of ${filename}`,
        signal,
      );
      return ((await res.json()) as { id: string }).id;
    },
    async meta(fileId: string, signal?: AbortSignal): Promise<FileMeta> {
      const res = await send(
        `/files/${encodeURIComponent(fileId)}`,
        { method: 'GET' },
        `the metadata read of file ${fileId}`,
        signal,
      );
      return (await res.json()) as FileMeta;
    },
    async content(fileId: string, signal?: AbortSignal): Promise<string> {
      const res = await send(
        `/files/${encodeURIComponent(fileId)}/content`,
        { method: 'GET' },
        `the download of file ${fileId}`,
        signal,
      );
      return res.text();
    },
    async remove(fileId: string): Promise<void> {
      await send(
        `/files/${encodeURIComponent(fileId)}`,
        { method: 'DELETE' },
        `the delete of file ${fileId}`,
      );
    },
    async messages(body: MessagesRequest, signal?: AbortSignal): Promise<MessagesAnswer> {
      const res = await send(
        '/messages',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        'the code execution call',
        signal,
      );
      return (await res.json()) as MessagesAnswer;
    },
  };
}

export type CodeExecutionWire = ReturnType<typeof codeExecutionWire>;
