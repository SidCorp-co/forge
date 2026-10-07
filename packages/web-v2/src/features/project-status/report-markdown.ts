// The status report as Markdown, for the copy button: the same sections, words and dates the page
// renders, from the one core read (`GET /api/projects/:id/status`), so a pasted report says what the
// page said when it was copied. A row that waits on the viewer reads "You" on the page; copied, it
// names the viewer, since the reader of a pasted report is somebody else.

import type { ProjectStatus, RoadmapItem, StatusWait } from "@forge/contracts/project-status";
import { ROADMAP_HORIZONS } from "@forge/contracts/project-status";
import type { WaitingOn } from "@forge/contracts/standing";
import { type EtaClock, etaInline, etaOfDelivery } from "@/features/forecast/eta";
import { needsYouKeyLabel } from "@/features/needs-you/routes";
import { verifiedSentence } from "@/features/releases/verified";
import { spanText } from "@/features/forecast/text";
import { formatDateTime } from "@/lib/i18n/format";
import type { labelCopy } from "@/lib/i18n/labels";
import type { Copy } from "@/lib/i18n/product-copy";
import { standingAct, standingWho } from "@/lib/i18n/standing-copy";

type Label = ReturnType<typeof labelCopy>;

export interface ReportWords {
  t: Copy;
  label: Label;
  clock: EtaClock;
}

/** Whom a row waits on and the act, in the interface language; `you` names the viewer when `viewerName` is given. */
export function waitText(w: WaitingOn, lang: string, viewerName?: string | null): string {
  const who = w.kind === "you" && viewerName ? viewerName : standingWho(w.who, lang);
  return w.act ? `${who} — ${standingAct(w.act, lang)}` : who;
}

const etaText = (d: RoadmapItem["delivery"], c: EtaClock): string | null => (d ? etaInline(etaOfDelivery(d, c), c) : null);

const readAt = (asOf: string, w: ReportWords) => `_${w.t("status.readAt", { at: formatDateTime(asOf, w.clock.lang, w.clock.timeZone) })}_`;

const join = (parts: (string | null | false | undefined)[]) => parts.filter(Boolean).join(" · ");

function roadmapLine(i: RoadmapItem, w: ReportWords): string {
  const deferral = i.deferral
    ? i.deferral.targetPhase
      ? w.t("status.deferredTo", { phase: i.deferral.targetPhase, reason: i.deferral.reason })
      : w.t("status.deferred", { reason: i.deferral.reason })
    : null;
  const notAgreed = i.state === "draft" ? w.t("status.notAgreed") : null;
  return `- **${i.key}** ${i.title} · ${join([w.label("requirementState", i.state), etaText(i.delivery, w.clock), deferral, notAgreed])}`;
}

function waitLine(x: StatusWait, s: ProjectStatus, w: ReportWords): string {
  return `- **${needsYouKeyLabel(x, (a) => w.label("needsYouArea", a))}** ${x.title} — ${waitText(x.waitingOn, w.clock.lang, s.viewer.name)}`;
}

export function statusMarkdown(s: ProjectStatus, w: ReportWords): string {
  const { t, label, clock } = w;
  const when = (iso: string) => formatDateTime(iso, clock.lang, clock.timeZone);
  const out: string[] = [];
  out.push(`# ${s.name} — ${t("status.title")}`, "");
  out.push(`${t("status.asOf", { at: when(s.asOf) })} · ${t("status.window", { days: s.days })}`, "");

  out.push(`## ${t("status.shipped")}`, "");
  if (s.shipped.releases.length === 0) out.push(t("status.shippedNone", { days: s.days }));
  for (const r of s.shipped.releases) {
    out.push(`- **${r.version}** · ${join([when(r.releasedAt), t("dash.shippedIssues", { n: r.issueCount }), verifiedSentence(r.verified, t)])}`);
    for (const g of r.contents) {
      for (const i of g.issues) out.push(`  - ${i.key} ${i.title}${g.requirement ? ` (${g.requirement.key})` : ""}`);
    }
  }
  if (s.shipped.releaseCount > s.shipped.releases.length) out.push(`- ${t("status.shippedMore", { n: s.shipped.releaseCount - s.shipped.releases.length })}`);
  if (s.shipped.requirementsShipped.length > 0) {
    out.push("", `${t("status.requirementsShipped")}: ${s.shipped.requirementsShipped.map((r) => `${r.key} ${r.title}`).join("; ")}`);
  }
  out.push("", readAt(s.shipped.asOf, w), "");

  out.push(`## ${t("status.inFlight")}`, "");
  out.push(`${t("status.openIssues", { n: s.inFlight.open })}: ${s.inFlight.byStatus.map((b) => `${label("issueStatus", b.status)} ${b.count}`).join(", ")}`);
  if (s.inFlight.truncated) out.push("", t("status.truncated"));
  out.push("", `${t("status.running")}:`);
  if (s.inFlight.running.length === 0) out.push(t("status.runningNone"));
  for (const i of s.inFlight.running) out.push(`- **${i.key}** ${i.title} · ${label("issueStatus", i.status)}`);
  out.push("", readAt(s.inFlight.asOf, w), "");

  out.push(`## ${t("status.waits")}`, "");
  if (s.waits.people.length === 0) out.push(t("status.waitsNone"));
  for (const x of s.waits.people) out.push(waitLine(x, s, w));
  if (s.waits.peopleCount > s.waits.people.length) out.push(`- ${t("status.waitsMore", { n: s.waits.peopleCount - s.waits.people.length })}`);
  out.push("", readAt(s.waits.asOf, w), "");

  out.push(`## ${t("status.requirements")} — ${t("status.criteriaProven", { proven: s.requirements.proven, total: s.requirements.total })}`, "");
  if (s.requirements.items.length === 0) out.push(t("status.requirementsNone"));
  for (const r of s.requirements.items) {
    out.push(
      `- **${r.key}** ${r.title} · ${join([
        label("requirementState", r.state),
        t("status.criteriaProven", { proven: r.criteria.proven, total: r.criteria.total }),
        t("status.issuesShipped", { shipped: r.issues.shipped, live: r.issues.live }),
        etaText(r.delivery, clock),
      ])}`,
    );
  }
  out.push("", readAt(s.requirements.asOf, w), "");

  out.push(`## ${t("status.nextRelease")}`, "");
  const n = s.nextRelease;
  if (n.version === null) out.push(t("status.nextReleaseNone"));
  else {
    out.push(
      `**${n.version}** · ${join([
        t("dash.shippedIssues", { n: n.issueCount }),
        n.forecast?.delivery ? etaInline(etaOfDelivery(n.forecast.delivery, clock), clock) : null,
        n.cut ? waitText({ kind: "person", who: n.cut.who, act: n.cut.act, rule: "", ref: null, dueAt: null }, clock.lang) : null,
      ])}`,
    );
  }
  out.push("", readAt(n.asOf, w), "");

  out.push(`## ${t("status.late")}`, "");
  if (s.late.items.length === 0) out.push(t("status.lateNone"));
  for (const l of s.late.items) out.push(`- **${l.key}** ${l.title} — ${t(`status.late.${l.late.reason}`, { by: spanText(l.late.byMinutes, clock.lang) })}`);
  out.push("", readAt(s.late.asOf, w), "");

  out.push(`## ${t("status.roadmap")}`, "");
  for (const h of ROADMAP_HORIZONS) {
    out.push(`### ${t(`status.horizon.${h}`)}`, "");
    const items = s.roadmap[h];
    if (items.length === 0) out.push(t("status.horizonEmpty"));
    for (const i of items) out.push(roadmapLine(i, w));
    out.push("");
  }
  out.push(readAt(s.roadmap.asOf, w), "", `_${t("status.forecastNote")}_`, "");
  return out.join("\n");
}
