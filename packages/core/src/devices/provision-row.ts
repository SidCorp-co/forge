/**
 * One queued runner row, turned into the provision the box clones from — or
 * into the report that says why it could not be. Nothing here throws for
 * anything it can attribute to a row, so one project's fault costs that project
 * and not every other one the device is waiting on (ISS-1184).
 */

import { decryptSecret } from '../integrations/vault.js';

const REASON_MAX = 200;

export const PROVISION_FAILURES_HEADER = 'X-Forge-Provision-Failures';

/**
 * Bounded because the count of queued rows is not. What does not fit is counted
 * in `dropped` and is on the row's own `provisionDetail` either way.
 */
export const PROVISION_FAILURES_BUDGET = 4096;

/** `omitted` — absent from the response. `degraded` — served, short something. */
export type ProvisionReportKind = 'omitted' | 'degraded';

export interface ProvisionReport {
  runnerId: string;
  projectId: string;
  slug: string;
  kind: ProvisionReportKind;
  reason: string;
  /** The cause reproduced on a second build, so the row leaves the queue. */
  terminal: boolean;
}

export interface ProvisionRow {
  runnerId: string;
  projectId: string;
  slug: string;
  repoPath: string | null;
  branch: string | null;
  repoUrl: string | null;
  baseBranch: string | null;
  sshSource: string | null;
  sshPublicKey: string | null;
  sshPrivateKeyEnc: Buffer | null;
}

export interface Provision {
  runnerId: string;
  projectId: string;
  slug: string;
  repoPath: string | null;
  branch: string | null;
  repoUrl: string | null;
  sshKeySource: string | null;
  sshPublicKey: string | null;
  sshPrivateKey: string | null;
  githubAppCredential: boolean;
  mcpCredential: string | null;
}

export interface BuiltProvisionRow {
  provision: Provision | null;
  reports: ProvisionReport[];
}

export interface ProvisionRowDeps {
  /** Injected so a test can make one row's mint throw. */
  issueCredential(args: {
    deviceId: string;
    projectId: string;
    holderUserId: string;
  }): Promise<string>;
  decrypt?(enc: Buffer): string;
}

export interface ProvisionRowContext {
  deviceId: string;
  /** Null when the device has no live credential; no token is minted then. */
  holderUserId: string | null;
  githubAppCredential: boolean;
}

/**
 * SQLSTATE class 23: the data itself refusing, which is the only cause this code
 * can tell from a blip — a timeout says nothing about the next poll, and burning
 * a row on one costs a re-bind. Walked, because drizzle wraps what pg threw.
 */
export function integrityViolation(err: unknown): string | null {
  for (let cur: unknown = err, depth = 0; cur && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('23')) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** The innermost message: drizzle's outer one is the whole failed statement. */
function messageOf(err: unknown): string {
  let deepest: string | null = null;
  for (let cur: unknown = err, depth = 0; cur && depth < 5; depth++) {
    const message = (cur as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) deepest = message;
    cur = (cur as { cause?: unknown }).cause;
  }
  return deepest ?? String(err);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

interface MintFailure {
  err: unknown;
  /** The first attempt failed with this SQLSTATE and so did the second. */
  reproduced: boolean;
}

/**
 * Mint, and on an integrity violation mint once more.
 * `issueWorkspaceCredential` serialises callers for one token name, so the
 * second attempt runs after whatever held it has finished. Only the SAME
 * SQLSTATE twice is a reproduction: a 23505 followed by a 23503 is two
 * different faults, and calling that permanent would burn a row on a race.
 */
async function mintWithOneRetry(
  deps: ProvisionRowDeps,
  args: { deviceId: string; projectId: string; holderUserId: string },
): Promise<{ token: string } | MintFailure> {
  try {
    return { token: await deps.issueCredential(args) };
  } catch (first) {
    const code = integrityViolation(first);
    if (code === null) return { err: first, reproduced: false };
    try {
      return { token: await deps.issueCredential(args) };
    } catch (second) {
      return { err: second, reproduced: integrityViolation(second) === code };
    }
  }
}

/** Build one row. Throws for nothing that belongs to the row. */
export async function buildProvisionRow(
  row: ProvisionRow,
  ctx: ProvisionRowContext,
  deps: ProvisionRowDeps,
): Promise<BuiltProvisionRow> {
  const reports: ProvisionReport[] = [];
  const against = (kind: ProvisionReportKind, reason: string, terminal: boolean) => ({
    runnerId: row.runnerId,
    projectId: row.projectId,
    slug: row.slug,
    kind,
    reason: truncate(reason, REASON_MAX),
    terminal,
  });

  let sshPrivateKey: string | null = null;
  if (row.sshPrivateKeyEnc) {
    const decrypt = deps.decrypt ?? decryptSecret;
    try {
      sshPrivateKey = decrypt(row.sshPrivateKeyEnc);
    } catch (err) {
      // Still served without the key — a project may clone over HTTPS or be set
      // up by hand. The drop is reported rather than swallowed, because an
      // undecryptable key and no key at all read alike otherwise (ISS-1184).
      sshPrivateKey = null;
      reports.push(
        against(
          'degraded',
          `the stored workspace ssh key could not be decrypted, so the provision is served without it: ${messageOf(err)}`,
          false,
        ),
      );
    }
  }

  let mcpCredential: string | null = null;
  if (ctx.holderUserId) {
    const minted = await mintWithOneRetry(deps, {
      deviceId: ctx.deviceId,
      projectId: row.projectId,
      holderUserId: ctx.holderUserId,
    });
    if (!('token' in minted)) {
      return {
        provision: null,
        reports: [
          ...reports,
          against(
            'omitted',
            `the workspace credential for this checkout could not be minted: ${messageOf(minted.err)}`,
            minted.reproduced,
          ),
        ],
      };
    }
    mcpCredential = minted.token;
  }

  return {
    provision: {
      runnerId: row.runnerId,
      projectId: row.projectId,
      slug: row.slug,
      repoPath: row.repoPath,
      branch: row.branch ?? row.baseBranch,
      repoUrl: row.repoUrl,
      sshKeySource: sshPrivateKey ? row.sshSource : null,
      sshPublicKey: sshPrivateKey ? row.sshPublicKey : null,
      sshPrivateKey,
      githubAppCredential: ctx.githubAppCredential,
      mcpCredential,
    },
    reports,
  };
}

/** Printable ASCII: a header value that is not is refused by the runtime. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * The reports as one header value, inside the budget: entries from the front
 * while they fit, `dropped` for the rest. Null when there is nothing to report.
 */
export function provisionFailuresHeader(reports: readonly ProvisionReport[]): string | null {
  if (reports.length === 0) return null;
  const entries = reports.map((r) => ({
    slug: r.slug,
    projectId: r.projectId,
    runnerId: r.runnerId,
    kind: r.kind,
    reason: r.reason,
  }));
  for (let take = entries.length; take > 0; take--) {
    const body = asciiJson({ failures: entries.slice(0, take), dropped: entries.length - take });
    if (body.length <= PROVISION_FAILURES_BUDGET) return body;
  }
  return asciiJson({ failures: [], dropped: entries.length });
}
