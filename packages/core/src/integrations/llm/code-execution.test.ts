import type { ExecutionRequest, ExecutionScope } from '@forge/contracts/report-executions';
import { describe, expect, it } from 'vitest';
import { fakeCodeExecutionApi } from '../../../tests/helpers/code-execution-wire.js';
import { CODE_EXECUTOR_ID, ContainerBook, createCodeExecutor } from './code-execution.js';

// The in-band executor against the provider's API faked at the wire: what it uploads, the call it
// makes, how the provider-executed result becomes one ExecutionResult, how a provider error or a limit
// becomes a named stop, and which container a call reuses.

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const request = (over: Partial<ExecutionRequest> = {}): ExecutionRequest => ({
  language: 'python',
  script: 'import json\nrows = json.load(open("inputs.json"))[0]["rows"]\nprint(len(rows))',
  inputs: [
    {
      fields: [
        { name: 'ref', type: 'ref', label: 'Issue' },
        { name: 'note', type: 'string', label: 'Note' },
      ],
      rows: [{ ref: 'ISS-1', note: `token ${SECRET} pasted` }],
    },
  ],
  limits: { wallMs: 30_000, cpu: 1, memoryMb: 512, outputBytes: 256_000 },
  ...over,
});
const scope = (over: Partial<ExecutionScope> = {}): ExecutionScope => ({
  projectId: 'p-1',
  conversationId: 'c-1',
  askedBy: 'u-1',
  ...over,
});
const FRAMES = {
  frames: [
    {
      fields: [{ name: 'open', type: 'number', label: 'Open' }],
      rows: [{ open: 3 }],
    },
  ],
};

function setup() {
  const api = fakeCodeExecutionApi();
  api.run = { output: { file: 'frames.json', text: JSON.stringify(FRAMES) }, stdout: '1\n' };
  const executor = createCodeExecutor({
    baseUrl: 'https://provider.test',
    apiKey: 'test-key',
    model: 'test-model',
    fetchImpl: api.fetchImpl,
  });
  return { api, executor };
}

describe('the in-band executor declares itself', () => {
  it('as in-band, with no network, its data leaving to the provider and not ZDR-eligible', () => {
    const { executor } = setup();
    expect({
      id: executor.id,
      mode: executor.mode,
      network: executor.network,
      dataLeavesTo: executor.dataLeavesTo,
      zdrEligible: executor.zdrEligible,
    }).toEqual({
      id: CODE_EXECUTOR_ID,
      mode: 'in-band',
      network: 'none',
      dataLeavesTo: 'anthropic',
      zdrEligible: false,
    });
  });

  it('is available only where computation and third-party processing are both on, and ZDR is not required', () => {
    const { executor } = setup();
    const on = (compute: Parameters<typeof executor.availableFor>[0]['compute']) =>
      executor.availableFor({ id: 'p-1', compute });
    expect(on({ enabled: true, thirdParty: true })).toBe(true);
    expect(on({ enabled: true })).toBe(false);
    expect(on({ enabled: true, thirdParty: false })).toBe(false);
    expect(on({ enabled: false, thirdParty: true })).toBe(false);
    expect(on({ enabled: true, thirdParty: true, zdrOnly: true })).toBe(false);
  });
});

describe('a run in the container', () => {
  it('uploads the inputs scrubbed and the script verbatim, offers the current tool, and deletes every file after', async () => {
    const { api, executor } = setup();
    await executor.execute(request(), scope());
    const uploaded = api.uploaded().map(([, f]) => f);
    const inputs = uploaded.find((f) => f.filename.endsWith('-inputs.json'));
    expect(inputs?.text).toBeDefined();
    expect(inputs?.text).not.toContain(SECRET);
    expect(JSON.parse(inputs?.text ?? '')[0].rows[0].ref).toBe('ISS-1');
    expect(uploaded.find((f) => f.filename.endsWith('-script.py'))?.text).toBe(request().script);
    expect(uploaded.every((f) => f.expiresIn === '3600')).toBe(true);
    const runSh = uploaded.find((f) => f.filename.endsWith('-run.sh'))?.text ?? '';
    expect(runSh).toContain('timeout -k 2 30 python3 script.py');

    const [body] = api.messageBodies();
    expect(body?.tools).toEqual([{ type: 'code_execution_20260521', name: 'code_execution' }]);
    const sent = (body?.messages ?? []) as { content: { type: string; file_id?: string }[] }[];
    const blocks = sent[0]?.content;
    expect(
      blocks
        ?.filter((b) => b.type === 'container_upload')
        .map((b) => b.file_id)
        .sort(),
    ).toEqual(
      api
        .uploaded()
        .map(([id]) => id)
        .sort(),
    );
    for (const call of api.calls) expect(call.headers['anthropic-beta']).toBeUndefined();
    expect(api.live()).toEqual([]);
  });

  it('maps the provider-executed result into one ExecutionResult with the frames it wrote', async () => {
    const { executor } = setup();
    const result = await executor.execute(request(), scope());
    expect(result).toMatchObject({
      adapter: CODE_EXECUTOR_ID,
      exit: 0,
      frames: FRAMES.frames,
      logs: { stdout: '1\n', stderr: '' },
    });
    expect(result.executionId).toMatch(/^msg_/);
    expect(result.stopped).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('reads one table from frames.csv, numbers as numbers', async () => {
    const { api, executor } = setup();
    api.run = { output: { file: 'frames.csv', text: 'team,open\n"Core, API",3\nWeb,\n' } };
    const result = await executor.execute(request(), scope());
    expect(result.frames).toEqual([
      {
        fields: [
          { name: 'team', type: 'string', label: 'team' },
          { name: 'open', type: 'number', label: 'open' },
        ],
        rows: [
          { team: 'Core, API', open: 3 },
          { team: 'Web', open: null },
        ],
      },
    ]);
  });

  it('names a script that wrote no frames, and one whose frames cannot be read, never an empty success', async () => {
    const { api, executor } = setup();
    api.next({ output: null, stdout: '42\n' });
    const none = await executor.execute(request(), scope());
    expect([none.exit, none.frames, none.error?.name]).toEqual([0, [], 'NoFrames']);
    api.next({ output: { file: 'frames.json', text: '{"frames": [{"rows": []}]}' } });
    const bad = await executor.execute(request(), scope());
    expect(bad.error?.name).toBe('FramesUnreadable');
    expect(bad.error?.message).toContain('frames.json is not frames');
  });
});

describe('a provider error or a limit is a named stop', () => {
  it('throws the API refusal by its status and type, and still deletes what it uploaded', async () => {
    const { api, executor } = setup();
    api.next({ status: 529, errorType: 'overloaded_error', errorMessage: 'Overloaded' });
    await expect(executor.execute(request(), scope())).rejects.toThrow(
      'the code execution call answered http 529 overloaded_error: Overloaded',
    );
    expect(api.live()).toEqual([]);
  });

  it('throws a tool error that means nothing ran, naming its code', async () => {
    const { api, executor } = setup();
    api.next({ toolError: 'too_many_requests' });
    await expect(executor.execute(request(), scope())).rejects.toThrow(
      'the code execution tool refused the command: too_many_requests',
    );
  });

  it('stops at the provider time limit and at the script wall limit, naming wallMs', async () => {
    const { api, executor } = setup();
    api.next({ toolError: 'execution_time_exceeded' });
    const provider = await executor.execute(request(), scope());
    expect([provider.stopped, provider.error?.name, provider.frames]).toEqual([
      'wallMs',
      'execution_time_exceeded',
      [],
    ]);
    api.next({ returnCode: 124, stderr: 'forge: stopped at the wall limit of 30 s\n' });
    const script = await executor.execute(request(), scope());
    expect([script.stopped, script.error?.name, script.exit]).toEqual(['wallMs', 'WallLimit', 124]);
  });

  it('stops at outputBytes without reading a frames file past it', async () => {
    const { api, executor } = setup();
    api.next({ output: { file: 'frames.json', text: JSON.stringify(FRAMES) } });
    const result = await executor.execute(
      request({ limits: { wallMs: 30_000, cpu: 1, memoryMb: 512, outputBytes: 10 } }),
      scope(),
    );
    expect([result.stopped, result.error?.name]).toEqual(['outputBytes', 'OutputLimit']);
    expect(api.calls.some((c) => c.path.endsWith('/content'))).toBe(false);
  });

  it('refuses a run of anything but the command it relayed', async () => {
    const { api, executor } = setup();
    api.next({ alteredCommand: 'python3 -c "print(1)"' });
    await expect(executor.execute(request(), scope())).rejects.toThrow(
      'none of them the one it was given',
    );
  });

  it('refuses a CPU limit the container cannot grant, before anything is uploaded', async () => {
    const { api, executor } = setup();
    await expect(
      executor.execute(
        request({ limits: { wallMs: 30_000, cpu: 2, memoryMb: 512, outputBytes: 256_000 } }),
        scope(),
      ),
    ).rejects.toThrow('limits.cpu 2 cannot be granted');
    expect(api.calls).toEqual([]);
  });
});

describe('one container per conversation', () => {
  const containerOf = (body: Record<string, unknown> | undefined) => body?.container;

  it('reuses the conversation container, and never one across conversations, projects or askers', async () => {
    const { api, executor } = setup();
    await executor.execute(request(), scope());
    await executor.execute(request(), scope());
    await executor.execute(request(), scope({ conversationId: 'c-2' }));
    await executor.execute(request(), scope({ projectId: 'p-2' }));
    await executor.execute(request(), scope({ askedBy: 'u-2' }));
    const sent = api.messageBodies().map(containerOf);
    expect(sent).toEqual([undefined, 'container_1', undefined, undefined, undefined]);
    await executor.execute(request(), scope({ conversationId: 'c-2' }));
    expect(api.messageBodies().map(containerOf).at(-1)).toBe('container_2');
  });

  it('keeps none for a caller with no conversation', async () => {
    const { api, executor } = setup();
    await executor.execute(request(), scope({ conversationId: null }));
    await executor.execute(request(), scope({ conversationId: null }));
    expect(api.messageBodies().map(containerOf)).toEqual([undefined, undefined]);
  });

  it('drops a container the provider refuses as expired and runs once in a fresh one', async () => {
    const { api, executor } = setup();
    await executor.execute(request(), scope());
    api.expire('container_1');
    const result = await executor.execute(request(), scope());
    expect(result.exit).toBe(0);
    expect(api.messageBodies().map(containerOf)).toEqual([undefined, 'container_1', undefined]);
    await executor.execute(request(), scope());
    expect(api.messageBodies().map(containerOf).at(-1)).toBe('container_2');
  });

  it('forgets a container 29 days after it was first seen', () => {
    const book = new ContainerBook();
    const key = ContainerBook.keyOf(scope()) as string;
    book.keep(key, 'container_9', 0);
    expect(book.get(key, 28 * 86_400_000)).toBe('container_9');
    expect(book.get(key, 30 * 86_400_000)).toBeUndefined();
  });
});
