"use client";

import { TONE_META } from "@/design/status";
import type { DeliveryPhase, RequirementStatus, RequirementWorkflowLink, RevisionState } from "../types";

type Hue = "slate" | "blue" | "green" | "muted" | "amber" | "violet" | "teal" | "red";

const tint = (v: string) => ({ fg: v, bg: `color-mix(in srgb, ${v} 12%, transparent)`, dot: v });

const HUE: Record<Hue, { fg: string; bg: string; dot: string }> = {
  slate: TONE_META.infra,
  blue: TONE_META.active,
  green: TONE_META.success,
  muted: TONE_META.neutral,
  amber: TONE_META.attention,
  red: TONE_META.failure,
  violet: tint("var(--wf-violet)"),
  teal: tint("var(--wf-teal)"),
};

/** The one enum badge this feature draws: a dot and a sentence-case label; the raw value and its meaning sit in the tooltip. */
export function EnumBadge({ hue, label, value, tip }: { hue: Hue; label: string; value: string; tip?: string }) {
  const c = HUE[hue];
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill px-2 py-0.5 text-11 font-semibold"
      style={{ color: c.fg, background: c.bg }}
      title={tip ? `${value} · ${tip}` : value}
      data-value={value}
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: c.dot }} />
      {label}
    </span>
  );
}

const STATUS: Record<RequirementStatus, [Hue, string, string]> = {
  draft: ["slate", "Draft", "Not agreed yet; nothing is built against it"],
  agreed: ["blue", "Agreed", "A person agreed a revision; work may be planned against it"],
  accepted: ["green", "Accepted", "Delivered and accepted"],
  dropped: ["muted", "Dropped", "No longer wanted"],
  deferred: ["muted", "Deferred", "Out of the current release; a person undefers it"],
};

const REVISION: Record<RevisionState, [Hue, string, string]> = {
  draft: ["slate", "Draft", "Still being written"],
  proposed: ["amber", "Proposed", "Waiting for a person to accept or return it"],
  current: ["green", "Current", "The accepted revision"],
  superseded: ["muted", "Superseded", "Replaced by a later accepted revision"],
};

const PHASE: Record<DeliveryPhase, [Hue, string, string]> = {
  agreed: ["blue", "Agreed", "No linked issue has started"],
  in_delivery: ["violet", "In delivery", "A linked issue has started"],
  delivered: ["teal", "Delivered", "Every linked issue is closed"],
};

type DesignStatus = NonNullable<RequirementWorkflowLink["designStatus"]>;
const DESIGN: Record<DesignStatus, [Hue, string, string]> = {
  draft: ["slate", "Draft", "The master is still drawing it"],
  proposed: ["amber", "Awaiting approval", "Nothing that builds it is dispatched until it is approved"],
  approved: ["green", "Approved", "Work that builds it may start"],
  returned: ["red", "Returned", "Sent back to the master to revise"],
};

const badgeOf = ([hue, label, tip]: [Hue, string, string], value: string) => (
  <EnumBadge hue={hue} label={label} value={value} tip={tip} />
);

export const RequirementStatusBadge = ({ status }: { status: RequirementStatus }) => badgeOf(STATUS[status], status);
export const RevisionStateBadge = ({ state }: { state: RevisionState }) => badgeOf(REVISION[state], state);
export const PhaseBadge = ({ phase }: { phase: DeliveryPhase }) => badgeOf(PHASE[phase], phase);
export const DesignStatusBadge = ({ status }: { status: DesignStatus }) => badgeOf(DESIGN[status], status);

const sentence = (s: string) => {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** An issue's status is the tracker's vocabulary, not this feature's; it reads as a quiet badge. */
export const IssueStatusBadge = ({ status }: { status: string }) => (
  <EnumBadge hue={status === "closed" || status === "dropped" ? "muted" : "slate"} label={sentence(status)} value={status} />
);
