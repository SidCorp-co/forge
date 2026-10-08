// The provider's code execution API faked at the wire, for the in-band executor's tests: a `fetch`
// that answers the Files API and the Messages call as the docs describe them, records every request,
// and plays a run of the relayed command whose outcome each test sets. Nothing here reaches a network.

export interface FakeRun {
  /** The HTTP status of the Messages call; anything but 200 answers the API's JSON error. */
  status?: number;
  errorType?: string;
  errorMessage?: string;
  /** The tool's own error code in place of a result (`execution_time_exceeded`, `unavailable`, …). */
  toolError?: string;
  /** The relay runs this instead of the command it was given. */
  alteredCommand?: string;
  returnCode?: number;
  stdout?: string;
  stderr?: string;
  /** What the script left in `$OUTPUT_DIR`: one output file, or none. */
  output?: { file: 'frames.json' | 'frames.csv'; text: string } | null;
  stopReason?: string;
}

interface Stored {
  filename: string;
  text: string;
  expiresIn: string | null;
  generated: boolean;
}

export interface WireRecord {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake API; `next` sets the outcome of the next Messages call, `run` of every later one. */
export function fakeCodeExecutionApi() {
  const files = new Map<string, Stored>();
  const deleted = new Set<string>();
  const calls: WireRecord[] = [];
  const queue: FakeRun[] = [];
  let run: FakeRun = {};
  let seq = 0;
  let containers = 0;
  const refusedContainers = new Set<string>();

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, '');
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string> | undefined) ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    if (path === '/files' && method === 'POST') {
      const form = init?.body as FormData;
      const file = form.get('file') as File;
      const id = `file_${++seq}`;
      files.set(id, {
        filename: file.name,
        text: await file.text(),
        expiresIn: (form.get('expires_in_seconds') as string | null) ?? null,
        generated: false,
      });
      calls.push({ method, path, headers });
      return json(200, { id, type: 'file', filename: file.name, downloadable: false });
    }
    const fileMatch = /^\/files\/([^/]+)(\/content)?$/.exec(path);
    if (fileMatch) {
      calls.push({ method, path, headers });
      const id = decodeURIComponent(fileMatch[1] as string);
      const stored = files.get(id);
      if (!stored || deleted.has(id)) {
        return json(404, {
          type: 'error',
          error: { type: 'not_found_error', message: `File ${id} not found.` },
        });
      }
      if (method === 'DELETE') {
        deleted.add(id);
        return json(200, { id, type: 'file_deleted' });
      }
      if (fileMatch[2]) return new Response(stored.text, { status: 200 });
      return json(200, {
        id,
        type: 'file',
        filename: stored.filename,
        size_bytes: Buffer.byteLength(stored.text),
        downloadable: stored.generated,
      });
    }
    if (path === '/messages' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ method, path, headers, body });
      const outcome = queue.shift() ?? run;
      const container = body.container as string | undefined;
      if (container && refusedContainers.has(container)) {
        return json(400, {
          type: 'error',
          error: { type: 'invalid_request_error', message: `container ${container} has expired` },
        });
      }
      if (outcome.status && outcome.status !== 200) {
        return json(outcome.status, {
          type: 'error',
          error: {
            type: outcome.errorType ?? 'api_error',
            message: outcome.errorMessage ?? 'failed',
          },
        });
      }
      const messages = body.messages as { content: { type: string; text?: string }[] }[];
      const text = messages[0]?.content.find((c) => c.type === 'text')?.text ?? '';
      const command = outcome.alteredCommand ?? text.replace(/^Command:\n/, '');
      const runFile = [...files.values()].filter((f) => f.filename.endsWith('-run.sh')).at(-1);
      const tag = /^forge-([0-9a-f]+)-run\.sh$/.exec(runFile?.filename ?? '')?.[1] ?? 'none';
      const outputs: { file_id: string }[] = [];
      if (!outcome.toolError && outcome.output !== null) {
        const out = outcome.output ?? { file: 'frames.json', text: '{"frames":[]}' };
        const id = `file_${++seq}`;
        files.set(id, {
          filename: `forge-${tag}-${out.file}`,
          text: out.text,
          expiresIn: null,
          generated: true,
        });
        outputs.push({ file_id: id });
      }
      const useId = `srvtoolu_${seq}`;
      return json(200, {
        id: `msg_${++seq}`,
        type: 'message',
        role: 'assistant',
        stop_reason: outcome.stopReason ?? 'end_turn',
        container: {
          id: container ?? `container_${++containers}`,
          expires_at: '2026-10-08T12:00:00Z',
        },
        content: [
          { type: 'server_tool_use', id: useId, name: 'bash_code_execution', input: { command } },
          {
            type: 'bash_code_execution_tool_result',
            tool_use_id: useId,
            content: outcome.toolError
              ? { type: 'bash_code_execution_tool_result_error', error_code: outcome.toolError }
              : {
                  type: 'bash_code_execution_result',
                  stdout: outcome.stdout ?? '',
                  stderr: outcome.stderr ?? '',
                  return_code: outcome.returnCode ?? 0,
                  content: outputs,
                },
          },
          { type: 'text', text: 'done' },
        ],
      });
    }
    throw new Error(`the fake code execution API has no ${method} ${path}`);
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    files,
    deleted,
    set run(r: FakeRun) {
      run = r;
    },
    next(r: FakeRun) {
      queue.push(r);
    },
    /** The provider refuses this container from now on, as it does one that has expired. */
    expire(containerId: string) {
      refusedContainers.add(containerId);
    },
    messageBodies: () => calls.filter((c) => c.path === '/messages').map((c) => c.body ?? {}),
    uploaded: () => [...files.entries()].filter(([, f]) => !f.generated),
    /** Every file ever stored that is not yet deleted. */
    live: () => [...files.keys()].filter((id) => !deleted.has(id)),
  };
}
