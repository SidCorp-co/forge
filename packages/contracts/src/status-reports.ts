// A status report kept as history: the project status read (`project-status.ts`) stored once, dated
// and never changed, by a person ("Save report") or by a `status_report` schedule that sends it to
// its recipients. What changed since the previous report is derived here from the two stored reads
// and nothing else, so core's delivery, the page and a test all read the same lines.

import type { DeliveryForecast } from "./forecast.js";
import type {
	ProjectStatus,
	StatusLateItem,
	StatusWait,
} from "./project-status.js";
import type { RefusalStatuses } from "./refusal.js";

export const STATUS_REPORT_PRODUCERS = ["person", "schedule"] as const;
export type StatusReportProducerKind = (typeof STATUS_REPORT_PRODUCERS)[number];

/** The most reports one history page lists, newest first. */
export const STATUS_REPORT_HISTORY_ROWS = 50;

/** A dated forecast counts as moved once it shifts by at least this many minutes: one day. */
export const STATUS_DATE_MOVE_MIN_MINUTES = 24 * 60;

/** A weekly report by default: Monday 09:00 in the zone the person picks. */
export const STATUS_REPORT_DEFAULT_CRON = "0 9 * * 1";

export const STATUS_REPORT_REFUSAL_CODES = [
	"STATUS_REPORT_REFUSED",
	"STATUS_REPORT_NO_RECIPIENTS",
	"STATUS_REPORT_RECIPIENT_NOT_MEMBER",
	"STATUS_REPORT_PERIOD_DELIVERED",
] as const;
export type StatusReportRefusalCode =
	(typeof STATUS_REPORT_REFUSAL_CODES)[number];

export const STATUS_REPORT_REFUSAL_STATUSES = {
	STATUS_REPORT_PERIOD_DELIVERED: 409,
} as const satisfies RefusalStatuses<StatusReportRefusalCode>;

/** What a `status_report` schedule's `params` hold: who receives it and the window it reads. */
export interface StatusReportScheduleParams {
	recipients: string[];
	days?: number;
}

export const STATUS_REPORT_PARAMS_SHAPE =
	"{ recipients: [<user id of a project member>, …] (at least one), days?: 1..90 }";

/** Who stored a report: the person who saved it, or the schedule that sent it and whose read it is. */
export interface StatusReportProducer {
	kind: StatusReportProducerKind;
	/** The person who saved it, or the schedule's owner it was read as; null once that account is gone. */
	user: { id: string; name: string | null } | null;
	/** The schedule that sent it; null for a saved report, and once the schedule is deleted. */
	schedule: { id: string; name: string } | null;
}

export interface StatusReportMeta {
	id: string;
	projectId: string;
	/** When the stored read began. */
	asOf: string;
	days: number;
	producer: StatusReportProducer;
	/** The schedule slot a sent report answers (ISO instant); null for a saved one. */
	period: string | null;
}

export interface StatusShippedLine {
	version: string;
	releasedAt: string;
	issues: { key: string; title: string }[];
}

export interface StatusMovedDate {
	kind: "release" | "requirement";
	key: string;
	title: string;
	from: string;
	to: string;
}

/** What changed between two stored reports, every line read from the two of them. */
export interface StatusReportDiff {
	/** The previous report's `asOf`. */
	since: string;
	/** Releases the newer report lists that the older one did not, with their issues. */
	shipped: StatusShippedLine[];
	/** Requirements the newer report reads fully shipped that the older one did not. */
	requirementsShipped: { key: string; title: string }[];
	/** Items late in the newer report and not in the older one. */
	newlyLate: StatusLateItem[];
	/** Rows that waited on a person in the older report and no longer do. */
	noLongerWaiting: StatusWait[];
	/**
	 * The newer report's waits list is cut at its row cap, so a row missing from it may still wait:
	 * such rows are left out of `noLongerWaiting` rather than claimed.
	 */
	waitsCut: boolean;
	/** The next release and requirements whose forecast date moved by a day or more. */
	moved: StatusMovedDate[];
}

export interface StatusReportDetail {
	report: StatusReportMeta;
	status: ProjectStatus;
	previous: StatusReportMeta | null;
	/** Null for the first report a project kept. */
	diff: StatusReportDiff | null;
}

/** When a delivery reaches people's hands, as one instant: the shipped time, else the p50 of the forecast; null where a person or a wait holds it. */
export function deliveryDateOf(d: DeliveryForecast | null): string | null {
	if (!d) return null;
	if (d.shipped) return d.shipped.at;
	if (d.inHands) return d.inHands.p50At;
	return d.landing.kind === "forecast" ? d.landing.p50At : null;
}

const waitKey = (w: StatusWait) => `${w.area}:${w.entity}:${w.key}`;
const lateKey = (l: StatusLateItem) => `${l.kind}:${l.key}`;

function movedOf(
	kind: StatusMovedDate["kind"],
	key: string,
	title: string,
	from: string | null,
	to: string | null,
): StatusMovedDate[] {
	if (from === null || to === null) return [];
	const minutes = Math.abs(Date.parse(to) - Date.parse(from)) / 60_000;
	return minutes >= STATUS_DATE_MOVE_MIN_MINUTES
		? [{ kind, key, title, from, to }]
		: [];
}

/** What changed from `prev` to `next`, two stored reports of one project. */
export function statusReportDiff(
	prev: ProjectStatus,
	next: ProjectStatus,
): StatusReportDiff {
	const prevReleases = new Set(
		[prev.shipped.latest, ...prev.shipped.releases].flatMap((r) =>
			r ? [r.version] : [],
		),
	);
	const seen = new Set<string>();
	const shipped = [next.shipped.latest, ...next.shipped.releases]
		.filter((r): r is NonNullable<typeof r> => r !== null)
		.filter((r) => {
			if (prevReleases.has(r.version) || seen.has(r.version)) return false;
			seen.add(r.version);
			return true;
		})
		.map((r) => ({
			version: r.version,
			releasedAt: r.releasedAt,
			issues: r.contents.flatMap((g) =>
				g.issues.map((i) => ({ key: i.key, title: i.title })),
			),
		}));
	const prevReqShipped = new Set(
		prev.shipped.requirementsShipped.map((r) => r.key),
	);
	const prevLate = new Set(prev.late.items.map(lateKey));
	const nextWaits = new Set(next.waits.people.map(waitKey));
	const waitsCut = next.waits.peopleCount > next.waits.people.length;
	const prevItems = new Map(prev.requirements.items.map((r) => [r.key, r]));
	const pr = prev.nextRelease;
	const nr = next.nextRelease;
	// the release nearest people's hands in each report: the same one unless the older one shipped
	// since, even where a release shipped in between renumbered the draft
	const releaseMoved =
		pr.version !== null && nr.version !== null && !seen.has(pr.version)
			? movedOf(
					"release",
					nr.version,
					pr.version === nr.version ? nr.version : `${pr.version} → ${nr.version}`,
					deliveryDateOf(pr.forecast?.delivery ?? null),
					deliveryDateOf(nr.forecast?.delivery ?? null),
				)
			: [];
	return {
		since: prev.asOf,
		shipped,
		requirementsShipped: next.shipped.requirementsShipped
			.filter((r) => !prevReqShipped.has(r.key))
			.map((r) => ({ key: r.key, title: r.title })),
		newlyLate: next.late.items.filter((l) => !prevLate.has(lateKey(l))),
		noLongerWaiting: waitsCut
			? []
			: prev.waits.people.filter((w) => !nextWaits.has(waitKey(w))),
		waitsCut,
		moved: [
			...releaseMoved,
			...next.requirements.items.flatMap((r) => {
				const was = prevItems.get(r.key);
				return was
					? movedOf(
							"requirement",
							r.key,
							r.title,
							deliveryDateOf(was.delivery),
							deliveryDateOf(r.delivery),
						)
					: [];
			}),
		],
	};
}
