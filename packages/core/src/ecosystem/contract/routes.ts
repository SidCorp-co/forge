import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { assertProjectAccess } from '../../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { zValidator } from '../../middleware/zod-validator.js';
import { refused } from '../../project-config/respond.js';
import { slug } from '../../project-config/schema.js';
import { loadInterface } from '../interface-service.js';
import type { EcosystemRefusal } from '../refusals.js';
import { projectsWhere } from '../store.js';
import { MAX_ARTIFACT_BYTES } from './measure.js';
import { recordVersion } from './record.js';
import { measurementsOf, versionsOf } from './store.js';
import { type UploadBody, uploadRefusals } from './upload-rules.js';

export const contractRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/contracts/:contract/*']) {
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

const uploadSchema = z.strictObject({
  version: z.string().min(1).max(40).optional(),
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
        detail: `${i.message}; the body is { version?, artifact?: <the contract text>, semantic?: { classification, reason, elements } }`,
      })),
    );
  }
});

async function providerOf(id: string) {
  const [project] = await projectsWhere(db, { ids: [id] });
  if (!project) throw notFound(`project ${id} does not exist`);
  return project;
}

contractRoutes.get('/:id/contracts/:contract/versions', contractParam, async (c) => {
  const { id, contract } = c.req.valid('param');
  await assertProjectAccess(id, c.get('userId'), 'viewer');
  const versions = await versionsOf(db, [id], contract);
  return c.json({ versions: versions.map((v) => v.document) });
});

contractRoutes.get('/:id/contracts/:contract/versions/:version', versionParam, async (c) => {
  const { id, contract, version } = c.req.valid('param');
  await assertProjectAccess(id, c.get('userId'), 'viewer');
  const hit = (await versionsOf(db, [id], contract)).find((v) => v.version === version);
  if (!hit) throw notFound(`${contract} of project ${id} has no recorded version "${version}"`);
  return c.json({ version: hit.document, elements: hit.elements });
});

contractRoutes.get('/:id/contracts/:contract/measurements', contractParam, async (c) => {
  const { id, contract } = c.req.valid('param');
  await assertProjectAccess(id, c.get('userId'), 'viewer');
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

contractRoutes.post('/:id/contracts/:contract/versions', contractParam, uploadBody, async (c) => {
  const { id, contract } = c.req.valid('param');
  const userId = c.get('userId');
  await assertProjectAccess(id, userId, 'member');
  const body: UploadBody = c.req.valid('json');
  const [project, iface] = await Promise.all([providerOf(id), loadInterface(id)]);
  const latest = (await versionsOf(db, [id], contract))[0] ?? null;
  const refusals: EcosystemRefusal[] = uploadRefusals({
    project,
    contract,
    iface: iface?.document ?? null,
    body,
    latest,
  });
  const pub = iface?.document.publishes[contract];
  if (refusals.length > 0 || !pub || !iface) return refused(c, refusals);
  const out = await recordVersion({
    providerProjectId: id,
    contractRef: `${project.slug}/${contract}`,
    publication: pub,
    versioning: iface.document.commitments.versioning,
    artifact: body.artifact ? { text: body.artifact, origin: { uploadedBy: userId } } : null,
    ...(body.semantic
      ? {
          semantic: {
            ...body.semantic,
            classification: body.semantic.classification as 'breaking' | 'unknown',
          },
        }
      : {}),
    ...(body.version ? { requestedVersion: body.version } : {}),
  });
  if (out.outcome === 'refused') {
    const path = out.problem.code === 'SEMANTIC_WITHOUT_VERSION' ? '/semantic' : '/version';
    return refused(c, [{ code: out.problem.code, path, detail: out.problem.detail }]);
  }
  return c.json(
    { recorded: out.outcome === 'recorded', version: out.version },
    out.outcome === 'recorded' ? 201 : 200,
  );
});
