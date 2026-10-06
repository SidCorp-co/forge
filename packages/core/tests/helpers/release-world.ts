import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, vi } from 'vitest';
import { insertComment } from '../../src/comments/service.js';
import { db } from '../../src/db/client.js';
import { registerAllIntegrations } from '../../src/integration-registry.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { issueDisplayIds } from '../../src/issues/display-ids.js';
import { type ProjectDocument, projectDocumentSchema } from '../../src/project-config/schema.js';
import type { CreateReleaseBatchResult } from '../../src/release-batch/create.js';
import { createTestDevice, rows, seedIssueStatus } from './factories.js';

export { registerAllIntegrations };

export const RELEASE_LABEL = 'release-box';
export const SKIP_NOTE = { section: 'Skip', userFacing: '-' };
/** Where a batch holds a claimed row: at the gate, at step `release`. */
export const AT_RELEASE = { status: 'awaiting_release', step: 'release' } as const;
export const PROBE_URL = 'https://release-fixture.example.test/version';

type Environments = ProjectDocument['environments'];
export type DeclaredProbes = 'source' | 'none' | 'artifact-only';

export interface StandingHold {
  code: string;
  reason: string;
  owes: string;
  waitingFor: string;
}

/** A project-v1 document parsed by the real schema, so a fixture it refuses fails at the seed. */
export async function seedProjectDocument(
  projectId: string,
  updatedBy: string,
  opts: {
    environments: Environments;
    promotions?: ProjectDocument['promotions'];
    defaultBranch?: string;
    source?: ProjectDocument['source'];
    extra?: Partial<ProjectDocument>;
  },
): Promise<ProjectDocument> {
  const defaultBranch = opts.defaultBranch ?? 'main';
  const promotions = opts.promotions ?? [];
  const branches = [...new Set([defaultBranch, ...promotions.flatMap((p) => [p.from, p.to])])];
  const document = projectDocumentSchema.parse({
    $schema: 'https://forge.sidcorp.co/schemas/project-v1.json',
    version: 1,
    project: { id: projectId, slug: `test-${projectId.slice(0, 8)}`, name: 'Test Project' },
    source: opts.source ?? {
      type: 'git',
      git: { repository: 'github.com/acme/test-project', defaultBranch, branches },
    },
    workspace: { isolation: 'worktree', setup: 'pnpm install' },
    validation: { gate: { type: 'github-check', name: 'ci-passed' } },
    environments: opts.environments,
    promotions,
    rollback: { strategy: 'revert-and-redeploy' },
    execution: {
      plugin: {
        source: 'SidCorp-co/forge-plugin',
        ref: '73225dedb41b5da26b4ce73518086e26e81f91b8',
      },
    },
    ...(opts.extra ?? {}),
  });
  await db.execute(sql`
    INSERT INTO project_config_documents (project_id, revision, document, updated_by)
    VALUES (${projectId}, 1, ${JSON.stringify(document)}::jsonb, ${updatedBy})
    ON CONFLICT (project_id) DO UPDATE SET document = EXCLUDED.document,
                                           revision = project_config_documents.revision + 1
  `);
  return document;
}

/** Production re-triggered in place where a document declares one, else bound to nothing held. */
export async function seedProductionDeployTrigger(
  projectId: string,
  updatedBy: string,
  trigger: 'on-land' | 'on-request' | 'provider' = 'on-land',
): Promise<void> {
  const [held] = await rows<{ document: ProjectDocument }>(
    sql`SELECT document FROM project_config_documents WHERE project_id = ${projectId}`,
  );
  const current = held?.document;
  const named = current
    ? Object.entries(current.environments).find(([, e]) => e.tier === 'production')
    : undefined;
  if (current && named) {
    const [name, env] = named;
    const deployment =
      'binding' in env.deployment ? { ...env.deployment, trigger } : env.deployment;
    await seedProjectDocument(projectId, updatedBy, {
      environments: { ...current.environments, [name]: { ...env, deployment } },
      promotions: current.promotions,
      source: current.source,
      ...(current.source.type === 'git' ? { defaultBranch: current.source.git.defaultBranch } : {}),
    });
    return;
  }
  await seedProjectDocument(projectId, updatedBy, {
    environments: {
      live: {
        tier: 'production',
        deploysFrom: 'main',
        deployment: { binding: randomUUID(), trigger },
      },
    },
  });
}

/** Answers each https probe url with `answer`, passing every other request through. */
export function stubProbe(answers: Record<string, () => Response | Promise<Response>>): void {
  const passThrough = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: URL | string | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const answer = answers[url.split('?')[0] ?? url];
    return answer === undefined ? passThrough(input, init) : answer();
  });
}

export interface CoolifyDeploymentRow {
  deployment_uuid: string;
  status: string;
  created_at: string;
  commit: string;
}

/** A Coolify answering an application's deployment list over HTTP, as `deployment-records.ts` reads it. */
export function fakeCoolify() {
  const applications = new Map<string, CoolifyDeploymentRow[] | number>();
  const LIST = '/api/v1/deployments/applications/';
  let server: Server | null = null;
  let base = '';
  beforeAll(async () => {
    const s = createServer((req, res) => {
      const path = String(req.url).split('?')[0] ?? '';
      const answer = path.startsWith(LIST)
        ? applications.get(decodeURIComponent(path.slice(LIST.length)))
        : undefined;
      if (typeof answer === 'number') {
        res.statusCode = answer;
        res.end('{"message":"no"}');
        return;
      }
      res.setHeader('content-type', 'application/json');
      const deployments = answer ?? [];
      res.end(JSON.stringify({ count: deployments.length, deployments }));
    });
    await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
    server = s;
    base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = null;
  });
  return {
    url: () => base,
    applications,
    deployed(application: string, uuid: string, commit: string, at: string, status = 'finished') {
      const listed = applications.get(application);
      const prior = Array.isArray(listed) ? listed : [];
      applications.set(application, [
        ...prior,
        { deployment_uuid: uuid, status, created_at: at, commit },
      ]);
    },
  };
}

/** A coolify connection and deploy binding; the binding id is returned. */
export async function seedDeployBinding(
  projectId: string,
  ownerId: string,
  config: Record<string, unknown> = {},
): Promise<string> {
  const connectionId = randomUUID();
  const bindingId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connectionId}, 'user', ${ownerId}, 'coolify', true)
  `);
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${bindingId}, ${connectionId}, ${projectId}, 'coolify', 'deploy', true,
            ${JSON.stringify({ releaseRunnerLabel: RELEASE_LABEL, ...config })}::jsonb)
  `);
  return bindingId;
}

const PROBES: Record<DeclaredProbes, object | undefined> = {
  source: { runtime: [{ type: 'http', url: PROBE_URL, path: 'commit', identifies: 'source' }] },
  none: undefined,
  'artifact-only': {
    runtime: [{ type: 'http', url: PROBE_URL, path: 'commit', identifies: 'artifact' }],
  },
};

/** Seeding a release case needs before it asserts anything, against one project and its owner. */
export function releaseWorld(ids: () => { projectId: string; ownerId: string }) {
  let seq = 0;
  let served = 'commit-before-any-release';
  let stubbed = false;

  function answerTheProbe(): void {
    if (stubbed) return;
    stubbed = true;
    stubProbe({ [PROBE_URL]: () => Response.json({ commit: served }) });
  }

  afterAll(() => {
    if (stubbed) vi.unstubAllGlobals();
    stubbed = false;
  });

  async function declareProduction(
    config: Record<string, unknown> = {},
    probes: DeclaredProbes = 'source',
  ): Promise<string> {
    const { projectId, ownerId } = ids();
    const bindingId = await seedDeployBinding(projectId, ownerId, config);
    const verification = PROBES[probes];
    await seedProjectDocument(projectId, ownerId, {
      defaultBranch: 'main',
      promotions: [{ from: 'main', to: 'production', via: 'merge' }],
      environments: {
        live: {
          tier: 'production',
          deploysFrom: 'production',
          deployment: { binding: bindingId, trigger: 'on-request' },
          ...(verification ? { verification } : {}),
        } as Environments[string],
      },
    });
    if (probes !== 'none') answerTheProbe();
    return bindingId;
  }

  async function seedReleaseRunner(): Promise<string> {
    const { projectId, ownerId } = ids();
    const device = await createTestDevice(ownerId);
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (${id}, ${projectId}, 'claude-code', ${device}, 'release-runner', 'online', now(),
              ${JSON.stringify([RELEASE_LABEL])}::jsonb)
    `);
    return id;
  }

  /** A row at `status`; given `criteria`, written through the criteria store before it reaches it. */
  async function insertIssue(
    status = 'awaiting_release',
    note: unknown = SKIP_NOTE,
    merged = true,
    criteria?: readonly string[],
  ): Promise<string> {
    const { projectId, ownerId } = ids();
    const id = randomUUID();
    seq += 1;
    const first = criteria ? 'in_progress' : status;
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes, merged_at)
      VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${first}, ${ownerId},
              ${note === null ? null : JSON.stringify(note)}::jsonb, ${merged ? sql`now()` : null})
    `);
    if (criteria) {
      await replaceCriteria(
        id,
        criteria.map((statement, i) => ({ n: i + 1, statement })),
      );
      if (status !== first) await seedIssueStatus(id, status);
    }
    return id;
  }

  async function stored(id: string) {
    const [row] = await rows<{
      status: string;
      merged_at: unknown;
      release_batch_run_id: string | null;
      step: string | null;
    }>(sql`
      SELECT i.status, i.merged_at, i.release_batch_run_id, w.step
        FROM issues i LEFT JOIN issue_work_state w ON w.issue_id = i.id WHERE i.id = ${id}
    `);
    return {
      status: String(row?.status),
      step: row?.step ?? null,
      mergedAt: row?.merged_at ?? null,
      claim: row?.release_batch_run_id ?? null,
    };
  }

  async function claim(
    idList: string[],
    opts: { deploy?: boolean } = {},
  ): Promise<CreateReleaseBatchResult> {
    const { projectId, ownerId } = ids();
    const { createReleaseBatch } = await import('../../src/release-batch/create.js');
    const result = await createReleaseBatch({ projectId, issueIds: idList, userId: ownerId });
    if (opts.deploy !== false) served = `commit-pushed-by-run-${result.runId}`;
    await announceMethod(result.runId);
    return result;
  }

  async function announceMethod(
    runId: string,
    over: { skill?: string; loaded?: boolean } = {},
  ): Promise<void> {
    const [{ announceMethod: announce }, { RELEASE_BATCH_SKILL }] = await Promise.all([
      import('../../src/release-batch/method.js'),
      import('../../src/release-batch/plan.js'),
    ]);
    await announce({
      runId,
      skill: over.skill ?? RELEASE_BATCH_SKILL,
      loaded: over.loaded ?? true,
    });
  }

  async function displayIds(idList: string[]): Promise<string[]> {
    const shown = await issueDisplayIds(idList);
    return idList.map((id) => String(shown.get(id)));
  }

  /** A comment through `comments/service.ts:insertComment`, so a record in it is mirrored as written. */
  async function postComment(issueId: string, body: string): Promise<void> {
    const { ownerId } = ids();
    await insertComment({ issueId, authorId: ownerId, authorDeviceId: null, body, parentId: null });
  }

  /** The evidence attachment a verdict cites, then the verdict comment that cites it. */
  async function postVerdict(issueId: string, body: string, evidence = 'judge-evidence.txt') {
    const { ownerId } = ids();
    await db.execute(sql`
      INSERT INTO issue_attachments (id, issue_id, uploader_id, name, path, mime, size)
      SELECT ${randomUUID()}, ${issueId}, ${ownerId}, ${evidence}, ${`uploads/${issueId}`},
             'text/plain', 64
       WHERE NOT EXISTS (SELECT 1 FROM issue_attachments WHERE issue_id = ${issueId} AND name = ${evidence})
    `);
    await postComment(issueId, body);
  }

  /** A waiting row merged at `mergedAt` whose two criteria passed at `commit`. */
  async function judgedRow(commit: string, mergedAt: string): Promise<string> {
    const id = await insertIssue('awaiting_release', SKIP_NOTE, true, ['ok', 'ok too']);
    await db.execute(sql`
      UPDATE issues SET merged_at = ${mergedAt}::timestamptz, merged_commit_sha = ${commit}
       WHERE id = ${id}
    `);
    const block = (n: number) =>
      [`criterion: ${n}`, 'verdict: pass', `commit: ${commit}`, 'evidence: judge.txt'].join('\n');
    await postVerdict(id, verdictComment([block(1), block(2)]), 'judge.txt');
    return id;
  }

  /** The standing hold on the row, or null where none stands. */
  async function holdOf(issueId: string): Promise<StandingHold | null> {
    const [row] = await rows<StandingHold>(sql`
      SELECT code, reason, owes, waiting_for AS "waitingFor" FROM release_holds
       WHERE issue_id = ${issueId} AND cleared_at IS NULL
    `);
    return row ?? null;
  }

  /** Every hold ever written on the row, oldest first: the reasons it was held for, in order. */
  async function holdHistory(issueId: string): Promise<string[]> {
    const found = await rows<{ reason: string }>(sql`
      SELECT reason FROM release_holds WHERE issue_id = ${issueId} ORDER BY held_at ASC, id ASC
    `);
    return found.map((r) => r.reason);
  }

  return {
    declareProduction,
    serving: () => served,
    serve: (commit: string) => {
      served = commit;
    },
    announceMethod,
    seedReleaseRunner,
    insertIssue,
    stored,
    claim,
    displayIds,
    postComment,
    postVerdict,
    judgedRow,
    holdOf,
    holdHistory,
  };
}

/** A `forge-record` verdict comment holding `blocks`. */
export function verdictComment(blocks: string[], heading = '## Judged'): string {
  return [
    heading,
    '',
    '```forge-record',
    ...blocks,
    '```',
    '',
    '`forge-record: verdict · contract 1`',
  ].join('\n');
}

/** Runs `act` on a clock that gains a minute per read, so a 300 s probe window ends in a few reads. */
export async function pastTheProbeWindow<T>(act: () => T | Promise<T>): Promise<T> {
  const realNow = Date.now.bind(Date);
  let reads = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
    reads += 1;
    return realNow() + 60_000 * reads;
  });
  try {
    return await act();
  } finally {
    clock.mockRestore();
  }
}

export const PRODUCTION_PROBE = 'https://production.example.test/version';

export interface SeedProduction {
  projectId: string;
  ownerId: string;
  provider?: string;
  config?: Record<string, unknown>;
  connectionConfig?: Record<string, unknown>;
  secretsEnc?: string | null;
  label?: string;
  probes?: DeclaredProbes;
  probeUrl?: string;
  probePath?: string;
  trigger?: 'on-land' | 'on-request' | 'provider';
  deploysFrom?: string;
  name?: string;
  others?: Environments;
}

/** A connection, a deploy binding, and the project document naming it as production. */
export async function seedProduction(
  opts: SeedProduction,
): Promise<{ bindingId: string; connectionId: string }> {
  const provider = opts.provider ?? 'coolify';
  const connectionId = randomUUID();
  const bindingId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, config, secrets_enc, active)
    VALUES (${connectionId}, 'user', ${opts.ownerId}, ${provider},
            ${JSON.stringify(opts.connectionConfig ?? {})}::jsonb, ${opts.secretsEnc ?? null}, true)
  `);
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, label, active, config)
    VALUES (${bindingId}, ${connectionId}, ${opts.projectId}, ${provider}, 'deploy',
            ${opts.label ?? ''}, true, ${JSON.stringify(opts.config ?? {})}::jsonb)
  `);
  await declareProductionDocument({ ...opts, bindingId });
  return { bindingId, connectionId };
}

/** The project document alone: production deploys through `bindingId`. */
export async function declareProductionDocument(
  opts: Omit<
    SeedProduction,
    'provider' | 'config' | 'connectionConfig' | 'secretsEnc' | 'label'
  > & {
    bindingId: string;
  },
): Promise<void> {
  const deploysFrom = opts.deploysFrom ?? 'main';
  const probes = opts.probes ?? 'source';
  const verification =
    probes === 'none'
      ? {}
      : {
          verification: {
            runtime: [
              {
                type: 'http' as const,
                url: opts.probeUrl ?? PRODUCTION_PROBE,
                path: opts.probePath ?? 'commit',
                identifies: probes === 'source' ? ('source' as const) : ('artifact' as const),
              },
            ],
          },
        };
  await seedProjectDocument(opts.projectId, opts.ownerId, {
    defaultBranch: 'main',
    promotions: deploysFrom === 'main' ? [] : [{ from: 'main', to: deploysFrom, via: 'merge' }],
    environments: {
      ...(opts.others ?? {}),
      [opts.name ?? 'live']: {
        tier: 'production',
        deploysFrom,
        deployment: { binding: opts.bindingId, trigger: opts.trigger ?? 'on-request' },
        ...verification,
      } as Environments[string],
    },
  });
}
