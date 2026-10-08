/**
 * The reads an Agent session made, by the name the Assistant's tool for the same read has (REQ-30
 * BC-1, BC-2; chat-turn design, steps `repo` and `check`).
 *
 * An Agent session has no forge tools: it reads the project through core's REST routes with
 * `forge-runner api` from its shell, so its transcript names every read `Bash`. Read that way, no
 * read-backed rule could judge it: `status-claims-grounded` abstained (no read was offered) and a
 * figure from the status read grounded nothing. Each `forge-runner api` call to a route the table
 * below names is the read of that name, so the same rules judge both modes. A call the table does
 * not name is no read here, and a write to a read's route (a `-X` other than the one it reads
 * with) is none either.
 */

import { MEMORY_TOOL } from './status-claims-rule.js';

type Method = 'GET' | 'POST';

/** A route path (after `/api/`), the method it is read with, and the read it is. */
const AGENT_READ_ROUTES: readonly { re: RegExp; method: Method; read: string }[] = [
  { re: /^projects\/[^/]+\/status$/, method: 'GET', read: 'forge_project_status' },
  { re: /^projects\/[^/]+\/requirements$/, method: 'GET', read: 'forge_requirements' },
  { re: /^projects\/[^/]+\/requirements\/[^/]+$/, method: 'GET', read: 'forge_requirement' },
  {
    re: /^projects\/[^/]+\/requirements\/[^/]+\/decisions$/,
    method: 'GET',
    read: 'forge_decisions',
  },
  {
    re: /^projects\/[^/]+\/(?:requirements|workflows|feedback|issues)\/[^/]+\/comments\?(?:.*&)?intent=decision\b/,
    method: 'GET',
    read: 'forge_decisions',
  },
  { re: /^projects\/[^/]+\/releases$/, method: 'GET', read: 'forge_releases' },
  { re: /^projects\/[^/]+\/releases\/[^/]+$/, method: 'GET', read: 'forge_release' },
  {
    re: /^projects\/[^/]+\/metrics\/timeseries$/,
    method: 'GET',
    read: 'forge_metrics_project_timeseries',
  },
  { re: /^projects\/[^/]+\/report-queries\/[^/]+\/runs$/, method: 'POST', read: 'forge_report' },
  {
    re: /^projects\/[^/]+\/report-templates\/[^/]+\/runs$/,
    method: 'POST',
    read: 'forge_template',
  },
  { re: /^projects\/[^/]+\/executions$/, method: 'POST', read: 'forge_compute' },
  { re: /^memory\/search$/, method: 'POST', read: MEMORY_TOOL },
];

/** Every read an Agent session can make: what it is offered, as the Assistant is offered its tools. */
export const AGENT_READS: readonly string[] = [...new Set(AGENT_READ_ROUTES.map((r) => r.read))];

/** One call of an Agent session as its transcript holds it. */
export interface AgentCall {
  readonly name: string;
  readonly input: unknown;
  readonly output?: string | null | undefined;
  readonly isError?: boolean | undefined;
}

/** One read the session made, named as the Assistant's tool for it. */
export interface AgentRead {
  readonly name: string;
  /** The command that made it. */
  readonly arguments: string;
  readonly text: string;
  readonly isError: boolean;
}

/** What a shell call ran, or nothing where it is no shell call. */
function commandOf(call: AgentCall): string | null {
  if (call.name !== 'Bash') return null;
  const command = (call.input as { command?: unknown } | null)?.command;
  return typeof command === 'string' ? command : null;
}

const API_CALL_RE = /\bforge-runner\s+api\s+([^\n|;&]+)/g;
const PATH_RE = /(?:^|\s)['"]?\/?(?:api\/)?((?:projects|memory)\/[^\s'"]+)['"]?/;
const METHOD_RE = /(?:^|\s)(?:-X|--method)\s*['"]?([A-Za-z]+)/;
const DATA_RE = /(?:^|\s)(?:-d|--data|-F|--form)\b/;

/** The method one `forge-runner api` call sends: the one it names, else POST with a body, else GET. */
function methodOf(args: string): string {
  const named = METHOD_RE.exec(args)?.[1];
  if (named) return named.toUpperCase();
  return DATA_RE.test(args) ? 'POST' : 'GET';
}

/** The reads one shell command made, in the order it made them. */
export function readsInCommand(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(API_CALL_RE)) {
    const args = m[1] ?? '';
    const path = PATH_RE.exec(args)?.[1];
    if (!path) continue;
    const bare = path.split('?')[0] ?? path;
    const method = methodOf(args);
    const route = AGENT_READ_ROUTES.find(
      (r) => r.method === method && (r.re.test(bare) || r.re.test(path)),
    );
    if (route) out.push(route.read);
  }
  return out;
}

/**
 * The reads an Agent session's calls made, each with what its call returned. A command making
 * several reads hands each of them its whole output: the shell gives one, and a read stays a read.
 */
export function agentReadsOf(calls: readonly AgentCall[]): AgentRead[] {
  const out: AgentRead[] = [];
  for (const call of calls) {
    const command = commandOf(call);
    if (command === null) continue;
    for (const read of new Set(readsInCommand(command))) {
      out.push({
        name: read,
        arguments: command,
        text: call.output ?? '',
        isError: call.isError === true,
      });
    }
  }
  return out;
}
