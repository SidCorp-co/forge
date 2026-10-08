// The status report as Markdown, for the copy button: the same sections, words and dates the page
// renders, from the one core read (`GET /api/projects/:id/status`), so a pasted report says what the
// page said when it was copied. A row that waits on the viewer reads "You" on the page; copied, it
// names the viewer, since the reader of a pasted report is somebody else.

import type { ProjectStatus, RoadmapItem, StatusWait, StatusWaitPerson, StatusWaits } from "@forge/contracts/project-status";
import { ROADMAP_HORIZONS } from "@forge/contracts/project-status";
import { type EtaClock, etaInline, etaOfDelivery } from "@/features/forecast/eta";
import { honestyLine } from "@/features/forecast/honesty";
import { progressText } from "@/features/forecast/progress";
import { needsYouKeyLabel } from "@/features/needs-you/routes";
import { verifiedSentence } from "@/features/releases/verified";
import { spanText } from "@/features/forecast/text";
import { formatDateTime } from "@/lib/i18n/format";
import type { labelCopy } from "@/lib/i18n/labels";
import type { Copy } from "@/lib/i18n/product-copy";
import { said } from "@/lib/i18n/said";
import type { Said } from "@forge/contracts/said";

type Label = ReturnType<typeof labelCopy>;

export interface ReportWords {
  t: Copy;
  label: Label;
  clock: EtaClock;
}

/** Whom a row waits on and the act, read from what core said in the interface language; `you` names the viewer when `viewerName` is given. */
export function waitText(w: { kind: string; says: { who: Said; act: Said } }, lang: string, viewerName?: string | null): string {
  const who = w.kind === "you" && viewerName ? viewerName : said(w.says.who, lang);
  const act = said(w.says.act, lang);
  return act ? `${who} — ${act}` : who;
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
  return `- **${i.key}** ${i.title} · ${join([w.label("requirementState", i.state), etaText(i.delivery, w.clock), honestyLine(i.delivery, i.moved, w.t, w.clock.lang), deferral, notAgreed])}`;
}

const personKey = (w: { kind: string; says: { who: Said } }) => `${w.kind}:${JSON.stringify(w.says.who)}`;

/** The rows core grouped by person, under each person core named; a report stored before the grouping reads as one unheaded group. */
export function waitGroups(w: Pick<StatusWaits, "people" | "byPerson">): { person: StatusWaitPerson | null; rows: StatusWait[] }[] {
  if (!w.byPerson) return w.people.length > 0 ? [{ person: null, rows: w.people }] : [];
  const rows = new Map<string, StatusWait[]>();
  for (const x of w.people) rows.set(personKey(x.waitingOn), [...(rows.get(personKey(x.waitingOn)) ?? []), x]);
  return w.byPerson.flatMap((person) => {
    const own = rows.get(personKey(person)) ?? [];
    return own.length > 0 ? [{ person, rows: own }] : [];
  });
}

/** A person's heading: who, and how many asks wait on them; `you` names the viewer when given. */
export function personHeading(p: StatusWaitPerson, t: Copy, lang: string, viewerName?: string | null): string {
  const who = p.kind === "you" && viewerName ? viewerName : said(p.says.who, lang);
  return t("status.waitsPerson", { who, n: p.count });
}

function waitLine(x: StatusWait, s: ProjectStatus, w: ReportWords): string {
  return `- **${needsYouKeyLabel(x, (a) => w.label("needsYouArea", a))}** ${said(x.says.title, w.clock.lang)} — ${waitText(x.waitingOn, w.clock.lang, s.viewer.name)}`;
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
  if ((s.shipped.requirementsAwaitingProof ?? []).length > 0) {
    out.push("", `${t("status.requirementsAwaitingProof")}: ${(s.shipped.requirementsAwaitingProof ?? []).map((r) => `${r.key} ${r.title} (${t("status.criteriaProven", { proven: r.proven, total: r.total })})`).join("; ")}`);
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
  for (const g of waitGroups(s.waits)) {
    if (g.person) out.push(`### ${personHeading(g.person, t, clock.lang, s.viewer.name)}`, "");
    for (const x of g.rows) out.push(waitLine(x, s, w));
    if (g.person) out.push("");
  }
  if (s.waits.peopleCount > s.waits.people.length) out.push(`- ${t("status.waitsMore", { n: s.waits.peopleCount - s.waits.people.length })}`);
  out.push("", readAt(s.waits.asOf, w), "");

  out.push(`## ${t("status.requirements")} — ${t("status.criteriaProven", { proven: s.requirements.proven, total: s.requirements.total })}`, "");
  if (s.requirements.items.length === 0) out.push(t("status.requirementsNone"));
  for (const r of s.requirements.items) {
    out.push(
      `- **${r.key}** ${r.title} · ${join([
        label("requirementState", r.state),
        t("status.criteriaProven", { proven: r.criteria.proven, total: r.criteria.total }),
        progressText(r.progress, t),
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
        n.state && n.state !== "draft" ? label("releaseState", n.state) : null,
        progressText(n.progress, t),
        n.forecast?.delivery ? etaInline(etaOfDelivery(n.forecast.delivery, clock), clock) : null,
        n.turn ? waitText({ kind: "person", says: n.turn.says }, clock.lang) : null,
        n.behind ? t("status.behind", { version: n.behind.version, n: n.behind.issueCount }) : null,
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
