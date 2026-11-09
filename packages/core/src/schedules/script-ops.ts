// A script schedule's declared ops calls (REQ-87 BC-1): what it may call on its project's forge-ops
// target, checked read-only on every save and again before every firing, and run through the
// project's box. A call is the forge-ops CLI with one tool and the arguments the declaration fixed;
// the box runs it with no shell, as it runs a support room's declared read (`ops.read`, ISS-871), and
// the CLI keeps its own credential. Read-only on the target means a tool forge-ops only reads with
// (FORGE_OPS_READ_TOOLS), or `exec_command` whose command support's classifier reads as a read
// (REQ-75 r5 BC-27); `deploy` and any tool the table does not name are refused by name. The script
// names a call and passes nothing: its arguments are the declaration's.

import {
  FORGE_OPS_COMMAND_NAME,
  FORGE_OPS_EXEC_TOOL,
  FORGE_OPS_LOGS_TAIL_MAX,
  FORGE_OPS_READ_TOOLS,
  SCRIPT_OPS_CALL_CAP,
  SCRIPT_OPS_TARGET,
  SCRIPT_OPS_TIMEOUT_DEFAULT_MS,
  type ScriptDoorRefusal,
  type ScriptOpsCall,
  type ScriptOpsCallDeclaration,
  type ScriptOpsDeclaration,
} from '@forge/contracts/script-sandbox';
import { runOpsRead } from '../runners/index.js';
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
    const service = call.args?.service;
    if (service !== undefined) return namedCommandNotReadOnly(call, String(service), command);
    const cls = schedulesPorts().commandReads(command);
    return cls.reads
      ? null
      : `${call.name} runs ${FORGE_OPS_EXEC_TOOL} \`${command}\`, which is not read-only: ${cls.why}`;
  }
  return `${call.name} calls ${SCRIPT_OPS_TARGET} ${call.tool}, which is not one of its read-only tools (${[...READ_TOOLS, `${FORGE_OPS_EXEC_TOOL} with a reading command`].join(', ')})`;
}

/**
 * A forge-ops command on a service is a name its ops dashboard vetted, never a shell line, so it is
 * not read as one (ISS-1130): it passes where it is a bare name and the call says why it only reads.
 */
function namedCommandNotReadOnly(
  call: ScriptOpsCallDeclaration,
  service: string,
  command: string,
): string | null {
  if (!FORGE_OPS_COMMAND_NAME.test(command)) {
    return `${call.name} runs ${FORGE_OPS_EXEC_TOOL} \`${command}\` on service ${service}, which is not a command name: a forge-ops command on a service is a name its ops dashboard vetted (such as health), never a shell line`;
  }
  return call.readOnlyBecause
    ? null
    : `${call.name} runs forge-ops command ${service}/${command} without saying why it only reads: declare readOnlyBecause on the call, kept on the schedule`;
}

/** Why a declared call's fixed arguments are past what the target answers, or null. */
export function callOverTargetLimit(call: ScriptOpsCallDeclaration): string | null {
  const tail = call.args?.tail;
  return call.tool === 'logs' && typeof tail === 'number' && tail > FORGE_OPS_LOGS_TAIL_MAX
    ? `${call.name} asks logs for tail ${tail}, past forge-ops' limit of ${FORGE_OPS_LOGS_TAIL_MAX} lines, which it refuses: ask ${FORGE_OPS_LOGS_TAIL_MAX} or fewer`
    : null;
}

export interface OpsRefusal {
  code: ScriptDoorRefusal;
  /** Where in the declaration, as a JSON pointer under `ops`. */
  path: string;
  detail: string;
}

/** Every declared call that is not read-only on the target, or asks past its limits, each by name; none where all pass. */
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
    const over = callOverTargetLimit(call);
    if (over) {
      out.push({
        code: 'SCRIPT_OPS_OVER_TARGET_LIMIT',
        path: `/ops/calls/${i}/args`,
        detail: `SCRIPT_OPS_OVER_TARGET_LIMIT: ${over}.`,
      });
    }
  });
  return out;
}

/** The argv the box runs for a declared call: the CLI, the tool, and its fixed arguments as one JSON item. */
export function opsArgv(decl: ScriptOpsDeclaration, call: ScriptOpsCallDeclaration): string[] {
  return [decl.program, call.tool, JSON.stringify(call.args ?? {})];
}

/** A call that was asked of the box and did not run: it failed, where every other refusal refused it. */
const didNotRun = (code: ScriptDoorRefusal): boolean =>
  code === 'SCRIPT_OPS_FAILED' || code === 'SCRIPT_OPS_BOX_UNREACHABLE';

const refused = (code: ScriptDoorRefusal, message: string): ReadOutcome => ({
  ok: false,
  name: didNotRun(code) ? 'ScriptOpsFailed' : 'ScriptOpsRefused',
  code,
  message,
});

/** What the box answered a call, or why it did not run; `boxUnreachable` where no box could be reached. */
type OpsRan =
  | Extract<Awaited<ReturnType<typeof runOpsRead>>, { ok: true }>
  | { ok: false; why: string; transport?: 'disconnected' | 'unanswered'; boxUnreachable?: true };

/**
 * The ctx.ops host of one firing: a declared call runs on the project's box, and anything else is
 * refused by name with nothing asked of the box. Every call, run or refused, is kept for the fire.
 */
export function openOpsCaller(args: {
  projectId: string;
  decl: ScriptOpsDeclaration | null;
  /** The schedule's name, which a call's amnesty warning names. */
  scheduleName?: string;
  /** Stand-in for the box in a unit test; the project's box otherwise. */
  run?: (argv: string[], timeoutMs: number) => Promise<OpsRan>;
}): { names: string[]; call: ScriptOpsCaller; calls(): ScriptOpsCall[] } {
  const log: ScriptOpsCall[] = [];
  const declared = new Map((args.decl?.calls ?? []).map((c) => [c.name, c]));
  let box: ReturnType<ReturnType<typeof schedulesPorts>['projectReadBox']> | null = null;
  const run =
    args.run ??
    (async (argv: string[], timeoutMs: number): Promise<OpsRan> => {
      // the credential is the declaration's project secret, handed for this call alone (ISS-707); a
      // stored declaration with none runs on the box's own, under amnesty `script-ops-box-credential`
      const { secretEnvOf, projectReadBox, withoutSecrets } = schedulesPorts();
      const env = await secretEnvOf(args.projectId, argv[1] ?? '', args.decl?.secrets);
      if (!env.ok) return { ok: false as const, why: env.refusals.map((r) => r.detail).join('; ') };
      box ??= projectReadBox(args.projectId);
      const picked = await box;
      if (!picked.ok)
        return {
          ok: false as const,
          why: picked.refusals.map((r) => r.detail).join('; '),
          boxUnreachable: true as const,
        };
      const ran = await runOpsRead({
        deviceId: picked.value,
        projectId: args.projectId,
        name: argv[1] ?? '',
        argv,
        timeoutMs,
        ...(args.decl?.secrets ? { env: env.env } : {}),
      });
      if (!ran.ok) {
        return {
          ok: false as const,
          why: withoutSecrets(ran.why, env.env),
          ...(ran.transport ? { transport: ran.transport } : {}),
        };
      }
      return {
        ok: true as const,
        value: {
          ...ran.value,
          stdout: withoutSecrets(ran.value.stdout, env.env),
          stderr: withoutSecrets(ran.value.stderr, env.env),
        },
      };
    });

  // amnesty `script-ops-box-credential` (ISS-707, .forge/conformance.json): a declaration stored before
  // secrets were asked names none, so its calls run on the box's own forge-ops credential, each saying so
  const boxCredential =
    args.decl && !args.decl.secrets
      ? `${args.scheduleName ?? 'this schedule'} declares no secrets, so this call ran on the box's own forge-ops credential (ISS-707 amnesty); save the schedule with ops.secrets naming its credential as a project secret`
      : null;

  const call: ScriptOpsCaller = async (name, given) => {
    const said = name.slice(0, 64);
    const refuse = (code: ScriptDoorRefusal, message: string) => {
      log.push({ name: said, outcome: didNotRun(code) ? 'failed' : 'refused', code });
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
      // the way to the box failed, not the call: every call of the firing shares that one cause
      const code = ran.transport || ran.boxUnreachable ? 'SCRIPT_OPS_BOX_UNREACHABLE' : 'SCRIPT_OPS_FAILED';
      return refuse(code, `${code}: ctx.ops.${said} did not run: ${ran.why}`);
    }
    const v = ran.value;
    log.push({
      name: said,
      outcome: 'answered',
      ...(boxCredential ? { warning: boxCredential } : {}),
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
