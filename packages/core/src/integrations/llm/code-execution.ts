/**
 * `anthropic-code-exec`, the in-band adapter of the reports Executor port (REQ-32 C2): a script the
 * port has already checked, capped and scrubbed runs in the provider's code execution container,
 * inside one Messages call on the same wire and key the chat turns use, and the provider-executed
 * call and its result come back as one `ExecutionResult`. The call is execute-only: the model in it
 * relays one fixed command, so the script that runs is exactly the one core recorded, never a
 * version the model re-typed, and an altered or missing run is refused by name.
 *
 * Inputs reach the container as files (the Files API and `container_upload`), scrubbed again here,
 * and every file is deleted once the execution is read back. One container serves one project,
 * conversation and asker; see `ContainerBook` for how its id is kept and when it is dropped.
 */

import { randomBytes } from 'node:crypto';
import {
  type ComputePolicy,
  EXECUTION_OUTPUT_FILES,
  type ExecutionOutputFile,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionScope,
  type Executor,
  framesFromOutput,
} from '@forge/contracts/report-executions';
import { scrubSecretsDeep } from '@forge/observability';
import { logger } from '../../lib/logger.js';
import {
  BASH_TOOL_NAME,
  type BashResultContent,
  type BashToolResult,
  CODE_EXECUTION_TOOL,
  type CodeExecutionWire,
  codeExecutionWire,
  type MessagesAnswer,
  type ServerToolUse,
  type WireConfig,
  WireError,
} from './code-execution-wire.js';

export const CODE_EXECUTOR_ID = 'anthropic-code-exec';

/** Containers expire 30 days after creation (docs, "Container reuse"); a day's margin is kept. */
const CONTAINER_KEEP_MS = 29 * 24 * 60 * 60 * 1000;
const CONTAINER_BOOK_CAP = 1000;
/** An uploaded file deletes itself after an hour (the Files API's floor) should the delete be missed. */
const UPLOAD_EXPIRES_S = 3600;
/** How long the call may take beyond the script's own wall limit: the relay model's turn and I/O. */
const CALL_OVERHEAD_MS = 120_000;
/** A `pause_turn` answer is sent back to let the call finish; this many times at most. */
const MAX_CONTINUES = 2;
const RELAY_MAX_TOKENS = 1024;
const UPLOADS_MISSING_EXIT = 97;
const WALL_MARK = 'forge: stopped at the wall limit';

const RELAY_SYSTEM =
  'You relay one shell command into the code execution sandbox for Forge. Run the command in the user message with the bash tool exactly once, character for character, and run nothing else: do not explain, fix, retry or inspect anything. After it has run, answer with the single word: done.';

/**
 * Where a container id is kept: in this process, keyed by project, conversation and asker, so a
 * container is never shared across projects, conversations or people. It is dropped when the
 * provider refuses it (an expired container is refused, and the call is sent once more without
 * one), 29 days after it was first seen, when the book passes its cap (least recently used first),
 * and when the process restarts. A REST caller has no conversation, so its every call gets a fresh
 * container that is not kept.
 */
export class ContainerBook {
  private readonly held = new Map<string, { id: string; since: number }>();

  static keyOf(scope: ExecutionScope): string | null {
    return scope.conversationId === null
      ? null
      : JSON.stringify([scope.projectId, scope.conversationId, scope.askedBy]);
  }

  get(key: string, now: number): string | undefined {
    const entry = this.held.get(key);
    if (!entry) return undefined;
    this.held.delete(key);
    if (now - entry.since > CONTAINER_KEEP_MS) return undefined;
    this.held.set(key, entry);
    return entry.id;
  }

  keep(key: string, id: string, now: number): void {
    const prior = this.held.get(key);
    this.held.delete(key);
    this.held.set(key, { id, since: prior?.id === id ? prior.since : now });
    while (this.held.size > CONTAINER_BOOK_CAP) {
      const oldest = this.held.keys().next().value;
      if (oldest === undefined) break;
      this.held.delete(oldest);
    }
  }

  drop(key: string): void {
    this.held.delete(key);
  }
}

interface Uploaded {
  run: string;
  script: string;
  inputs: string;
}

const scriptFile = (language: ExecutionRequest['language']) =>
  language === 'python' ? 'script.py' : 'script.sh';

/** The command the relay runs, character for character: find the uploaded run.sh and run it. */
function relayCommand(tag: string, runFileId: string): string {
  return `r=$(find / \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o -type f \\( -name 'forge-${tag}-run.sh' -o -name '${runFileId}' \\) -print 2>/dev/null | head -n 1); [ -n "$r" ] || { echo 'forge: run.sh is not in the container' >&2; exit ${UPLOADS_MISSING_EXIT}; }; bash "$r"`;
}

/**
 * The wrapper the relay runs: copies the script and inputs.json into a fresh directory, deletes the
 * uploaded copies, runs the script under the wall limit, hands frames.json (or frames.csv) back
 * through `$OUTPUT_DIR`, and removes its directory, so nothing of one execution stays for the next.
 */
function runScript(tag: string, ids: Omit<Uploaded, 'run'>, request: ExecutionRequest): string {
  const secs = Math.max(1, Math.ceil(request.limits.wallMs / 1000));
  const file = scriptFile(request.language);
  const interpreter = request.language === 'python' ? 'python3' : 'bash';
  const outputs = EXECUTION_OUTPUT_FILES.join(' ');
  return [
    '#!/bin/bash',
    `here=$(dirname "$0")`,
    'pick() {',
    '  for c in "$@"; do if [ -f "$here/$c" ]; then printf %s "$here/$c"; return; fi; done',
    '  for c in "$@"; do f=$(find / \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o -type f -name "$c" -print 2>/dev/null | head -n 1); if [ -n "$f" ]; then printf %s "$f"; return; fi; done',
    '}',
    `script=$(pick 'forge-${tag}-${file}' '${ids.script}')`,
    `inputs=$(pick 'forge-${tag}-inputs.json' '${ids.inputs}')`,
    `if [ -z "$script" ] || [ -z "$inputs" ]; then echo 'forge: the uploaded script or inputs.json is not in the container' >&2; exit ${UPLOADS_MISSING_EXIT}; fi`,
    `work=$(mktemp -d) || exit ${UPLOADS_MISSING_EXIT}`,
    `cp "$inputs" "$work/inputs.json" && cp "$script" "$work/${file}" || exit ${UPLOADS_MISSING_EXIT}`,
    'rm -f "$inputs" "$script" "$0"',
    `cd "$work" || exit ${UPLOADS_MISSING_EXIT}`,
    `timeout -k 2 ${secs} ${interpreter} ${file}`,
    'rc=$?',
    `if [ "$rc" -eq 124 ]; then echo '${WALL_MARK} of ${secs} s' >&2; fi`,
    `for f in ${outputs}; do if [ -f "$f" ]; then cp "$f" "$OUTPUT_DIR/forge-${tag}-$f"; break; fi; done`,
    'cd / && rm -rf "$work"',
    'exit "$rc"',
    '',
  ].join('\n');
}

/** The command's own result among everything the call returned, or why there is none. */
function ownResult(
  blocks: MessagesAnswer['content'],
  command: string,
): { result: BashResultContent } | { why: string } {
  const uses = blocks.filter(
    (b): b is ServerToolUse => b.type === 'server_tool_use' && b.name === BASH_TOOL_NAME,
  );
  const ours = uses.find(
    (u) => typeof u.input?.command === 'string' && u.input.command.trim() === command,
  );
  if (!ours) {
    return {
      why:
        uses.length === 0
          ? 'the relay ran no command'
          : `the relay ran ${uses.length} command(s), none of them the one it was given`,
    };
  }
  const result = blocks.find(
    (b): b is BashToolResult =>
      b.type === 'bash_code_execution_tool_result' && (b as BashToolResult).tool_use_id === ours.id,
  );
  return result ? { result: result.content } : { why: 'the command ran and returned no result' };
}

/** What `ExecutionResult.stopped` names for the tool's own error codes that mean a limit was hit. */
const LIMIT_ERRORS: Record<string, ExecutionResult['stopped']> = {
  execution_time_exceeded: 'wallMs',
  output_file_too_large: 'outputBytes',
};

const isContainerGone = (err: unknown): boolean =>
  err instanceof WireError &&
  (err.status === 400 || err.status === 404) &&
  /container/i.test(err.providerMessage);

export interface CodeExecutorConfig extends WireConfig {
  model: string;
  /** For a test that reads what the book holds; production keeps one book per adapter. */
  book?: ContainerBook;
}

/** Sends the relay call, continuing a paused one, and answers every block it returned. */
async function relay(
  wire: CodeExecutionWire,
  model: string,
  call: { command: string; uploaded: Uploaded; container: string | undefined },
  signal: AbortSignal,
): Promise<{ blocks: MessagesAnswer['content']; answer: MessagesAnswer }> {
  const messages: { role: 'user' | 'assistant'; content: unknown[] }[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: `Command:\n${call.command}` },
        { type: 'container_upload', file_id: call.uploaded.run },
        { type: 'container_upload', file_id: call.uploaded.script },
        { type: 'container_upload', file_id: call.uploaded.inputs },
      ],
    },
  ];
  const blocks: MessagesAnswer['content'] = [];
  let held = call.container;
  for (let round = 0; ; round++) {
    const answer = await wire.messages(
      {
        model,
        max_tokens: RELAY_MAX_TOKENS,
        system: RELAY_SYSTEM,
        messages,
        tools: [CODE_EXECUTION_TOOL],
        ...(held ? { container: held } : {}),
      },
      signal,
    );
    blocks.push(...answer.content);
    held = answer.container?.id ?? held;
    if (answer.stop_reason !== 'pause_turn' || round >= MAX_CONTINUES) {
      return { blocks, answer: { ...answer, container: held ? { id: held } : null } };
    }
    messages.push({ role: 'assistant', content: answer.content });
  }
}

const outputIds = (result: BashResultContent): string[] =>
  (result.content ?? []).flatMap((entry) => (entry.file_id ? [entry.file_id] : []));

/** The frames the script handed back through `$OUTPUT_DIR`, or the named reason there are none. */
async function framesOf(
  wire: CodeExecutionWire,
  outputs: readonly string[],
  limit: number,
  signal: AbortSignal,
): Promise<Pick<ExecutionResult, 'frames' | 'stopped' | 'error'>> {
  for (const fileId of outputs) {
    const meta = await wire.meta(fileId, signal);
    const file = EXECUTION_OUTPUT_FILES.find((name) => meta.filename.endsWith(name));
    if (!file) continue;
    if (meta.size_bytes > limit) {
      return {
        frames: [],
        stopped: 'outputBytes',
        error: {
          name: 'OutputLimit',
          message: `${file} came to ${meta.size_bytes} bytes, past this execution's limits.outputBytes of ${limit}; it was not read`,
        },
      };
    }
    const read = framesFromOutput(file as ExecutionOutputFile, await wire.content(fileId, signal));
    return read.ok
      ? { frames: read.frames }
      : { frames: [], error: { name: 'FramesUnreadable', message: read.why } };
  }
  return {
    frames: [],
    error: {
      name: 'NoFrames',
      message: `the script wrote neither ${EXECUTION_OUTPUT_FILES.join(' nor ')}, so no frame came back; its stdout is in the logs`,
    },
  };
}

/** Deletes every file of one execution; one that will not go is said, and expires on its own. */
async function cleanUp(wire: CodeExecutionWire, fileIds: readonly string[]): Promise<void> {
  const results = await Promise.allSettled(fileIds.map((id) => wire.remove(id)));
  const missed = results.filter((r) => r.status === 'rejected').length;
  if (missed > 0) {
    logger.warn(
      { executor: CODE_EXECUTOR_ID, missed, of: fileIds.length },
      `code execution: ${missed} file(s) were not deleted and expire on their own within ${UPLOAD_EXPIRES_S} s`,
    );
  }
}

/**
 * The relayed command's result as one ExecutionResult: a limit the provider or the wrapper hit is
 * `stopped` and named, a tool error that means nothing ran is thrown, and so is a run that never
 * found its uploads. `toDelete` gains the files the command handed back.
 */
async function resultOf(
  wire: CodeExecutionWire,
  run: { executionId: string; durationMs: number; result: BashResultContent },
  request: ExecutionRequest,
  signal: AbortSignal,
  toDelete: string[],
): Promise<ExecutionResult> {
  const { executionId, durationMs, result } = run;
  const base = { executionId, adapter: CODE_EXECUTOR_ID, durationMs };
  if (result.error_code !== undefined) {
    const stopped = LIMIT_ERRORS[result.error_code];
    if (!stopped) {
      throw new Error(`the code execution tool refused the command: ${result.error_code}`);
    }
    return {
      ...base,
      exit: -1,
      stopped,
      frames: [],
      logs: { stdout: '', stderr: '' },
      error: {
        name: result.error_code,
        message: `the provider stopped the command (${result.error_code})`,
      },
    };
  }
  const logs = { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  const exit = result.return_code ?? -1;
  if (exit === UPLOADS_MISSING_EXIT && logs.stderr.includes('forge: ')) {
    throw new Error(`the container did not hold the uploaded files: ${logs.stderr.trim()}`);
  }
  const outputs = outputIds(result);
  toDelete.push(...outputs);
  if (logs.stderr.includes(WALL_MARK)) {
    return {
      ...base,
      exit,
      stopped: 'wallMs',
      frames: [],
      logs,
      error: {
        name: 'WallLimit',
        message: `the script ran past limits.wallMs of ${request.limits.wallMs} ms and was stopped`,
      },
    };
  }
  const out = await framesOf(wire, outputs, request.limits.outputBytes, signal);
  return {
    ...base,
    exit,
    ...(out.stopped ? { stopped: out.stopped } : {}),
    frames: out.frames,
    logs,
    ...(out.error ? { error: out.error } : {}),
  };
}

/** The adapter. Registered by the process entry only where the deployment holds the provider key. */
export function createCodeExecutor(cfg: CodeExecutorConfig): Executor {
  const wire = codeExecutionWire(cfg);
  const book = cfg.book ?? new ContainerBook();

  /** The relay call in the scope's container, once more in a fresh one if the provider refuses it. */
  async function inContainer(
    scope: ExecutionScope,
    command: string,
    uploaded: Uploaded,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof relay>>> {
    const key = ContainerBook.keyOf(scope);
    const container = key ? book.get(key, Date.now()) : undefined;
    let called: Awaited<ReturnType<typeof relay>>;
    try {
      called = await relay(wire, cfg.model, { command, uploaded, container }, signal);
    } catch (err) {
      if (!(key && container && isContainerGone(err))) throw err;
      book.drop(key);
      called = await relay(wire, cfg.model, { command, uploaded, container: undefined }, signal);
    }
    if (key && called.answer.container?.id) book.keep(key, called.answer.container.id, Date.now());
    return called;
  }

  return {
    id: CODE_EXECUTOR_ID,
    mode: 'in-band',
    isolation:
      "the provider's code execution container: 1 CPU, 5 GiB RAM, 5 GiB disk, no network, one per project, conversation and asker, scoped to the API key's workspace",
    network: 'none',
    dataLeavesTo: 'anthropic',
    // the docs mark both the code execution tool and the Files API `zdr: not-eligible`
    zdrEligible: false,
    availableFor: (project: { id: string; compute: ComputePolicy }) =>
      project.compute.enabled === true &&
      project.compute.thirdParty === true &&
      project.compute.zdrOnly !== true,

    async execute(request: ExecutionRequest, scope: ExecutionScope): Promise<ExecutionResult> {
      if (request.limits.cpu > 1) {
        throw new Error(
          `${CODE_EXECUTOR_ID} runs on the container's one CPU, so limits.cpu ${request.limits.cpu} cannot be granted; ask for 1 or less`,
        );
      }
      const budget = request.limits.wallMs + CALL_OVERHEAD_MS;
      const signal = AbortSignal.timeout(budget);
      const tag = randomBytes(6).toString('hex');
      const files: string[] = [];
      const started = Date.now();
      try {
        const upload = async (name: string, text: string) => {
          const id = await wire.upload(`forge-${tag}-${name}`, text, UPLOAD_EXPIRES_S, signal);
          files.push(id);
          return id;
        };
        const ids = {
          script: await upload(scriptFile(request.language), request.script),
          inputs: await upload('inputs.json', JSON.stringify(scrubSecretsDeep(request.inputs))),
        };
        const uploaded = { ...ids, run: await upload('run.sh', runScript(tag, ids, request)) };
        const command = relayCommand(tag, uploaded.run);
        const called = await inContainer(scope, command, uploaded, signal);
        const own = ownResult(called.blocks, command);
        if ('why' in own) {
          throw new Error(
            `${own.why} (the call stopped with ${called.answer.stop_reason ?? 'no stop reason'}); nothing of the script is known to have run`,
          );
        }
        return await resultOf(
          wire,
          { executionId: called.answer.id, durationMs: Date.now() - started, result: own.result },
          request,
          signal,
          files,
        );
      } catch (err) {
        if (signal.aborted) {
          throw new Error(
            `the code execution call took longer than ${budget} ms and was abandoned`,
          );
        }
        throw err;
      } finally {
        await cleanUp(wire, files);
      }
    },
  };
}
