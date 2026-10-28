// A project's gates (REQ-76): its profile, the mode each policy gate takes on it, and the one door
// that changes them, recording who changed them and why. A gate is asked where it guards
// (`@forge/contracts/gate-profiles:projectGate`, `lib/gated.ts`); this module owns what sets them.

import {
  GATE_CATALOG,
  GATE_IDS,
  GATE_MODES,
  type GateId,
  type GateMode,
  type GateProfile,
  type GatesConfig,
  gateEntry,
  gateProfileOf,
  KERNEL_RULES,
  PROFILE_TIGHTNESS,
  projectGate,
  projectGates,
  type RaiseCause,
  type ResolvedGate,
} from '@forge/contracts/gate-profiles';
import { type VerifiedJudge, verifiedJudgeOf } from '@forge/contracts/verified-rule';
import { desc, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { users } from '../db/schema-auth.js';
import { projectGateChanges } from '../db/schema-gate-changes.js';
import type { ApiRefusal } from './documents.js';
import type { ProjectDocument } from './schema.js';
import {
  readPolicy,
  readProjectConfig,
  type WriteOutcome,
  writeProjectDocument,
} from './service.js';

/** A project's gates as they stand: the profile, any raise, the overrides and every gate's mode. */
export interface ProjectGatesView {
  declared: boolean;
  revision: number | null;
  profile: GateProfile;
  raised: GatesConfig['raised'] | null;
  overrides: NonNullable<GatesConfig['overrides']>;
  gates: ResolvedGate[];
}

async function sources(projectId: string) {
  const [held, policy] = await Promise.all([readProjectConfig(projectId), readPolicy(projectId)]);
  return { held, policy: policy?.document ?? null };
}

export async function readProjectGates(projectId: string): Promise<ProjectGatesView> {
  const { held, policy } = await sources(projectId);
  const gates = held?.document.gates;
  return {
    declared: held !== null,
    revision: held?.revision ?? null,
    profile: gateProfileOf(gates),
    raised: gates?.raised ?? null,
    overrides: gates?.overrides ?? {},
    gates: projectGates(held?.document, policy),
  };
}

/** Who the project's criteria are judged by under its gate profile (`@forge/contracts/verified-rule:verifiedJudgeOf`). */
export async function readVerifiedJudge(projectId: string): Promise<VerifiedJudge> {
  const { held, policy } = await sources(projectId);
  return verifiedJudgeOf(held?.document, policy);
}

/** Every gate's mode on `projectId`, by id. */
export async function readGateModes(
  projectId: string,
): Promise<Readonly<Record<GateId, ResolvedGate>>> {
  const { held, policy } = await sources(projectId);
  return Object.fromEntries(projectGates(held?.document, policy).map((g) => [g.id, g])) as Record<
    GateId,
    ResolvedGate
  >;
}

/** The mode gate `id` takes on `projectId`, and where it came from. */
export async function gateOf(projectId: string, id: GateId): Promise<ResolvedGate> {
  const { held, policy } = await sources(projectId);
  return projectGate(held?.document, policy, id);
}

const TIGHT: Readonly<Record<GateMode, number>> = { enforce: 2, advise: 1, off: 0 };

/** The gates `after` takes looser than `before` did, by id. */
function loosened(before: readonly ResolvedGate[], after: readonly ResolvedGate[]): GateId[] {
  const was = new Map(before.map((g) => [g.id, g.mode]));
  return after.filter((g) => TIGHT[g.mode] < TIGHT[was.get(g.id) ?? 'enforce']).map((g) => g.id);
}

export const GATES_REASON_MAX = 500;

export interface GatesWrite {
  projectId: string;
  userId: string;
  baseRevision: number;
  profile: GateProfile;
  overrides: Partial<Record<GateId, GateMode>>;
  reason: string;
}

async function actorKind(userId: string): Promise<'person' | 'agent'> {
  const [row] = await db.select({ kind: users.kind }).from(users).where(eq(users.id, userId));
  return row?.kind === 'agent' ? 'agent' : 'person';
}

/** What a gates write refuses before it is tried: an empty reason, or a mode its gate cannot take. */
export function gatesWriteRefusals(input: Pick<GatesWrite, 'overrides' | 'reason'>): ApiRefusal[] {
  const refusals: ApiRefusal[] = [];
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > GATES_REASON_MAX) {
    refusals.push({
      code: 'GATES_REASON_REQUIRED',
      path: '/reason',
      detail: `a change to a project's gates says why, in 1 to ${GATES_REASON_MAX} characters; the reason is kept with who changed them (REQ-76 BC-12).`,
    });
  }
  for (const [id, mode] of Object.entries(input.overrides)) {
    if (!(GATE_IDS as readonly string[]).includes(id)) {
      refusals.push({
        code: 'GATE_UNKNOWN',
        path: `/overrides/${id}`,
        detail: `\`${id}\` is not a policy gate; the gates are ${GATE_IDS.join(', ')}. A kernel rule (${KERNEL_RULES.map((k) => k.id).join(', ')}) is no gate and no profile or override relaxes it (REQ-76 BC-10).`,
      });
      continue;
    }
    const entry = gateEntry(id as GateId);
    if (!(entry.modes as readonly string[]).includes(mode as string)) {
      refusals.push({
        code: 'GATE_MODE_UNSUPPORTED',
        path: `/overrides/${id}`,
        detail: `gate \`${id}\` takes ${entry.modes.join(' or ')}, not \`${String(mode)}\`: ${entry.relaxed}.`,
      });
    }
  }
  return refusals;
}

/**
 * Sets a project's profile and overrides (BC-2, BC-3), recording the change with who made it and why
 * (BC-12). A profile Forge raised after an incident (BC-13) is lowered only by a person: an agent's
 * write that would loosen any gate while the raise stands is refused GATE_PROFILE_RAISED. A person's
 * write ends the raise.
 */
export async function writeGates(input: GatesWrite): Promise<WriteOutcome<ProjectDocument>> {
  const early = gatesWriteRefusals(input);
  if (early.length > 0) return { ok: false, refusals: early };
  const { held, policy } = await sources(input.projectId);
  if (!held) {
    return {
      ok: false,
      refusals: [
        {
          code: 'GATES_NO_PROJECT_DOCUMENT',
          path: '',
          detail: `project ${input.projectId} has declared no project document, so its gates are the standard profile and have nowhere to be set; PUT /api/projects/${input.projectId}/config first.`,
        },
      ],
    };
  }
  const before = held.document.gates;
  const kind = await actorKind(input.userId);
  const overrides = Object.fromEntries(
    Object.entries(input.overrides).filter(([, m]) => m !== undefined),
  ) as Partial<Record<GateId, GateMode>>;
  const next: GatesConfig = {
    profile: input.profile,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    ...(before?.raised && kind === 'agent' ? { raised: before.raised } : {}),
  };
  const document: ProjectDocument = { ...held.document, gates: next };
  if (before?.raised && kind === 'agent') {
    const looser = loosened(projectGates(held.document, policy), projectGates(document, policy));
    if (looser.length > 0 || PROFILE_TIGHTNESS[input.profile] < PROFILE_TIGHTNESS[before.profile]) {
      return {
        ok: false,
        refusals: [
          {
            code: 'GATE_PROFILE_RAISED',
            path: '/profile',
            detail: `Forge raised this project from \`${before.raised.from}\` to \`${before.profile}\` after a ${before.raised.cause === 'deploy_failed' ? 'failed deploy' : 'rolled-back release'} (${before.raised.ref}) on ${before.raised.at}, and only a person lowers it again (REQ-76 BC-13); this write would loosen ${looser.length > 0 ? looser.map((g) => `\`${g}\``).join(', ') : 'the profile'}. Ask a person to set it.`,
          },
        ],
      };
    }
  }
  return writeProjectDocument({
    projectId: input.projectId,
    userId: input.userId,
    baseRevision: input.baseRevision,
    raw: document,
    gates: {
      also: (tx, stored) =>
        recordChange(tx, {
          projectId: input.projectId,
          revision: stored.revision,
          before,
          after: next,
          actorKind: kind,
          actorUserId: input.userId,
          cause: 'set',
          reason: input.reason.trim(),
          ref: null,
        }),
    },
  });
}

async function recordChange(
  tx: Tx,
  c: {
    projectId: string;
    revision: number;
    before: GatesConfig | undefined;
    after: GatesConfig;
    actorKind: 'person' | 'agent' | 'forge';
    actorUserId: string | null;
    cause: 'set' | RaiseCause;
    reason: string;
    ref: string | null;
  },
): Promise<void> {
  await tx.insert(projectGateChanges).values({
    projectId: c.projectId,
    configRevision: c.revision,
    profileFrom: c.before ? c.before.profile : null,
    profileTo: c.after.profile,
    overridesFrom: c.before?.overrides ?? {},
    overridesTo: c.after.overrides ?? {},
    actorKind: c.actorKind,
    actorUserId: c.actorUserId,
    cause: c.cause,
    reason: c.reason,
    ref: c.ref,
  });
}

export type RaiseOutcome = 'raised' | 'not_yolo' | 'undeclared' | 'stale';

/**
 * After a failed deploy or a rolled-back release on a yolo project, Forge raises it to standard
 * (BC-13): the profile becomes `standard`, its overrides are set aside (kept in the change's record),
 * and `raised` says why until a person lowers it. Any other profile is left as it is.
 */
export async function raiseAfterIncident(input: {
  projectId: string;
  cause: RaiseCause;
  ref: string;
  why: string;
}): Promise<RaiseOutcome> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const held = await readProjectConfig(input.projectId);
    if (!held) return 'undeclared';
    const before = held.document.gates;
    if (gateProfileOf(before) !== 'yolo') return 'not_yolo';
    const at = new Date().toISOString();
    const next: GatesConfig = {
      profile: 'standard',
      raised: { from: 'yolo', cause: input.cause, ref: input.ref.slice(0, 200), at },
    };
    const outcome = await writeProjectDocument({
      projectId: input.projectId,
      userId: null,
      baseRevision: held.revision,
      raw: { ...held.document, gates: next },
      gates: {
        also: (tx, stored) =>
          recordChange(tx, {
            projectId: input.projectId,
            revision: stored.revision,
            before,
            after: next,
            actorKind: 'forge',
            actorUserId: null,
            cause: input.cause,
            reason: input.why,
            ref: input.ref,
          }),
      },
    });
    if (outcome.ok) return 'raised';
    if (!outcome.refusals.some((r) => r.code === 'STALE_BASE')) {
      throw new Error(
        `gates: raising project ${input.projectId} after ${input.cause} was refused: ${outcome.refusals.map((r) => `${r.code}: ${r.detail}`).join('; ')}`,
      );
    }
  }
  return 'stale';
}

export interface GateChangeView {
  at: string;
  configRevision: number;
  profileFrom: GateProfile | null;
  profileTo: GateProfile;
  overridesFrom: unknown;
  overridesTo: unknown;
  actorKind: 'person' | 'agent' | 'forge';
  actorUserId: string | null;
  actorName: string | null;
  cause: 'set' | RaiseCause;
  reason: string;
  ref: string | null;
}

/** The project's gate changes, newest first. */
export async function readGateChanges(projectId: string, limit = 50): Promise<GateChangeView[]> {
  const rows = await db
    .select({ c: projectGateChanges, name: users.displayName, email: users.email })
    .from(projectGateChanges)
    .leftJoin(users, eq(users.id, projectGateChanges.actorUserId))
    .where(eq(projectGateChanges.projectId, projectId))
    .orderBy(desc(projectGateChanges.createdAt))
    .limit(limit);
  return rows.map(({ c, name, email }) => ({
    at: c.createdAt.toISOString(),
    configRevision: c.configRevision,
    profileFrom: c.profileFrom,
    profileTo: c.profileTo,
    overridesFrom: c.overridesFrom,
    overridesTo: c.overridesTo,
    actorKind: c.actorKind,
    actorUserId: c.actorUserId,
    actorName: name ?? email ?? null,
    cause: c.cause,
    reason: c.reason,
    ref: c.ref,
  }));
}

/** The catalog every project reads its gates against (BC-1): each gate, what it refuses and its default per profile. */
export function gateCatalog() {
  return {
    profiles: ['strict', 'standard', 'yolo'] as const,
    modes: GATE_MODES,
    gates: GATE_CATALOG,
    kernel: KERNEL_RULES,
  };
}
