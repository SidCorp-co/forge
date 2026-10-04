import { scrubLogText } from '@forge/observability';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import {
  type BindingWithConnection,
  describeInboundDoor,
  effectiveConfig,
  getIntegration,
  grantHolds,
  healthWithInboundDoor,
  type InboundDoorState,
  inboundDoorState,
  inboundWebhookUrl,
  listBindingsForProject,
  readInboundDoorTraffic,
  resolveApiBaseUrl,
} from '../index.js';
import { SourceHostCallError } from '../source-host/index.js';
import { buildRepoClient } from './client.js';
import {
  GitHubAuthError,
  installationOctokit,
  mintInstallationToken,
  responseOf,
} from './octokit.js';
import type { GitHubConfig, GitHubSecrets } from './types.js';

const AGENT_TIMEOUT_MS = 12_000;

/** GitHub itself refused or failed. Carries the status so a caller can tell 404 from 403. */
export class GitHubAgentCallError extends SourceHostCallError {
  constructor(status: number, message: string, detail: string | null = null) {
    super(status, message, detail);
    this.name = 'GitHubAgentCallError';
  }
}

/** What `list` answers, and what a refusal is built from. Holds no credential. */
interface GitHubAgentBindingReport {
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

/** GitHub's own `message` on a refusal, where it sent one. */
function githubMessage(data: unknown): string | null {
  const message = (data as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message.slice(0, 500) : null;
}

/**
 * The client an agent's verb acts through, for a binding `source-host/resolve.ts` already resolved
 * and checked the grant of.
 *
 * The config and credential refusals — no repository, no installation, no credential — are
 * `buildRepoClient`'s and are raised by calling it rather than restated: one wording per condition,
 * whichever door met it.
 */
export function buildGitHubAgentClient(args: {
  bindingId: string;
  config: GitHubConfig;
  secrets: GitHubSecrets;
}): GitHubAgentClient {
  const { config, secrets } = args;
  const validated = buildRepoClient(args);

  const cred = {
    appId: secrets.appId as string,
    privateKey: secrets.privateKey as string,
    installationId: config.installationId as number,
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
  };
  const octokit = installationOctokit(cred);
  const mint = async () => (await mintInstallationToken(cred)).token;

  const token = async (): Promise<string> => {
    try {
      return await mint();
    } catch (err) {
      if (err instanceof GitHubAuthError) throw new GitHubAgentCallError(err.status, err.message);
      throw err;
    }
  };

  const refused = (err: unknown, what: string): never => {
    const answered = responseOf(err);
    if (!answered) throw err;
    throw new GitHubAgentCallError(
      answered.status,
      `${what} on ${validated.fullName} returned HTTP ${answered.status}`,
      githubMessage(answered.data),
    );
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
      await token();
      try {
        const res = await octokit.request({
          method: args.method,
          url: args.path,
          ...(args.body === undefined ? {} : { data: args.body }),
          request: {
            signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
            ...(args.method === 'GET' ? {} : { retries: 0 }),
          },
        });
        return res.data as T;
      } catch (err) {
        return refused(err, `${args.method} ${args.path}`);
      }
    },

    async text(args: {
      path: string;
      accept: string;
      maxBytes: number;
      keep?: 'head' | 'tail';
    }): Promise<{ body: string; bytes: number; truncated: boolean }> {
      const bearer = await token();
      let raw: string;
      try {
        const res = await octokit.request({
          method: 'GET',
          url: args.path,
          headers: { accept: args.accept },
          request: { signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) },
        });
        raw =
          res.data instanceof ArrayBuffer
            ? Buffer.from(res.data).toString('utf8')
            : typeof res.data === 'string'
              ? res.data
              : JSON.stringify(res.data);
      } catch (err) {
        return refused(err, `GET ${args.path}`);
      }
      const redacted = await scrubText(raw, bearer);
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
