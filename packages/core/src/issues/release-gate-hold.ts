// The release gate: an autonomous agent may finish an issue, but it may not
// declare it shipped.
//
// The driver ends by merging into the base branch and setting `closed`, and
// `closed` is what every surface reads as done. Nothing had run between "the
// code is on `dev`" and "it is live, and someone checked": epodsystem ISS-141
// self-closed at 08:47Z on 2026-08-24 with the reported bug still reproducing,
// and a human reopened it five minutes later.
//
// So on a project that declares a gate, an agent's close is rewritten to the
// gate status instead of rejected. Rejecting would strand the session with
// nowhere legal to go; the rewrite lets it finish honestly and moves the claim
// to the only writer entitled to make it — `release_batch finish`, which runs
// after a release actually happened.
//
// `dropped` is untouched on purpose: it means "this was not work", and holding
// a non-issue for a release it will never be part of parks it forever.

import type { IssueStatus } from '../db/schema.js';
import { resolveReleaseGate } from '../release-batch/gate.js';
import type { ActorAgency } from './actor-agency.js';

export interface CloseTargetDecision {
  status: IssueStatus;
  /** The close was converted into a park at the gate. */
  held: boolean;
}

/**
 * Where an agent's `closed` actually lands. Every other target, every human
 * actor, every project with no production and the release path itself pass
 * through.
 */
// cm:guard the agency check is what keeps a human's close working: an operator closing an issue by hand is making the shipped claim deliberately and owns it, while an agent has no way to know whether anything was released. It asks `agency`, NOT `actor.type` — this rule is about who is at the keyboard, and a job token is an agent writing as the person who queued it, so a device-ness test would let exactly that caller close unheld.
export async function resolveAgentCloseTarget(args: {
  projectId: string;
  requested: IssueStatus;
  agency: ActorAgency;
  viaReleasePath: boolean;
}): Promise<CloseTargetDecision> {
  const pass = { status: args.requested, held: false };
  if (args.requested !== 'closed') return pass;
  if (args.agency !== 'agent') return pass;
  if (args.viaReleasePath) return pass;

  const gate = await resolveReleaseGate(args.projectId);
  if (!gate) return pass;
  return { status: gate, held: true };
}
