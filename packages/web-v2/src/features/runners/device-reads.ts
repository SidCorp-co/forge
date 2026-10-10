// What a device reported about its own condition — its declaration gate, its pane binaries and its
// scratch disk — and the lines a device screen says about each.
import { formatNumber } from "@/lib/i18n/format";
import { productCopy } from "@/lib/i18n/product-copy";

/** What a box reported about its own declaration gate. */
export interface DeviceGate {
	verdict: "clear" | "marked" | "failing_open";
	count: number;
	trimmed: boolean;
	perDay: number | null;
	windowMs: number | null;
	sinceLastMs: number | null;
	byReason: Array<{ reason: string; count: number }>;
	/** When core heard this, which is what says whether it is still the box's present condition. */
	receivedAt: string;
}

export interface DeviceGateBanner {
	count: number;
	rate: string;
	window: string;
	reason: string | null;
	/** Present where the report is old enough that it may no longer be true. */
	stale: string | null;
}

/**
 * Past this, a stored report is not the box's present condition. A box that
 * stopped heartbeating leaves its last report standing, and a banner that read
 * it as current would rebuild the very defect this reports (ISS-1192).
 */
const REPORT_FRESH_FOR_MS = 10 * 60 * 1000;

function asSpan(ms: number | null, language: string): string {
	const t = productCopy(language);
	if (ms === null) return t("runners.span.unknown");
	const mins = Math.round(ms / 60_000);
	if (mins < 60) return t("common.age.minutes", { n: mins });
	const hours = Math.round(mins / 60);
	if (hours < 48) return t("common.age.hours", { n: hours });
	return t("common.age.days", { n: Math.round(hours / 24) });
}

const staleLine = (age: number, language: string) => productCopy(language)("runners.stale", { age: asSpan(age, language) });

type ReasonCount = DeviceGate["byReason"][number];

/**
 * The largest count, taken rather than assumed. The box sorts its breakdown, but
 * nothing between there and here declares that order, and a banner naming the
 * wrong cause sends an operator at the wrong remedy (ISS-1192).
 */
function commonestReason(by: ReasonCount[]): ReasonCount | undefined {
	return by.reduce<ReasonCount | undefined>((best, r) => {
		if (best === undefined) return r;
		if (r.count !== best.count) return r.count > best.count ? r : best;
		return r.reason < best.reason ? r : best;
	}, undefined);
}

/**
 * The commonest reason with its share of the count. Bare, a reason standing for
 * 141 of 149 reads as the reason for all of them (ISS-1192).
 */
export function gateReasonLine(by: ReasonCount[], count: number, language: string): string | null {
	const t = productCopy(language);
	const top = commonestReason(by);
	if (top === undefined) return null;
	if (top.count === count) return t("runners.gate.reasonAll", { reason: top.reason });
	return t("runners.gate.reasonSome", { n: top.count, count, reason: top.reason });
}

/** The banner, or `null` for a box whose gate is deciding. */
export function deviceGateBanner(
	gate: DeviceGate | null,
	language: string,
	now: number = Date.now(),
): DeviceGateBanner | null {
	if (gate?.verdict !== "failing_open") return null;
	const t = productCopy(language);
	const age = now - Date.parse(gate.receivedAt);
	return {
		count: gate.count,
		rate: gate.perDay === null ? t("runners.gate.rateUnstated") : t("runners.gate.perDay", { n: Math.round(gate.perDay) }),
		window: asSpan(gate.windowMs, language),
		reason: gateReasonLine(gate.byReason, gate.count, language),
		stale: Number.isNaN(age) || age <= REPORT_FRESH_FOR_MS ? null : staleLine(age, language),
	};
}

/** What a box reported about the binaries its panes need. */
export interface DeviceBinaries {
	missing: Array<{ name: string; detail: string }>;
	/** When core heard this, which is what says whether it is still the box's present condition. */
	receivedAt: string;
}

/** What a device screen says about its pane binaries. */
export interface DeviceBinariesRead {
	/** `unreported` is a box whose build sends no report, never one that resolves everything. */
	state: "unreported" | "resolved" | "missing";
	missing: DeviceBinaries["missing"];
	/** Present where the report is old enough that it may no longer be true. */
	stale: string | null;
}

export function deviceBinariesRead(
	binaries: DeviceBinaries | null,
	language: string,
	now: number = Date.now(),
): DeviceBinariesRead {
	if (binaries === null) return { state: "unreported", missing: [], stale: null };
	const age = now - Date.parse(binaries.receivedAt);
	return {
		state: binaries.missing.length > 0 ? "missing" : "resolved",
		missing: binaries.missing,
		stale: Number.isNaN(age) || age <= REPORT_FRESH_FOR_MS ? null : staleLine(age, language),
	};
}

export type DiskVerdict = "clear" | "unmeasurable" | "tight" | "critical";

/** One scratch root as core judged it: the box's figures, or why it had none. */
export interface DiskRootRead {
	root: string;
	bytesFree?: number;
	bytesTotal?: number;
	inodesFree?: number;
	inodesTotal?: number;
	refused?: string;
	bytesFreePercent: number | null;
	inodesFreePercent: number | null;
	verdict: DiskVerdict;
	axis: "bytes" | "inodes" | null;
}

export interface DeviceDisk {
	receivedAt: string;
	verdict: DiskVerdict;
	roots: DiskRootRead[];
	tightFreePercent: number;
	criticalFreePercent: number;
}

/** One root as a line: both axes, so the one that did not cross is read beside the one that did. */
export function diskRootLine(r: DiskRootRead, language: string): string {
	const t = productCopy(language);
	if (r.refused !== undefined) return t("runners.disk.unread", { why: r.refused });
	const bytes =
		r.bytesFreePercent === null
			? t("runners.disk.bytesNoTotal")
			: t("runners.disk.bytes", { pct: r.bytesFreePercent, free: binarySize(r.bytesFree ?? 0), total: binarySize(r.bytesTotal ?? 0) });
	const inodes =
		r.inodesFreePercent === null
			? t("runners.disk.inodesNoTotal")
			: t("runners.disk.inodes", { pct: r.inodesFreePercent, free: formatNumber(r.inodesFree ?? 0, language), total: formatNumber(r.inodesTotal ?? 0, language) });
	return `${bytes} · ${inodes}`;
}

function binarySize(bytes: number): string {
	const units = ["E", "P", "T", "G", "M", "K"] as const;
	for (const [i, unit] of units.entries()) {
		const scale = 1024 ** (units.length - i);
		if (bytes >= scale) return `${(bytes / scale).toFixed(1)}${unit}`;
	}
	return `${bytes}B`;
}

/** Where the disk report is old enough that it may no longer be the box's present condition. */
export function deviceDiskStale(disk: DeviceDisk, language: string, now: number = Date.now()): string | null {
	const age = now - Date.parse(disk.receivedAt);
	return Number.isNaN(age) || age <= REPORT_FRESH_FOR_MS ? null : staleLine(age, language);
}
