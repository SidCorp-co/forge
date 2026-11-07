// A script schedule's declared ops calls (REQ-87 BC-1): what it may call on its project's forge-ops
// target, checked read-only on every save and again before every firing, and run through the
// project's box. A call is the forge-ops CLI with one tool and the arguments the declaration fixed;
// the box runs it with no shell, as it runs a support room's declared read (`ops.read`, ISS-871), and
// the CLI keeps its own credential. Read-only on the target means a tool forge-ops only reads with
// (FORGE_OPS_READ_TOOLS), or `exec_command` whose command support's classifier reads as a read
// (REQ-75 r5 BC-27); `deploy` and any tool the table does not name are refused by name. The script
// names a call and passes nothing: its arguments are the declaration's.

import {
  FORGE_OPS_EXEC_TOOL,
  FORGE_OPS_READ_TOOLS,
  SCRIPT_OPS_CALL_CAP,
  SCRIPT_OPS_TARGET,
  SCRIPT_OPS_TIMEOUT_DEFAULT_MS,
  type ScriptDoorRefusal,
  type ScriptOpsCall,
  type ScriptOpsCallDeclaration,
  type ScriptOpsDeclaration,
} from '@forge/contracts/script-sandbox';
import { SUPPORT_BOX_CAPABILITIES } from '@forge/contracts/support';
import { boxLacks } from '../agent-sessions/index.js';
import { onlineCapableDeviceIds, runOpsRead } from '../runners/index.js';
import type { ReadOutcome, ScriptOpsCaller } from '../sandbox/index.js';
import { schedulesPorts } from './ports.js';

const READ_TOOLS: readonly string[] = FORGE_OPS_READ_TOOLS;

/** Why a declared call is not read-only on the forge-ops target, or null where it only reads. */
export function callNotReadOnly(call: ScriptOpsCallDeclaration): string | null {
  if (READ_TOOLS.includes(call.tool)) return null;
  if (call.tool === FORGE_OPS_EXEC_TOOL) {
    const command = call.args?.command;
    if (typeof command !== 'string' || command.trim() === '') {
      return `${call.name} runs ${FORGE_OPS_EXEC_TOOL} with no command; its args name the command it runs, as { target, command }`;
    }
    const cls = schedulesPorts().commandReads(command);
    return cls.reads
      ? null
      : `${call.name} runs ${FORGE_OPS_EXEC_TOOL} \`${command}\`, which is not read-only: ${cls.why}`;
  }
  return `${call.name} calls ${SCRIPT_OPS_TARGET} ${call.tool}, which is not one of its read-only tools (${[...READ_TOOLS, `${FORGE_OPS_EXEC_TOOL} with a reading command`].join(', ')})`;
}

export interface OpsRefusal {
  code: ScriptDoorRefusal;
  /** Where in the declaration, as a JSON pointer under `ops`. */
  path: string;
  detail: string;
}

/** Every declared call that is not read-only on the target, each by name; none where all only read. */
export function opsRefusals(decl: ScriptOpsDeclaration): OpsRefusal[] {
  const out: OpsRefusal[] = [];
  decl.calls.forEach((call, i) => {
    const why = callNotReadOnly(call);
    if (why) {
      out.push({
        code: 'SCRIPT_OPS_NOT_READ_ONLY',
        path: `/ops/calls/${i}`,
        detail: `SCRIPT_OPS_NOT_READ_ONLY: ${why}. A script schedule reads production and never changes it.`,
      });
    }
  });
  return out;
}

/** The argv the box runs for a declared call: the CLI, the tool, and its fixed arguments as one JSON item. */
export function opsArgv(decl: ScriptOpsDeclaration, call: ScriptOpsCallDeclaration): string[] {
  return [decl.program, call.tool, JSON.stringify(call.args ?? {})];
}

/** The box a project's ops calls run on: one online box bound to it that runs a declared read. */
async function opsBoxOf(
  projectId: string,
): Promise<{ ok: true; deviceId: string } | { ok: false; why: string }> {
  const need = SUPPORT_BOX_CAPABILITIES.reads;
  const online = await onlineCapableDeviceIds(projectId, undefined, {
    includeLimited: true,
    includeBelowFloor: true,
  });
  for (const deviceId of online) {
    const box = await boxLacks(deviceId, [need]);
    if (box && box.lacks.length === 0) return { ok: true, deviceId };
  }
  return {
    ok: false,
    why:
      online.length === 0
        ? 'no box bound to this project is online to run it'
        : `no online box bound to this project declares ${need}: its forge-runner predates it (\`forge-runner update\` on the box)`,
  };
}

const refused = (code: ScriptDoorRefusal, message: string): ReadOutcome => ({
  ok: false,
  name: code === 'SCRIPT_OPS_FAILED' ? 'ScriptOpsFailed' : 'ScriptOpsRefused',
  code,
  message,
});

/**
 * The ctx.ops host of one firing: a declared call runs on the project's box, and anything else is
 * refused by name with nothing asked of the box. Every call, run or refused, is kept for the fire.
 */
export function openOpsCaller(args: {
  projectId: string;
  decl: ScriptOpsDeclaration | null;
  /** Stand-in for the box in a unit test; the project's box otherwise. */
  run?: (argv: string[], timeoutMs: number) => ReturnType<typeof runOpsRead>;
}): { names: string[]; call: ScriptOpsCaller; calls(): ScriptOpsCall[] } {
  const log: ScriptOpsCall[] = [];
  const declared = new Map((args.decl?.calls ?? []).map((c) => [c.name, c]));
  let box: Promise<Awaited<ReturnType<typeof opsBoxOf>>> | null = null;
  const run =
    args.run ??
    (async (argv: string[], timeoutMs: number) => {
      box ??= opsBoxOf(args.projectId);
      const picked = await box;
      if (!picked.ok) return { ok: false as const, why: picked.why };
      return runOpsRead({
        deviceId: picked.deviceId,
        projectId: args.projectId,
        name: argv[1] ?? '',
        argv,
        timeoutMs,
      });
    });

  const call: ScriptOpsCaller = async (name, given) => {
    const said = name.slice(0, 64);
    const refuse = (code: ScriptDoorRefusal, message: string) => {
      log.push({ name: said, outcome: code === 'SCRIPT_OPS_FAILED' ? 'failed' : 'refused', code });
      return refused(code, message);
    };
    const decl = declared.get(name);
    if (!decl || !args.decl) {
      const names = [...declared.keys()].join(', ');
      return refuse(
        'SCRIPT_OPS_UNDECLARED',
        `SCRIPT_OPS_UNDECLARED: ctx.ops.${said} is not declared on this schedule; it declares ${names || 'no call'}. Declare it under the schedule's ops to call it. Nothing ran.`,
      );
    }
    if (given !== null && given !== undefined) {
      return refuse(
        'SCRIPT_OPS_UNDECLARED',
        `SCRIPT_OPS_UNDECLARED: ctx.ops.${said} takes no arguments: its arguments are fixed in the schedule's declaration. Nothing ran.`,
      );
    }
    if (log.length >= SCRIPT_OPS_CALL_CAP) {
      return refuse(
        'SCRIPT_OPS_UNDECLARED',
        `SCRIPT_OPS_UNDECLARED: this firing has made ${SCRIPT_OPS_CALL_CAP} ops calls, its cap; the rest are not run`,
      );
    }
    // read again at the call: a declaration that stopped reading never reaches the box
    const why = callNotReadOnly(decl);
    if (why)
      return refuse('SCRIPT_OPS_NOT_READ_ONLY', `SCRIPT_OPS_NOT_READ_ONLY: ${why}. Nothing ran.`);
    const ran = await run(
      opsArgv(args.decl, decl),
      decl.timeoutMs ?? SCRIPT_OPS_TIMEOUT_DEFAULT_MS,
    );
    if (!ran.ok) {
      return refuse(
        'SCRIPT_OPS_FAILED',
        `SCRIPT_OPS_FAILED: ctx.ops.${said} did not run: ${ran.why}`,
      );
    }
    const v = ran.value;
    log.push({
      name: said,
      outcome: 'answered',
      exitCode: v.exitCode,
      ...(v.timedOut ? { timedOut: true } : {}),
      durationMs: Math.max(0, Math.round(v.durationMs)),
    });
    return {
      ok: true,
      body: {
        exitCode: v.exitCode,
        stdout: v.stdout,
        stderr: v.stderr,
        truncated: v.truncated,
        timedOut: v.timedOut,
        durationMs: v.durationMs,
      },
    };
  };

  return { names: [...declared.keys()], call, calls: () => log.map((c) => ({ ...c })) };
}
