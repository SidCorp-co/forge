/**
 * The agent face's door onto a project's repository — ISS-1074, ISS-1062's layer 5.
 *
 * `client.ts` is the KERNEL's reader: it takes the oldest active binding, asks no grant, and reads
 * JSON, because the projection is Forge's own model of the repository and is built whether or not
 * any agent may touch it. This is the other door. It asks the binding's `agent_access` before it
 * acts, and it writes.
 *
 * Discovery and authorization are two steps here and not one, which is the shape
 * `google/commands.ts` already has. A granted-only lookup would make an ungranted binding
 * indistinguishable from no binding at all — and the whole of ISS-1074's outcome 3 is that the two
 * are told apart: one sends an operator to a switch, the other to the Integrations page to bind a
 * repository at all.
 */

import { scrubLogText } from '@forge/observability';
import { grantHolds, notGrantedMessage } from '../agent-access.js';
import { getIntegration } from '../registry.js';
import {
  type BindingWithConnection,
  decryptConnectionSecrets,
  effectiveConfig,
  listBindingsForProject,
} from '../store.js';
import { GitHubAuthError, installationToken } from './app-auth.js';
import { buildRepoClient, GitHubClientError } from './client.js';
import { GITHUB_API_BASE, type GitHubConfig, type GitHubSecrets } from './types.js';

const AGENT_TIMEOUT_MS = 12_000;

/**
 * Why an agent cannot act on this project's repository. Each one sends an operator somewhere
 * different, which is why they are not one message:
 *
 * - `no_binding` — nobody has bound a repository. Integrations page.
 * - `binding_disabled` — a binding exists and is switched off, at one tier or the other.
 * - `not_granted` — it works, and no agent here may use it. The switch beside the integration.
 *
 * The four that follow are `client.ts`'s own, re-raised unchanged so one wording answers both doors.
 */
export type GitHubAgentRefusalReason = 'no_binding' | 'binding_disabled' | 'not_granted';

export class GitHubAgentRefusal extends Error {
  readonly reason: GitHubAgentRefusalReason;
  /** The binding the refusal is about, where there is one. */
  readonly bindingId: string | null;
  constructor(reason: GitHubAgentRefusalReason, message: string, bindingId: string | null = null) {
    super(message);
    this.name = 'GitHubAgentRefusal';
    this.reason = reason;
    this.bindingId = bindingId;
  }
}

/** GitHub itself refused or failed. Carries the status so a caller can tell 404 from 403. */
export class GitHubAgentCallError extends Error {
  readonly status: number;
  /** GitHub's own words, capped. Never the request body, which may carry the token. */
  readonly detail: string | null;
  constructor(status: number, message: string, detail: string | null = null) {
    super(message);
    this.name = 'GitHubAgentCallError';
    this.status = status;
    this.detail = detail;
  }
}

/** What `list` answers, and what a refusal is built from. Holds no credential. */
export interface GitHubAgentBindingReport {
  bindingId: string;
  /** `owner/repo` as the binding spells it, or null where it names neither. */
  repository: string | null;
  installed: boolean;
  bindingActive: boolean;
  connectionActive: boolean;
  /** Whether an agent on this project may use it — the binding's own `agent_access`. */
  agentGranted: boolean;
  lastHealthStatus: string | null;
}

export interface GitHubAgentClient {
  bindingId: string;
  owner: string;
  repo: string;
  /** `owner/repo`, as the binding spells it. */
  fullName: string;
  /** A JSON request as the installation: the reads and every write the agent face makes. */
  json<T>(args: { method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown }): Promise<T>;
  /**
   * A request whose answer is TEXT rather than JSON — a diff, a job log — redacted, then capped at
   * `maxBytes`.
   *
   * `bytes` is the length of the whole redacted answer, not of what came back, so a caller reading
   * `truncated` learns how much it is missing rather than only that something is. `keep` says which
   * end survives the cap: `head` (the default) for a diff, `tail` for a log whose failure is at its
   * end.
   */
  text(args: {
    path: string;
    accept: string;
    maxBytes: number;
    keep?: 'head' | 'tail';
  }): Promise<{ body: string; bytes: number; truncated: boolean }>;
  /**
   * Redact this client's own credential out of third-party text, on top of the generic shapes.
   *
   * A workflow that echoes `${{ secrets.GITHUB_TOKEN }}` prints an installation token, and the one
   * this read minted is the one likeliest to be in the log it is reading.
   */
  scrub(text: string): Promise<string>;
}

/** Every GitHub binding this project holds, oldest first. Discovery, not authorization. */
async function githubPairs(projectId: string): Promise<BindingWithConnection[]> {
  const rows = (await listBindingsForProject(projectId)).filter(
    (r) => r.binding.provider === 'github',
  );
  return rows.sort((a, b) => a.binding.createdAt.getTime() - b.binding.createdAt.getTime());
}

/** What `list` answers: every GitHub binding this project holds, with the grant beside it. */
export async function githubAgentBindings(projectId: string): Promise<GitHubAgentBindingReport[]> {
  const decl = getIntegration('github');
  return githubPairs(projectId).then((pairs) =>
    pairs.map((pair) => {
      const config = effectiveConfig<GitHubConfig>(pair);
      return {
        bindingId: pair.binding.id,
        repository: config.owner && config.repo ? `${config.owner}/${config.repo}` : null,
        installed: typeof config.installationId === 'number',
        bindingActive: pair.binding.active,
        connectionActive: pair.connection.active,
        agentGranted: grantHolds(decl, pair.binding),
        lastHealthStatus: pair.connection.lastHealthStatus ?? null,
      };
    }),
  );
}

/**
 * The binding an acting verb runs against, or the refusal naming which of the three it hit.
 *
 * Oldest active binding wins, mirroring `client.ts:findGitHubBinding`'s own guard: the two doors
 * must not disagree about which repository a project's github is, or a review written through one
 * lands on a pull request the other's projection never held.
 */
export async function resolveGrantedGitHubBinding(
  projectId: string,
): Promise<BindingWithConnection> {
  const pairs = await githubPairs(projectId);
  if (pairs.length === 0) {
    throw new GitHubAgentRefusal(
      'no_binding',
      'this project has no GitHub binding — bind a repository on its Integrations page. Nothing was sent to GitHub.',
    );
  }
  const usable = pairs.filter((r) => r.binding.active && r.connection.active);
  const first = usable[0];
  if (!first) {
    const dead = pairs[0];
    const which =
      dead && !dead.connection.active
        ? 'its GitHub App credential is switched off for every project sharing it'
        : 'the binding is switched off for this project';
    throw new GitHubAgentRefusal(
      'binding_disabled',
      `this project's GitHub binding exists but ${which} — re-enable it under Settings → Integrations. Nothing was sent to GitHub.`,
      dead?.binding.id ?? null,
    );
  }
  // cm:guard the grant is asked HERE and never inside `githubPairs` above: `list` reports what exists and must answer the same whichever way the grant reads, because an agent that cannot see its own project's binding cannot be told which binding a refusal is about (ISS-1074 criterion 13).
  if (!grantHolds(getIntegration('github'), first.binding)) {
    throw new GitHubAgentRefusal(
      'not_granted',
      notGrantedMessage('github', first.binding.id),
      first.binding.id,
    );
  }
  return first;
}

/**
 * GitHub's own sentence for a refusal — `message` out of its error body and nothing else.
 *
 * Never the raw body. `coolify/log-fetch.ts` carries the same guard and the same reason: a third
 * party's response body has carried tokens and internal hostnames, and an agent that is handed one
 * puts it in a comment. `message` is the field GitHub documents as the human-readable refusal, and
 * a body that is not JSON contributes nothing rather than being passed through as text.
 */
async function githubMessage(res: Response): Promise<string | null> {
  try {
    const parsed = (await res.json()) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message.slice(0, 500) : null;
  } catch {
    return null;
  }
}

/**
 * The client an agent's verb acts through, for a project whose binding is granted.
 *
 * The four config and credential refusals — no repository, no installation, no credential — are
 * `buildRepoClient`'s and are raised by calling it rather than restated: one wording per condition,
 * whichever door met it.
 */
export async function githubAgentClient(projectId: string): Promise<GitHubAgentClient> {
  const pair = await resolveGrantedGitHubBinding(projectId);
  const config = effectiveConfig<GitHubConfig>(pair);
  const secrets = decryptConnectionSecrets<GitHubSecrets>(pair.connection);
  // Raises `GitHubClientError` for no_repository / no_installation / no_credential, and gives the
  // agent face nothing else: its `get` is JSON-only and its binding was resolved another way.
  const validated = buildRepoClient({ bindingId: pair.binding.id, config, secrets });

  const base = (config.apiBaseUrl ?? GITHUB_API_BASE).replace(/\/+$/, '');
  const mint = () =>
    installationToken({
      appId: secrets.appId as string,
      privateKey: secrets.privateKey as string,
      installationId: config.installationId as number,
      ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
    });

  const token = async (): Promise<string> => {
    try {
      return await mint();
    } catch (err) {
      if (err instanceof GitHubAuthError) throw new GitHubAgentCallError(err.status, err.message);
      throw err;
    }
  };

  /**
   * Redact, with the credential this client uses added to the generic shapes.
   *
   * `using` is the token a caller already has in hand. Minting a second one instead would redact a
   * credential the text cannot contain: `installationToken` returns a FRESH token per call, so the
   * one a request was made with and the one a later mint answers are different strings, and the
   * scrubber would be handed the wrong one.
   */
  // cm:guard a mint failure must not lose the generic scrub: the token is ONE of the shapes, and returning unscrubbed text because the extra one could not be resolved is the worst of both outcomes.
  const scrubText = async (text: string, using?: string): Promise<string> => {
    if (using) return scrubLogText(text, [using]);
    let extra: string[] = [];
    try {
      extra = [await mint()];
    } catch {
      extra = [];
    }
    return scrubLogText(text, extra);
  };

  return {
    bindingId: validated.bindingId,
    owner: validated.owner,
    repo: validated.repo,
    fullName: validated.fullName,

    async json<T>(args: {
      method: 'GET' | 'POST' | 'PATCH';
      path: string;
      body?: unknown;
    }): Promise<T> {
      const res = await fetch(`${base}${args.path}`, {
        method: args.method,
        headers: {
          Authorization: `Bearer ${await token()}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(args.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new GitHubAgentCallError(
          res.status,
          `${args.method} ${args.path} on ${validated.fullName} returned HTTP ${res.status}`,
          await githubMessage(res),
        );
      }
      return (await res.json()) as T;
    },

    // cm:guard the redaction runs on EVERYTHING GitHub sent, before either the cap or a caller's own tail. Scrubbing what survives a slice would leave half a credential behind whenever one straddles the cut, and would have to be re-reasoned about every time a caller's trimming rule changed. `bytes` is the whole answer's length after redaction, which is the text this returns a piece of.
    // cm:guard the cap SLICES and reports the whole length, it does not ask GitHub for less. There is no range GitHub honours for a diff, so a caller told `bytes: 4_000_000, truncated: true` knows to ask for the files instead — where a returned length were reported, a truncated diff and a small one would read identically and an agent would reason about a change it has a twentieth of (ISS-1074 criterion 5).
    // cm:guard `keep` is the answer to which END survives the cap, and it has no default that suits both callers: a diff is read from the top, and a job log's failure is its last lines. Keeping the head of a log over the cap returns the tail of its BEGINNING — output from before the failure, under a `truncated` flag that says something was dropped but not that the end was.
    async text(args: {
      path: string;
      accept: string;
      maxBytes: number;
      keep?: 'head' | 'tail';
    }): Promise<{ body: string; bytes: number; truncated: boolean }> {
      const bearer = await token();
      const res = await fetch(`${base}${args.path}`, {
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: args.accept,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new GitHubAgentCallError(
          res.status,
          `GET ${args.path} on ${validated.fullName} returned HTTP ${res.status}`,
          await githubMessage(res),
        );
      }
      const redacted = await scrubText(await res.text(), bearer);
      const buf = Buffer.from(redacted, 'utf8');
      const bytes = buf.byteLength;
      if (bytes <= args.maxBytes) return { body: redacted, bytes, truncated: false };
      const kept =
        args.keep === 'tail' ? buf.subarray(bytes - args.maxBytes) : buf.subarray(0, args.maxBytes);
      return { body: kept.toString('utf8'), bytes, truncated: true };
    },

    scrub: (text: string) => scrubText(text),
  };
}

/** Whether a thrown value is one of the two refusals a caller words differently. */
export function isGitHubRefusal(err: unknown): err is GitHubAgentRefusal | GitHubClientError {
  return err instanceof GitHubAgentRefusal || err instanceof GitHubClientError;
}
