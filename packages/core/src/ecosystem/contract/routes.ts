import { REASON_NOTE_MAX } from '@forge/contracts/comments';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { refused } from '../../lib/refusal.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
  restActor,
} from '../../middleware/auth.js';
import { notFound } from '../../middleware/route-errors.js';
import { invalid, zValidator } from '../../middleware/zod-validator.js';
import { slug } from '../../project-config/index.js';
import { CONTRACT_DECISION_REASON_MAX, CONTRACT_DECISIONS } from './approval.js';
import { decideContractVersion, decidedView } from './decide.js';
import { MAX_ARTIFACT_BYTES } from './measure.js';
import {
  type ContractReader,
  consumedContract,
  consumedVersions,
  contractReader,
  versionForParty,
  versionsFor,
} from './party-read.js';
import { publishContractVersion } from './publish.js';
import { approvalView, currentOf, readArtifact, versionsOf } from './store.js';
import { SOURCE_REF } from './version-schema.js';

export const contractRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/contracts/:contract/*', '/:id/consumes/:provider/:contract/*']) {
  contractRoutes.use(path, requireAuth(), assertEmailVerified());
}
const contractParam = zValidator(
  'param',
  z.object({ id: z.uuid(), contract: slug() }),
  invalid('invalid path: the project id is a uuid and the contract is its publication slug'),
);

const versionParam = zValidator(
  'param',
  z.object({ id: z.uuid(), contract: slug(), version: z.string().min(1).max(40) }),
  invalid(
    'invalid path: /api/projects/<uuid>/contracts/<slug>/versions/<version of 1 to 40 characters>',
  ),
);

const consumedParam = zValidator(
  'param',
  z.object({ id: z.uuid(), provider: z.uuid(), contract: slug() }),
  invalid('invalid path: /api/projects/<consumer uuid>/consumes/<provider uuid>/<contract slug>/…'),
);

const uploadSchema = z.strictObject({
  version: z.string().min(1).max(40).optional(),
  kind: z.string().min(1).max(40).optional(),
  sourceRef: z.string().regex(SOURCE_REF).optional(),
  artifact: z.string().min(1).max(MAX_ARTIFACT_BYTES).optional(),
  semantic: z
    .strictObject({
      classification: z.enum(['breaking', 'non-breaking', 'unknown']),
      reason: z.string().trim().min(1).max(REASON_NOTE_MAX),
      elements: z.array(z.string().min(1).max(200)).min(1).max(50),
    })
    .optional(),
});

const uploadBody = zValidator(
  'json',
  uploadSchema,
  invalid(
    'the body is { version?, kind?, artifact?: <the contract text>, sourceRef?: <repo path>@<commit sha>, semantic?: { classification, reason, elements } }',
    'SCHEMA_VIOLATION',
  ),
);

// a party is shown the published diff of an approved version, never the commit, the person that decided it, or a version the provider has not approved
async function versionsShown(userId: string, id: string, contract: string) {
  const reader = await contractReader(userId, id, contract);
  return { reader, versions: versionsFor(reader, await versionsOf(db, [id], contract)) };
}

const unrecorded = (reader: ContractReader, contract: string, id: string, version: string) =>
  notFound(
    `${contract} of project ${id} has no ${reader.access === 'party' ? 'approved' : 'recorded'} version "${version}"`,
  );

contractRoutes.get('/:id/contracts/:contract/versions', contractParam, async (c) => {
  const { id, contract } = c.req.valid('param');
  const { reader, versions } = await versionsShown(c.get('userId'), id, contract);
  const current = currentOf(versions)?.version ?? null;
  if (reader.access === 'party') {
    return c.json({ reader, versions: versions.map(versionForParty), current });
  }
  // each row carries its own decision: a sibling map keyed by version read as no decision at all to
  // a reader walking the rows
  return c.json({
    versions: versions.map((v) => ({ ...v.document, approval: approvalView(v) })),
    current,
  });
});

contractRoutes.get('/:id/contracts/:contract/versions/:version', versionParam, async (c) => {
  const { id, contract, version } = c.req.valid('param');
  const { reader, versions } = await versionsShown(c.get('userId'), id, contract);
  const hit = versions.find((v) => v.version === version);
  if (!hit) throw unrecorded(reader, contract, id, version);
  const current = currentOf(versions)?.version ?? null;
  if (reader.access === 'party') {
    return c.json({ reader, version: versionForParty(hit), elements: hit.elements, current });
  }
  return c.json({
    version: hit.document,
    elements: hit.elements,
    approval: approvalView(hit),
    current,
  });
});

const ARTIFACT_MEDIA: Record<string, string> = {
  openapi: 'application/json',
  'json-schema': 'application/json',
  'mcp-tools': 'application/json',
  graphql: 'text/plain; charset=utf-8',
};

// a mock is generated where it is used, from the stored bytes of one version, never stored itself (data-model review: mocks are a function of the artifact's sha256): this hands a mock server (Prism for OpenAPI, graphql-tools for SDL) exactly those bytes, and says whether the version is current
contractRoutes.get(
  '/:id/contracts/:contract/versions/:version/artifact',
  versionParam,
  async (c) => {
    const { id, contract, version } = c.req.valid('param');
    const { reader, versions } = await versionsShown(c.get('userId'), id, contract);
    const hit = versions.find((v) => v.version === version);
    if (!hit) throw unrecorded(reader, contract, id, version);
    const text = hit.artifactSha256 ? await readArtifact(db, hit.artifactSha256) : null;
    const media = ARTIFACT_MEDIA[hit.contractType];
    if (text === null || !media) {
      return refused(
        c,
        [
          {
            code: 'CONTRACT_ARTIFACT_NOT_MOCKABLE',
            path: '/',
            detail: `${hit.document.contract}@${version} is ${hit.contractType}${text === null ? ' and holds no stored artifact' : ''}; a mock is generated from the stored artifact of an openapi, json-schema, mcp-tools or graphql version.`,
          },
        ],
        'ECOSYSTEM_REFUSED',
      );
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
  invalid(
    'the body is { decision: approve | return, reason?: why, required to return }',
    'SCHEMA_VIOLATION',
  ),
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
    if (!out.ok) return refused(c, out.refusals, 'ECOSYSTEM_REFUSED');
    return c.json(decidedView(out));
  },
);

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

contractRoutes.post('/:id/contracts/:contract/versions', contractParam, uploadBody, async (c) => {
  const { id, contract } = c.req.valid('param');
  const actor = restActor(c);
  const out = await publishContractVersion({
    projectId: id,
    contract,
    writer: { userId: actor.id, agency: actor.agency },
    ...c.req.valid('json'),
  });
  if (!out.ok) return refused(c, out.refusals, 'ECOSYSTEM_REFUSED');
  return c.json({ recorded: out.recorded, version: out.version }, out.recorded ? 201 : 200);
});
