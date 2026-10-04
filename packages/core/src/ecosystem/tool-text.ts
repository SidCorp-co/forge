import { CONTRACT_DECISIONS } from './contract/approval.js';
import { ACTIONS } from './tool-args.js';

export const DESCRIPTION = [
  "Read and write a project's ecosystem records: its interface, the links its own code holds to the contracts it consumes, its builder runs, and an ecosystem's bus.",
  'Reads: interface, links, link, builder_runs, builder_run, context (the contracts a run touching { paths } calls: per link with a call site under a path, its guide notes and the measured diff from its pinned version to the latest; recorded on { session } when named), bus (an ecosystem as this token may see it; each link carries impact: whether the latest version of its contract version passes or breaks it, naming the fields, call sites and outside-contract surface it breaks).',
  "Writes take { baseRevision, document } as their REST route does: interface_write (a holder of contracts.write; changing commitment windows that are already set also takes commitments.write, which a token holds only where its own grant names it, PERMISSION_FORBIDDEN otherwise), link_create and link_update (link-v1, only by the consuming project's own agent), builder_run_create and builder_run_update (builder-run-v1; a join or a push opens the run itself, so a master updates the open one, and a finished run's answer carries report.declaredWithoutCallSite), builder_run_supersede ({ run, reason }: closes an open run as superseded and opens a fresh manual run with the steps the project's current source type derives, waking its master; the project's own agent's, or an org admin's of the steward or the project's org).",
  "contract_version_publish ({ contract, version, kind, source, sourceRef }, POST /api/projects/:id/contracts/:contract/versions on REST) records a version of a contract this project publishes with artifact { upload: true }: kind is graphql (SDL text), mcp-tools ({ tools: [{ name, inputSchema }] }), openapi or json-schema, and must be the publication's type; core indexes its elements and measures it against the latest version. Refused by name: CONTRACT_KIND_UNKNOWN, CONTRACT_KIND_MISMATCH, ARTIFACT_UNREADABLE, VERSION_BUMP_TOO_SMALL, VERSION_NOT_IN_SCHEME, CONTRACT_NOT_PUBLISHED, PERMISSION_FORBIDDEN (the writer rule of interface_write).",
  'contract_version_decide ({ contract, version, decision: approve | return, reason? }, POST /api/projects/:id/contracts/:contract/versions/:version/decision on REST) decides a proposed version: a recorded version is proposed, and current only once approved. Whoever holds contracts.approve (project admin, or an org owner or admin), person or agent alike decides any version, breaking included. Refused by name: PERMISSION_FORBIDDEN, CONTRACT_VERSION_NOT_PROPOSED, CONTRACT_DECISION_REASON_MISSING.',
  "The writer is the token, never a field of the document. A refusal comes back as { code, path, detail } under the service's own code, nothing written.",
  'For the channel, use forge_channel.',
].join(' ');

const prop = (description: string, schema: Record<string, unknown> = { type: 'string' }) => ({
  ...schema,
  description,
});

export const INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...ACTIONS] },
    projectId: prop(
      'The project acted for; a token bound to one project, or the X-Forge-Project-Slug header, names it when omitted.',
    ),
    link: prop('link, link_update: the link uuid.'),
    run: prop('builder_run, builder_run_update, builder_run_supersede: the builder run uuid.'),
    reason: prop(
      'builder_run_supersede: why the open run is replaced, 1 to 1000 characters. contract_version_decide: why, required to return.',
    ),
    decision: prop('contract_version_decide: approve or return.', {
      type: 'string',
      enum: [...CONTRACT_DECISIONS],
    }),
    ecosystem: prop('bus: the ecosystem uuid.'),
    contract: prop(
      'contract_version_publish, contract_version_decide: the publication slug of a contract this project publishes.',
    ),
    version: prop(
      'contract_version_publish: the version name, in the interface versioning scheme, after the latest.',
    ),
    kind: prop(
      'contract_version_publish: graphql, mcp-tools, openapi or json-schema; the publication type.',
    ),
    source: prop(
      'contract_version_publish: the artifact, SDL text for graphql, the { tools } JSON for mcp-tools.',
      {
        type: ['string', 'object'],
      },
    ),
    sourceRef: prop(
      'contract_version_publish: where the artifact was read, <repository path>@<commit sha>.',
    ),
    paths: prop('context: repository-relative paths the run touches.', {
      type: 'array',
      items: { type: 'string' },
    }),
    session: prop('context: the agent session uuid to record what was loaded on.'),
    baseRevision: prop('A write: the revision this was read at, or null for a first write.', {
      type: ['integer', 'null'],
    }),
    document: prop('A write: the whole document.', { type: 'object' }),
  },
  required: ['action'],
  additionalProperties: false,
};
