// forge_ux_improver — ISS-579. The scheduled UX-improver agent's two moves:
// read the deterministic candidate report, then commit the candidates it could
// not refute. Splitting them is the point — the detector decides what recurs,
// the agent decides what deserves to become a rule, and a human still approves
// in the settings inbox. Nothing this tool writes is ever `active`.

import { z } from 'zod';
import { applyUxImproverProposals, loadUxImproverReport } from '../../projects/ux-improver.js';
import { markUntrusted } from '../../prompt/sanitize.js';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['candidates', 'propose']),
    projectId: z.uuid().optional(),
    keys: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
  })
  .strict();

export const forgeUxImproverTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_ux_improver',
  description:
    'UX Completeness Contract learning loop (ISS-579): turn accumulated ux_findings into PROPOSED contract rules. ' +
    'action=candidates: read the deterministic aggregation — recurring gap clusters with evidence issue ids, plus `refused[]` saying which clusters the detector declined and why (one-off / already-covered / already-proposed). Read-only, project-member. ' +
    'action=propose: commit selected candidates by `key` — writes ux_contract_rules at status="proposed", source="learned", never `active`, so a human approves them in project settings. Idempotent: a re-run unions evidence onto the existing proposal instead of queueing a duplicate. Requires writer. ' +
    'A candidate is only recurring when it spans >=3 DISTINCT issues; a single finding never becomes a rule. Refute each candidate yourself before proposing it — the detector counts, it does not judge.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal } = ctx;
    const projectId = await resolveEffectiveProjectId(ctx, input.projectId);

    if (input.action === 'candidates') {
      await assertPrincipalIsMember(principal, projectId);
      const report = await loadUxImproverReport(projectId);
      return {
        ...report,
        candidates: report.candidates.map((c) => ({
          ...c,
          text: markUntrusted(c.text, { source: 'ux_finding.detail' }),
        })),
        refused: report.refused.map((r) => ({
          ...r,
          sample: markUntrusted(r.sample, { source: 'ux_finding.detail' }),
        })),
      };
    }

    if (!input.keys) {
      return { ok: false, reason: 'keys_required' };
    }

    await assertPrincipalIsWriter(principal, projectId);
    const { outcomes } = await applyUxImproverProposals(projectId, input.keys);
    return { ok: true, outcomes };
  },
});
