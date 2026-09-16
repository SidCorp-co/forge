/**
 * `sessionContext` — the opaque JSON the pipeline carries between sessions,
 * and the ISS-820 rule that keeps a `verified*` key from being a bare claim.
 *
 * It lives here rather than at a call site because BOTH write surfaces accept
 * the field: MCP `forge_issues.update`, and REST `PATCH /api/issues/:id`, which
 * is how an agent on the CLI records the branch that `pipeline/work-evidence.ts`
 * later reads as proof that work exists.
 */

import { z } from 'zod';

const VERIFIED_KEY_RE = /^verified/i;
const VERIFIED_CLAIM_MAX_NODES = 100_000;
const VERIFIED_CLAIM_MAX_DEPTH = 64;
const ISO_8601_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isShapedVerifiedClaim(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  const evidence = obj.evidence;
  const evidenceOk =
    (typeof evidence === 'string' && evidence.length > 0) ||
    (Array.isArray(evidence) &&
      evidence.length > 0 &&
      evidence.every((e) => typeof e === 'string' && e.length > 0));
  if (!evidenceOk) return false;
  const checkedAt = obj.checkedAt;
  return (
    typeof checkedAt === 'string' &&
    ISO_8601_DATETIME_RE.test(checkedAt) &&
    !Number.isNaN(Date.parse(checkedAt))
  );
}

interface VerifiedClaimViolation {
  path: string;
  message: string;
}

/**
 * Bounded recursive walk of a sessionContext value looking for a `verified*`
 * key (case-insensitive, any depth) whose value is not shaped
 * `{ evidence: string|string[], checkedAt: ISO timestamp }`. Exported so
 * tests can exercise it directly with a pathological payload.
 */
export function findVerifiedClaimViolation(value: unknown): VerifiedClaimViolation | null {
  let nodeCount = 0;
  let boundExceeded = false;

  function walk(node: unknown, path: string, depth: number): VerifiedClaimViolation | null {
    if (boundExceeded) return null;
    nodeCount++;
    if (nodeCount > VERIFIED_CLAIM_MAX_NODES) {
      boundExceeded = true;
      return null;
    }
    if (depth > VERIFIED_CLAIM_MAX_DEPTH) {
      return null;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (boundExceeded) return null;
        const violation = walk(node[i], `${path}[${i}]`, depth + 1);
        if (violation) return violation;
      }
      return null;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (boundExceeded) return null;
        const childPath = path ? `${path}.${key}` : key;
        if (VERIFIED_KEY_RE.test(key) && !isShapedVerifiedClaim(child)) {
          return {
            path: childPath,
            message: `${childPath}: a verified* claim must be shaped { evidence: string|string[], checkedAt: ISO timestamp } — bare strings/booleans are not evidence`,
          };
        }
        const violation = walk(child, childPath, depth + 1);
        if (violation) return violation;
      }
      return null;
    }
    return null;
  }

  return walk(value, '', 0);
}

export const sessionContextSchema = z
  .record(z.string(), z.unknown())
  .nullable()
  .optional()
  .refine((v) => v == null || JSON.stringify(v).length <= 200_000, {
    message: 'sessionContext serialised size exceeds 200000 bytes',
  })
  .superRefine((v, ctx) => {
    if (v == null) return;
    const violation = findVerifiedClaimViolation(v);
    if (violation) {
      ctx.addIssue({ code: 'custom', path: [violation.path], message: violation.message });
    }
  });

/**
 * ISS-959 — the value a client read off the row, sent back with its write so
 * the write can be refused when the field moved underneath it.
 *
 * `sessionContext` is where the driver's lease lives, and until this existed
 * the lease was advisory in the only sense that matters: two runs that both
 * read no holder both claimed, and the later write erased the earlier with
 * neither able to tell. The rule the plugin carried client-side is a
 * compare-and-set, and a compare-and-set nothing enforces is decorative.
 */
export const sessionContextExpectSchema = z
  .object({ sessionContext: z.record(z.string(), z.unknown()).nullable() })
  .strict();

export type SessionContextExpect = z.infer<typeof sessionContextExpectSchema>;
