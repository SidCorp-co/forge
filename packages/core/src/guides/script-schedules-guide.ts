import {
  FORGE_OPS_EXEC_TOOL,
  FORGE_OPS_LOGS_TAIL_MAX,
  FORGE_OPS_READ_TOOLS,
  SCRIPT_FEEDBACK_CAP,
  SCRIPT_FILING_SHAPE,
  SCRIPT_OPS_CALL_CAP,
  SCRIPT_STATE_CAP_BYTES,
  type ScriptOpsDeclaration,
} from '@forge/contracts/script-sandbox';
import type { CoreGuide } from './types.js';

/**
 * The example watch a project master copies (REQ-87 BC-5), shipped as code so the tests run exactly
 * what the guide teaches: the declaration of its calls on the project's forge-ops target, and the
 * script that files one feedback item for a breach seen on two firings in a row.
 */
export const PRODUCTION_WATCH_OPS: ScriptOpsDeclaration = {
  program: '/home/dev/.local/bin/forge-ops',
  secrets: [{ env: 'FORGE_OPS_TOKEN', secret: 'secret://ops/forge-ops-token' }],
  calls: [
    { name: 'status', tool: 'status', args: { target: 'epod-production' } },
    {
      name: 'disk',
      tool: FORGE_OPS_EXEC_TOOL,
      args: { target: 'epod-production', service: 'go-backend', command: 'disk' },
      readOnlyBecause: 'the dashboard vetted disk to print df -P / and nothing else',
    },
    {
      name: 'metrics',
      tool: FORGE_OPS_EXEC_TOOL,
      args: { target: 'epod-production', service: 'go-backend', command: 'metrics' },
      readOnlyBecause: 'the dashboard vetted metrics to print the service metrics JSON',
    },
  ],
};

/** The thresholds the example reads from the schedule's params, so a master tunes them without editing code. */
export const PRODUCTION_WATCH_PARAMS = {
  signalPrefix: 'epod',
  diskPercent: 85,
  postingSecondsP95: 30,
  apiP50Ms: 300,
  apiP95Ms: 1500,
  apiP99Ms: 4000,
  apiErrorRate: 0.02,
  cdcLagRows: 1000,
  indexPending: 5000,
  indexStuck: 0,
  indexFailed: 0,
};

export const PRODUCTION_WATCH_SCRIPT = `const p = ctx.params;
const seen = {}; // signal key -> what was seen, or null where it reads healthy
const blind = new Set(); // the signals that say the watch could not read, never that production broke
const unreached = []; // the calls no box could be reached for: one cause, the box connection
const key = (name) => p.signalPrefix + ':' + name;
const blindKey = (name) => {
  const k = key('watch-blind-' + name);
  blind.add(k);
  return k;
};
const call = async (name) => {
  try {
    const out = await ctx.ops[name]();
    seen[blindKey(name)] = out.exitCode === 0 ? null : name + ' exited ' + out.exitCode + ': ' + out.stderr.slice(0, 500);
    return out.exitCode === 0 ? out.stdout : null;
  } catch (e) {
    if (e.code === 'SCRIPT_OPS_BOX_UNREACHABLE') {
      // the box's connection, not this check: read once below for every call it took down
      seen[blindKey(name)] = null;
      unreached.push(name + ': ' + e.message);
    } else {
      seen[blindKey(name)] = name + ' did not run: ' + e.message;
    }
    return null;
  }
};

const status = await call('status');
if (status !== null) seen[key('service-down')] = /down|unhealthy|crash|error/i.test(status) ? status.slice(0, 1000) : null;

const disk = await call('disk');
if (disk !== null) {
  const used = Number((disk.trim().split('\\n').pop() || '').split(/\\s+/)[4]?.replace('%', ''));
  seen[key('disk')] = used > p.diskPercent ? 'disk ' + used + '% used, over ' + p.diskPercent + '%' : null;
}

const raw = await call('metrics');
if (raw !== null) {
  let m = null;
  try { m = JSON.parse(raw); } catch { seen[blindKey('metrics')] = 'the metrics are not JSON'; }
  if (m) {
    const over = (v, max, what) => (v > max ? what + ' ' + v + ', over ' + max : null);
    seen[key('posting-speed')] = over(m.posting?.p95Seconds, p.postingSecondsP95, 'posting p95 seconds');
    seen[key('api-latency')] =
      [over(m.api?.p50Ms, p.apiP50Ms, 'API p50 ms'), over(m.api?.p95Ms, p.apiP95Ms, 'API p95 ms'), over(m.api?.p99Ms, p.apiP99Ms, 'API p99 ms')]
        .filter(Boolean).join('; ') || null;
    seen[key('api-errors')] = over(m.api?.errorRate, p.apiErrorRate, 'API error rate');
    seen[key('cdc')] =
      !m.cdc ? 'the metrics carry no cdc block'
      : m.cdc.slotActive === false ? 'the Debezium slot is not active'
      : m.cdc?.taskState !== 'RUNNING' ? 'the Debezium task is ' + m.cdc?.taskState
      : over(m.cdc?.lagRows, p.cdcLagRows, 'Postgres to Elasticsearch gap rows');
    seen[key('index-queue')] =
      [over(m.index?.pending, p.indexPending, 'pending'), over(m.index?.stuck, p.indexStuck, 'stuck'), over(m.index?.failed, p.indexFailed, 'failed')]
        .filter(Boolean).join('; ') || null;
  }
}

seen[blindKey('box')] = unreached.length === 0 ? null
  : 'The watch could not reach the box for ' + unreached.length + ' of its calls; production was not read, not found broken.\\n' + unreached.join('\\n');

// a breach files once, on its second firing in a row; a blip files nothing; a recovery resets it.
// A blind watch files as blind, below a breach: it says nothing about production.
const streak = ctx.state.get().streak ?? {};
const next = {};
const filed = [];
for (const [signal, detail] of Object.entries(seen)) {
  if (detail === null) continue;
  next[signal] = (streak[signal] ?? 0) + 1;
  if (next[signal] === 2) {
    const isBlind = blind.has(signal);
    const item = await ctx.feedback.file({
      kind: 'bug',
      severity: isBlind ? 'medium' : 'high',
      title: (isBlind ? 'Production watch blind twice: ' : 'Production breach confirmed twice: ') + signal,
      body: detail + '\\n\\nSeen on two watch runs in a row.',
      signalKey: signal,
    });
    filed.push(item.key);
  }
}
ctx.state.set({ streak: next });
ctx.log('breaches', JSON.stringify(next), 'filed', filed.join(', ') || 'none');
return { breaches: next, filed };`;

const readTools = FORGE_OPS_READ_TOOLS.map((t) => `\`${t}\``).join(', ');

/** REQ-87: a script schedule watching its project's production with no agent session. */
export const SCRIPT_SCHEDULES_GUIDE: CoreGuide = {
  slug: 'script-schedules',
  audience: 'agent',
  title: 'Script schedules: watch production and file a confirmed breach',
  summary:
    "A script schedule reads its project's production through read-only calls it declares on the forge-ops target, keeps a small state between firings and files deduplicated feedback on a breach seen twice, with no agent session. The rules, and an example watch a master copies.",
  version: 3,
  body: `## Script schedules: watch production and file a confirmed breach

A \`script\` schedule runs a JavaScript script in Forge's sandbox on its cron, with no agent session:
a 15-minute watch is 96 firings a day and spends no tokens. Use it for a production watch; a daily
summary stays a once-a-day \`prompt\` or \`status_report\` schedule.

### What the script holds
- \`ctx.ops.<name>()\`: a call the schedule declares, run on the project's box through the forge-ops CLI.
  It answers \`{ exitCode, stdout, stderr, truncated, timedOut, durationMs }\` and takes no arguments:
  they are fixed in the declaration. At most ${SCRIPT_OPS_CALL_CAP} calls a firing. A box that drops and
  comes back within the call's \`timeoutMs\` is waited for. A call that did not run throws an error whose
  \`code\` says why: \`SCRIPT_OPS_BOX_UNREACHABLE\` where no box could be reached (none online, it did not
  come back in time, or it never answered), a cause every call of the firing shares; \`SCRIPT_OPS_FAILED\`
  where the call failed for its own reason.
- \`ctx.feedback.file(${SCRIPT_FILING_SHAPE})\`: files one item on the schedule's own project, as the
  project's own agent, seen on the schedule. An open item with the same \`signalKey\` is joined as an
  occurrence, never filed twice. It answers \`{ key, created }\`. At most ${SCRIPT_FEEDBACK_CAP} a firing.
- \`ctx.state.get()\` / \`ctx.state.set(object)\`: one JSON object kept between firings, at most
  ${SCRIPT_STATE_CAP_BYTES} bytes. It is written only when the firing succeeds.
- \`ctx.forge.get\`, \`ctx.log\`, \`ctx.notify\`, \`ctx.params\` as before.

### Rules
1. **Declare every call, read-only.** \`ops: { program, secrets, calls: [{ name, tool, args, timeoutMs?, readOnlyBecause? }] }\`
   on the schedule (\`POST /api/schedules\` or \`PUT /api/schedules/:id\`). \`secrets\` names the forge-ops
   credential as project secrets (\`[{ env, secret: secret://<scope>/<name> }]\`): each call's process alone is
   handed them, never the box's own, and an unset one fails the call by name. A call is read-only when its tool is
   ${readTools}, or \`${FORGE_OPS_EXEC_TOOL}\` in one of two forms:
   - **A named command** (\`{ target, service, command }\`): \`command\` is a name the ops dashboard vetted
     for that service (\`health\`), never a shell line, and the call says why it only reads in
     \`readOnlyBecause\`. forge-ops runs only the names its dashboard vetted.
   - **A command line** (\`{ target, command }\`) on a target that takes one, which only reads (\`cat\`,
     \`df\`, \`grep\`, \`tail\` without follow, …: the rule a support room's host command meets).

   Any other tool, \`deploy\` among them, a command that can write (a pipe into a writer, \`>\`, \`;\`,
   \`psql\`, \`curl\`), or a named command with no \`readOnlyBecause\` is refused \`SCRIPT_OPS_NOT_READ_ONLY\`
   at save, and a firing whose declaration stopped reading fails by that name before its script runs.
   A call past what forge-ops answers (\`logs\` with \`tail\` over ${FORGE_OPS_LOGS_TAIL_MAX}) is refused
   \`SCRIPT_OPS_OVER_TARGET_LIMIT\`. A firing left running by a core restart is closed as failed, naming it.
2. **Call only what you declared.** \`ctx.ops.deploy()\` on a schedule that does not declare it is refused
   \`SCRIPT_OPS_UNDECLARED\`, nothing reaches the box, and the refusal is on the firing's record.
3. **Confirm before filing.** File a breach only when the state says the same signal was seen on the
   previous firing too, drop a signal from the state the firing it reads healthy, and file with a stable
   \`signalKey\` per signal: one breach is one item however long it lasts.
4. **Never write production from a script.** A metric only a query can read is exposed as something a
   read-only call reads (a file the service writes, a log line, a forge-ops read tool), never a query
   command in the declaration.
5. **Read the record, not the output.** Each firing's run history keeps every call by name with its
   outcome, every filing (the item filed or joined, or why it was refused) and the state it left:
   \`GET /api/projects/:id/automation/fires/:fireId\`, the newest under \`/automation/standing\`.

### The example production watch
It watches service status, disk, posting speed, API p50/p95/p99 and error rate, CDC health and the
index queue, and files once per breach seen twice, at \`high\`. A call that cannot run is \`watch-blind\`,
filed at \`medium\` and never titled a breach: a blind watch did not read production. Calls the box
could not be reached for share one cause, so they file one \`watch-blind-box\` item naming each call,
never one per call; a call that ran and failed on its own files as its own \`watch-blind-<call>\`.
Copy it, set your target and the metrics path, and tune the thresholds in \`params\`.

Declaration (\`ops\`):

\`\`\`json
${JSON.stringify(PRODUCTION_WATCH_OPS, null, 2)}
\`\`\`

Params (\`params\`):

\`\`\`json
${JSON.stringify(PRODUCTION_WATCH_PARAMS, null, 2)}
\`\`\`

The example's \`disk\` and \`metrics\` are named commands the target's ops dashboard has to vet first;
until it does, forge-ops refuses them and the watch files \`watch-blind\` for each.
The metrics document the \`metrics\` call reads: \`{ posting: { p95Seconds }, api: { p50Ms, p95Ms, p99Ms,
errorRate }, cdc: { slotActive, taskState, lagRows }, index: { pending, stuck, failed } }\`.

Script (\`script\`), with \`kind: "script"\` and \`cron: "*/15 * * * *"\`:

\`\`\`js
${PRODUCTION_WATCH_SCRIPT}
\`\`\`

### Turning it on
1. \`POST /api/schedules { projectId, name, kind: "script", cron: "*/15 * * * *", script, params, ops }\`,
   as the project's master: the save refuses any call that is not read-only, by name.
2. \`POST /api/schedules/:id/run\` once and read its fire: every call \`answered\`, no filing.
3. Plant a breach (a threshold in \`params\` below the live value), run twice: the second firing files
   one item, a third joins nothing new. Put the threshold back.

A saved schedule keeps the script it was saved with: a change to this example reaches a watch only
when its script is saved again from here (\`PUT /api/schedules/:id { script }\`).`,
};
