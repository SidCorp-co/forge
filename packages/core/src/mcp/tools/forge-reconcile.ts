// MCP tool: forge_reconcile
// Update Pipeline stage ② (Reconcile), ISS-801.
// Used by the Master agent to record its verdict + candidate body, and by
// verifier agents to record their votes.

import { z } from 'zod';
import {
  applyReconcileRun,
  getReconcileRun,
  listReconcileRunsForProject,
  recordReconcileVerdict,
  recordVerifierVote,
  rejectReconcileRun,
  spawnReconcileRun,
} from '../../skills/reconcile-service.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsAdmin,
  assertPrincipalIsMember,
  principalUserId,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['trigger', 'get', 'list', 'record_verdict', 'record_vote', 'apply', 'reject']),
    projectId: z.string().uuid().optional(),
    /** Required for action=trigger: the update packet to reconcile against. */
    packetId: z.string().uuid().optional(),
    /** Required for action=trigger: the skill to reconcile. */
    skillId: z.string().uuid().optional(),
    /** Required for action=get, apply, reject, record_verdict, record_vote. */
    runId: z.string().uuid().optional(),
    // record_verdict fields
    /** Required for action=record_verdict. */
    verdict: z.enum(['no-op', 'apply', 'apply-with-adaptation', 'escalate']).optional(),
    /** Required for action=record_verdict when verdict=apply/apply-with-adaptation. */
    candidateBody: z.string().optional(),
    /** Required for action=record_verdict: explicit rationale (story→how; charter→how; invariants→still satisfied). */
    rationale: z.string().max(5000).optional(),
    // record_vote fields
    /** Required for action=record_vote: the verifier job ID (this job). */
    jobId: z.string().uuid().optional(),
    /** Required for action=record_vote. */
    vote: z.enum(['pass', 'fail']).optional(),
    /** Required for action=record_vote: reason for the vote. */
    reason: z.string().max(2000).optional(),
    // reject fields
    /** Required for action=reject. */
    rejectReason: z.string().min(1).max(1000).optional(),
  })
  .strict();

export const forgeReconcileTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_reconcile',
  description: `Update Pipeline stage ② (Reconcile) tool. Actions:
  - trigger: Start a reconcile run for a skill × packet pair (admin-only). Enforces C1–C5 contract. Returns runId or a structured refusal.
  - get: Fetch a single reconcile run by runId (member-gated). Returns run status, verdict, gate, bundle snapshot, verifier votes.
  - list: List recent reconcile runs for the project (member-gated).
  - record_verdict: Master agent records its verdict + candidate body for an in-flight run (admin-only). Verdicts: no-op | apply | apply-with-adaptation | escalate. For apply/apply-with-adaptation, candidateBody and rationale are required.
  - record_vote: Verifier agent records its pass/fail vote for a run in 'verifying' status. jobId (this verifier's job ID), vote ('pass'|'fail'), and reason are required.
  - apply: Human approves a 'decided' run at the human gate and publishes the candidate body (admin-only).
  - reject: Human rejects a 'decided' run with a reason (admin-only). Sets status to 'escalated'.`,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
    const actorUserId = principalUserId(ctx.principal);

    // ── trigger ───────────────────────────────────────────────────────────────
    if (input.action === 'trigger') {
      await assertPrincipalIsAdmin(ctx.principal, projectId);
      if (!input.packetId) throw new Error('BAD_REQUEST: packetId is required for action=trigger');
      if (!input.skillId) throw new Error('BAD_REQUEST: skillId is required for action=trigger');

      const result = await spawnReconcileRun({
        projectId,
        packetId: input.packetId,
        skillId: input.skillId,
        actorUserId,
      });
      return {
        ok: result.ok,
        ...(result.ok ? { runId: result.runId } : { reason: result.reason, detail: result.detail }),
      };
    }

    // ── get ───────────────────────────────────────────────────────────────────
    if (input.action === 'get') {
      await assertPrincipalIsMember(ctx.principal, projectId);
      if (!input.runId) throw new Error('BAD_REQUEST: runId is required for action=get');
      const run = await getReconcileRun(input.runId);
      if (!run || run.projectId !== projectId)
        throw new Error('NOT_FOUND: reconcile run not found');
      return { run };
    }

    // ── list ──────────────────────────────────────────────────────────────────
    if (input.action === 'list') {
      await assertPrincipalIsMember(ctx.principal, projectId);
      const runs = await listReconcileRunsForProject(projectId);
      return { runs };
    }

    // ── record_verdict ────────────────────────────────────────────────────────
    if (input.action === 'record_verdict') {
      await assertPrincipalIsAdmin(ctx.principal, projectId);
      if (!input.runId) throw new Error('BAD_REQUEST: runId is required for action=record_verdict');
      if (!input.verdict)
        throw new Error('BAD_REQUEST: verdict is required for action=record_verdict');
      if (!input.rationale)
        throw new Error('BAD_REQUEST: rationale is required for action=record_verdict');
      if (
        (input.verdict === 'apply' || input.verdict === 'apply-with-adaptation') &&
        !input.candidateBody
      ) {
        throw new Error(
          'BAD_REQUEST: candidateBody is required when verdict is apply or apply-with-adaptation',
        );
      }

      await recordReconcileVerdict({
        runId: input.runId,
        verdict: input.verdict,
        candidateBody: input.candidateBody ?? null,
        rationale: input.rationale,
        actor: 'agent:master',
      });
      return { ok: true };
    }

    // ── record_vote ───────────────────────────────────────────────────────────
    if (input.action === 'record_vote') {
      // Verifier agent — principal may be admin or system; no role check here
      // (the run's own status guards prevent double-voting in the wrong state).
      if (!input.runId) throw new Error('BAD_REQUEST: runId is required for action=record_vote');
      if (!input.jobId) throw new Error('BAD_REQUEST: jobId is required for action=record_vote');
      if (!input.vote) throw new Error('BAD_REQUEST: vote is required for action=record_vote');
      if (!input.reason) throw new Error('BAD_REQUEST: reason is required for action=record_vote');

      await recordVerifierVote({
        runId: input.runId,
        jobId: input.jobId,
        vote: input.vote,
        reason: input.reason,
      });
      return { ok: true };
    }

    // ── apply ─────────────────────────────────────────────────────────────────
    if (input.action === 'apply') {
      await assertPrincipalIsAdmin(ctx.principal, projectId);
      if (!input.runId) throw new Error('BAD_REQUEST: runId is required for action=apply');

      try {
        await applyReconcileRun(input.runId, actorUserId);
      } catch (err: unknown) {
        const msg = String(err);
        if (msg.startsWith('NOT_FOUND:') || msg.startsWith('BAD_REQUEST:')) throw new Error(msg);
        throw err;
      }
      return { ok: true };
    }

    // ── reject ────────────────────────────────────────────────────────────────
    if (input.action === 'reject') {
      await assertPrincipalIsAdmin(ctx.principal, projectId);
      if (!input.runId) throw new Error('BAD_REQUEST: runId is required for action=reject');
      if (!input.rejectReason)
        throw new Error('BAD_REQUEST: rejectReason is required for action=reject');

      try {
        await rejectReconcileRun(input.runId, actorUserId, input.rejectReason);
      } catch (err: unknown) {
        const msg = String(err);
        if (msg.startsWith('NOT_FOUND:') || msg.startsWith('BAD_REQUEST:')) throw new Error(msg);
        throw err;
      }
      return { ok: true };
    }

    throw new Error(`unknown action: ${input.action}`);
  },
});
