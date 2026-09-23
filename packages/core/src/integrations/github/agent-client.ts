import { scrubLogText } from '@forge/observability';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import { grantHolds, notGrantedMessage } from '../agent-access.js';
import {
  describeInboundDoor,
  healthWithInboundDoor,
  type InboundDoorState,
  inboundDoorState,
  readInboundDoorTraffic,
} from '../inbound-door.js';
import { getIntegration } from '../registry.js';
import {
  type BindingWithConnection,
  decryptConnectionSecrets,
  effectiveConfig,
  listBindingsForProject,
} from '../store.js';
import { GitHubAuthError, installationToken } from './app-auth.js';
import { buildRepoClient, GitHubClientError } from './client.js';
import { inboundWebhookUrl, resolveApiBaseUrl } from './connect.js';
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
  /** BOTH directions; until ISS-1140 the outbound probe alone, so a binding addressed at the wrong host read `ok`. `connectionProbeStatus` is what the probe STORED: repository fetch and App webhook read together, since a failed hook read demotes that too. */
  lastHealthStatus: string | null;
  connectionProbeStatus: string | null;
  /** The sentence the last probe produced, or null where it recorded none. */
  healthDetail: string | null;
  inboundDoor: InboundDoorState;
  /** What the door reading knows, and what it says it cannot know. */
  inboundReading: string | null;
  /** What this binding needs GitHub to call, and what GitHub last answered that it holds. */
  expectedWebhookUrl: string | null;
  observedWebhookUrl: string | null;
  /** Deliveries that came THROUGH — a binding can be green everywhere and have received nothing (ISS-1123); a turn-away is counted below, never here. */
  inboundDeliveries: number;
  lastInboundDeliveryAt: string | null;
  /** Turned away: unauthenticated, so attributed to nobody, and RECORDS — one per code per ten minutes — so a floor on the calls, never the calls. */
  turnedAwayRecords: number;
  lastRecordedTurnAwayAt: string | null;
  lastTurnedAwayCode: string | null;
}

export interface GitHubAgentClient {
  bindingId: string;
  owner: string;
  repo: string;
  /** `owner/repo`, as the binding spells it. */
  fullName: string;
  /** A JSON request as the installation: the reads and every write the agent face makes. */
  json<T>(args: { method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown }): Promise<T>;
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

/** The one read Forge cannot make for itself, named rather than the half it does not know. */
const GITHUB_DELIVERY_LOG =
  "the App's own Recent Deliveries tab on github.com, under Settings, Developer settings, GitHub Apps, this App, Advanced";

/**
 * Contacts GitHub NOT AT ALL, which is what makes this the place to find out why another action
 * was refused. The probe stored where GitHub says it is addressed; the comparison happens per
 * binding, because that URL carries a project slug and a connection may serve several.
 */
export async function githubAgentBindings(projectId: string): Promise<GitHubAgentBindingReport[]> {
  const decl = getIntegration('github');
  const pairs = await githubPairs(projectId);
  if (pairs.length === 0) return [];

  const [project] = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const apiBase = resolveApiBaseUrl();
  const expectedUrl = apiBase && project?.slug ? inboundWebhookUrl(apiBase, project.slug) : null;
  const inboundUnprompted = decl?.capabilities.inboundUnprompted ?? false;

  return Promise.all(
    pairs.map(async (pair) => {
      const config = effectiveConfig<GitHubConfig>(pair);
      const traffic = await readInboundDoorTraffic(pair.binding.id);
      const observed = pair.connection.inboundEndpointObserved ?? null;
      const state = inboundDoorState({ inboundUnprompted, expectedUrl, observed, traffic });
      const stored = pair.connection.lastHealthStatus ?? null;
      return {
        bindingId: pair.binding.id,
        repository: config.owner && config.repo ? `${config.owner}/${config.repo}` : null,
        installed: typeof config.installationId === 'number',
        bindingActive: pair.binding.active,
        connectionActive: pair.connection.active,
        agentGranted: grantHolds(decl, pair.binding),
        lastHealthStatus: healthWithInboundDoor(stored, state),
        connectionProbeStatus: stored,
        healthDetail: pair.connection.lastHealthDetail ?? null,
        inboundDoor: state,
        inboundReading: describeInboundDoor({
          state,
          traffic,
          expectedUrl,
          observed,
          providerDeliveryLog: GITHUB_DELIVERY_LOG,
        }),
        expectedWebhookUrl: expectedUrl,
        observedWebhookUrl: observed?.url ?? null,
        inboundDeliveries: traffic.accepted,
        lastInboundDeliveryAt: traffic.lastAcceptedAt?.toISOString() ?? null,
        turnedAwayRecords: traffic.refusalRecords,
        lastRecordedTurnAwayAt: traffic.lastRecordedRefusalAt?.toISOString() ?? null,
        lastTurnedAwayCode: traffic.lastRefusalCode,
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
  if (!grantHolds(getIntegration('github'), first.binding)) {
    throw new GitHubAgentRefusal(
      'not_granted',
      notGrantedMessage('github', first.binding.id),
      first.binding.id,
    );
  }
  return first;
}

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
