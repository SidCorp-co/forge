import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
  restActor,
} from '../../middleware/auth.js';
import { zValidator } from '../../middleware/zod-validator.js';
import { refused } from '../../project-config/respond.js';
import { slug } from '../../project-config/schema.js';
import { CONTRACT_DECISION_REASON_MAX, CONTRACT_DECISIONS } from './approval.js';
import { decideContractVersion } from './decide.js';
import { MAX_ARTIFACT_BYTES } from './measure.js';
import { consumedContract, consumedMeasurements, consumedVersions } from './party-read.js';
import { publishContractVersion } from './publish.js';
import { approvalView, currentOf, measurementsOf, readArtifact, versionsOf } from './store.js';
import { SOURCE_REF } from './version-schema.js';
import { requireCan } from '../../permissions/index.js';

export const contractRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/contracts/:contract/*', '/:id/consumes/:provider/:contract/*']) {
  contractRoutes.use(path, requireAuth(), assertEmailVerified());
}

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const contractParam = zValidator('param', z.object({ id: z.uuid(), contract: slug() }), (r) => {
  if (!r.success) {
    throw new HTTPException(400, {
      message: 'invalid path: the project id is a uuid and the contract is its publication slug',
      cause: { code: 'BAD_REQUEST' },
    });
  }
});

const versionParam = zValidator(
  'param',
  z.object({ id: z.uuid(), contract: slug(), version: z.string().min(1).max(40) }),
  (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message:
          'invalid path: /api/projects/<uuid>/contracts/<slug>/versions/<version of 1 to 40 characters>',
        cause: { code: 'BAD_REQUEST' },
      });
    }
  },
);

const consumedParam = zValidator(
  'param',
  z.object({ id: z.uuid(), provider: z.uuid(), contract: slug() }),
  (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message:
          'invalid path: /api/projects/<consumer uuid>/consumes/<provider uuid>/<contract slug>/…',
        cause: { code: 'BAD_REQUEST' },
      });
    }
  },
);

const uploadSchema = z.strictObject({
  version: z.string().min(1).max(40).optional(),
  kind: z.string().min(1).max(40).optional(),
  sourceRef: z.string().regex(SOURCE_REF).optional(),
  artifact: z.string().min(1).max(MAX_ARTIFACT_BYTES).optional(),
  semantic: z
    .strictObject({
      classification: z.enum(['breaking', 'non-breaking', 'unknown']),
      reason: z.string().trim().min(1).max(1000),
      elements: z.array(z.string().min(1).max(200)).min(1).max(50),
    })
    .optional(),
});

const uploadBody = zValidator('json', uploadSchema, (r, c) => {
  if (!r.success) {
    return refused(
      c,
      r.error.issues.map((i) => ({
        code: 'SCHEMA_VIOLATION' as const,
        path: `/${i.path.map(String).join('/')}`,
        detail: `${i.message}; the body is { version?, kind?, artifact?: <the contract text>, sourceRef?: <repo path>@<commit sha>, semantic?: { classification, reason, elements } }`,
      })),
    );
  }
});

contractRoutes.get('/:id/contracts/:contract/versions', contractParam, async (c) => {
  const { id, contract } = c.req.valid('param');
  await requireCan({ userId: c.get('userId') }, 'project.read', id);
  const versions = await versionsOf(db, [id], contract);
  return c.json({
    versions: versions.map((v) => v.document),
    current: currentOf(versions)?.version ?? null,
    approvals: Object.fromEntries(versions.map((v) => [v.version, approvalView(v)])),
  });
});

contractRoutes.get('/:id/contracts/:contract/versions/:version', versionParam, async (c) => {
  const { id, contract, version } = c.req.valid('param');
  await requireCan({ userId: c.get('userId') }, 'project.read', id);
  const versions = await versionsOf(db, [id], contract);
  const hit = versions.find((v) => v.version === version);
  if (!hit) throw notFound(`${contract} of project ${id} has no recorded version "${version}"`);
  return c.json({
    version: hit.document,
    elements: hit.elements,
    approval: approvalView(hit),
    current: currentOf(versions)?.version ?? null,
  });
});

const ARTIFACT_MEDIA: Record<string, string> = {
  openapi: 'application/json',
  'json-schema': 'application/json',
  'mcp-tools': 'application/json',
  graphql: 'text/plain; charset=utf-8',
};

// cm:why a mock is generated where it is used, from the stored bytes of one version, never stored itself (data-model review: mocks are a function of the artifact's sha256): this hands a mock server (Prism for OpenAPI, graphql-tools for SDL) exactly those bytes, and says whether the version is current
contractRoutes.get(
  '/:id/contracts/:contract/versions/:version/artifact',
  versionParam,
  async (c) => {
    const { id, contract, version } = c.req.valid('param');
    await requireCan({ userId: c.get('userId') }, 'project.read', id);
    const hit = (await versionsOf(db, [id], contract)).find((v) => v.version === version);
    if (!hit) throw notFound(`${contract} of project ${id} has no recorded version "${version}"`);
    const text = hit.artifactSha256 ? await readArtifact(db, hit.artifactSha256) : null;
    const media = ARTIFACT_MEDIA[hit.contractType];
    if (text === null || !media) {
      return refused(c, [
        {
          code: 'CONTRACT_ARTIFACT_NOT_MOCKABLE',
          path: '/',
          detail: `${hit.document.contract}@${version} is ${hit.contractType}${text === null ? ' and holds no stored artifact' : ''}; a mock is generated from the stored artifact of an openapi, json-schema, mcp-tools or graphql version.`,
        },
      ]);
    }
    c.header('Content-Type', media);
    c.header('X-Forge-Contract-Approval', hit.approval);
    c.header('X-Forge-Contract-Sha256', hit.artifactSha256 ?? '');
    return c.body(text);
  },
);

const decisionBody = zValidator(
  'json',
  z.strictObject({
    decision: z.enum(CONTRACT_DECISIONS),
    reason: z.string().trim().max(CONTRACT_DECISION_REASON_MAX).optional(),
  }),
  (r, c) => {
    if (!r.success) {
      return refused(
        c,
        r.error.issues.map((i) => ({
          code: 'SCHEMA_VIOLATION' as const,
          path: `/${i.path.map(String).join('/')}`,
          detail: `${i.message}; the body is { decision: approve | return, reason?: why, required to return }`,
        })),
      );
    }
  },
);

contractRoutes.post(
  '/:id/contracts/:contract/versions/:version/decision',
  versionParam,
  decisionBody,
  async (c) => {
    const { id, contract, version } = c.req.valid('param');
    const { decision, reason } = c.req.valid('json');
    const actor = restActor(c);
    const out = await decideContractVersion({
      projectId: id,
      contract,
      version,
      decision,
      reason: reason ?? null,
      actor: { userId: actor.id, agency: actor.agency },
    });
    if (!out.ok) return refused(c, out.refusals);
    return c.json({
      version: out.version.document,
      approval: approvalView(out.version),
      settledWaits: out.settled.length,
      filedFeedback: out.filed.length,
    });
  },
);

contractRoutes.get('/:id/contracts/:contract/measurements', contractParam, async (c) => {
  const { id, contract } = c.req.valid('param');
  await requireCan({ userId: c.get('userId') }, 'project.read', id);
  const rows = await measurementsOf(id, contract, 100);
  return c.json({
    measurements: rows.map((r) => ({
      commit: r.commitSha,
      branch: r.branch,
      environments: r.environments,
      outcome: r.outcome,
      version: r.version,
      reason: r.reason,
      observedAt: r.observedAt.toISOString(),
      settledAt: r.settledAt?.toISOString() ?? null,
    })),
  });
});

contractRoutes.get('/:id/consumes/:provider/:contract/versions', consumedParam, async (c) => {
  const { id, provider, contract } = c.req.valid('param');
  const party = await consumedContract({
    userId: c.get('userId'),
    consumerId: id,
    providerId: provider,
    contract,
  });
  return c.json({
    provider: party.provider,
    contract: `${party.provider.slug}/${contract}`,
    ecosystems: party.ecosystems,
    versions: await consumedVersions(provider, contract),
  });
});

contractRoutes.get('/:id/consumes/:provider/:contract/measurements', consumedParam, async (c) => {
  const { id, provider, contract } = c.req.valid('param');
  await consumedContract({
    userId: c.get('userId'),
    consumerId: id,
    providerId: provider,
    contract,
  });
  return c.json({ measurements: await consumedMeasurements(provider, contract) });
});

contractRoutes.post('/:id/contracts/:contract/versions', contractParam, uploadBody, async (c) => {
  const { id, contract } = c.req.valid('param');
  const actor = restActor(c);
  const out = await publishContractVersion({
    projectId: id,
    contract,
    writer: { userId: actor.id, agency: actor.agency },
    ...c.req.valid('json'),
  });
  if (!out.ok) return refused(c, out.refusals);
  return c.json({ recorded: out.recorded, version: out.version }, out.recorded ? 201 : 200);
});
