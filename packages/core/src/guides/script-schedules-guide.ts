import {
  FORGE_OPS_EXEC_TOOL,
  FORGE_OPS_LOGS_TAIL_MAX,
  FORGE_OPS_READ_TOOLS,
  SCRIPT_FEEDBACK_CAP,
  SCRIPT_FILING_SHAPE,
  SCRIPT_OPS_CALL_CAP,
  SCRIPT_STATE_CAP_BYTES,
} from '@forge/contracts/script-sandbox';
import type { CoreGuide } from './types.js';

const readTools = FORGE_OPS_READ_TOOLS.map((t) => `\`${t}\``).join(', ');

/** REQ-87: a script schedule reading its project's business state with no agent session. */
export const SCRIPT_SCHEDULES_GUIDE: CoreGuide = {
  slug: 'script-schedules',
  audience: 'agent',
  title: 'Script schedules: business reads that file a confirmed breach',
  summary:
    "A script schedule runs a check no standard tool does (a business read) through read-only calls it declares on the forge-ops target, keeps a small state between firings and files deduplicated feedback on a breach seen twice, with no agent session. Production monitoring is the monitoring guide's.",
  version: 4,
  body: `## Script schedules: business reads that file a confirmed breach

A \`script\` schedule runs a JavaScript script in Forge's sandbox on its cron, with no agent session:
a 15-minute check is 96 firings a day and spends no tokens. Use it for a check no standard tool does,
a business read (orders stuck past their window, an import that did not land). Production
monitoring (up, latency, errors, disk) is never a script: it is the Prometheus integration,
\`GET /api/guides/monitoring.md\`. A daily summary stays a \`prompt\` or \`status_report\` schedule.

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

### Turning one on
1. \`POST /api/schedules { projectId, name, kind: "script", cron, script, params, ops }\`, as the
   project's master: the save refuses any call that is not read-only, by name.
2. \`POST /api/schedules/:id/run\` once and read its fire: every call \`answered\`, no filing.
3. Plant a breach (a threshold in \`params\` below the live value), run twice: the second firing files
   one item, a third joins nothing new. Put the threshold back.`,
};
