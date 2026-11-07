// The forge-plugin's version handshake (ISS-1104). Core and the plugin ship on two clocks, so a
// plugin client names its version on every request, and core warns rather than refuses where it
// has narrowed a shape that plugin version still sends.
import type { RefusalStatuses } from "./refusal.js";

/**
 * The header a plugin client names its own version in on every request: `x-forge-plugin: 3.36.681`.
 * Optional; where it is sent it is a semantic version ({@link PLUGIN_VERSION_SHAPE}), and any other
 * value is refused `PLUGIN_VERSION_MALFORMED`.
 */
export const PLUGIN_VERSION_HEADER = "x-forge-plugin";

/**
 * The response header a write let through on a narrowed shape carries, one value per narrowing:
 * `x-forge-warning: <CODE>: <detail>`. The write took effect; the shape it used is one a newer
 * plugin no longer sends.
 */
export const FORGE_WARNING_HEADER = "x-forge-warning";

/** At most this many characters are read as a version; a longer value is malformed. */
export const PLUGIN_VERSION_MAX_LENGTH = 64;

export const PLUGIN_VERSION_SHAPE =
	"a semantic version MAJOR.MINOR.PATCH with no leading zeros, e.g. 3.36.681, optionally -PRERELEASE (dot-separated [0-9A-Za-z-] identifiers, e.g. 3.37.0-rc.1) and +BUILD";

const IDENT = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = new RegExp(
	`^(0|[1-9]\\d{0,8})\\.(0|[1-9]\\d{0,8})\\.(0|[1-9]\\d{0,8})(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

export interface PluginVersion {
	major: number;
	minor: number;
	patch: number;
	/** The prerelease identifiers, empty for a release. Build metadata is not kept: it has no order. */
	pre: readonly string[];
}

/** The version a header value names, or null where it is not {@link PLUGIN_VERSION_SHAPE}. */
export function parsePluginVersion(text: string): PluginVersion | null {
	if (text.length > PLUGIN_VERSION_MAX_LENGTH) return null;
	const m = SEMVER.exec(text);
	if (!m) return null;
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3]),
		pre: m[4] === undefined ? [] : m[4].split("."),
	};
}

function compareIdent(a: string, b: string): number {
	const [an, bn] = [/^\d+$/.test(a), /^\d+$/.test(b)];
	if (an && bn) return Number(a) - Number(b);
	if (an !== bn) return an ? -1 : 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semantic-version precedence, field by field and never the lexical order of the two strings: a
 * prerelease sorts below the release it previews (3.37.0-rc.1 < 3.37.0).
 */
export function comparePluginVersions(
	a: PluginVersion,
	b: PluginVersion,
): number {
	const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
	if (core !== 0) return core;
	if (a.pre.length === 0 || b.pre.length === 0) {
		return (a.pre.length === 0 ? 0 : -1) + (b.pre.length === 0 ? 0 : 1);
	}
	for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
		const d = compareIdent(a.pre[i] as string, b.pre[i] as string);
		if (d !== 0) return d;
	}
	return a.pre.length - b.pre.length;
}

export const PLUGIN_VERSION_REFUSAL_CODES = [
	"PLUGIN_VERSION_MALFORMED",
] as const;
export type PluginVersionRefusalCode =
	(typeof PLUGIN_VERSION_REFUSAL_CODES)[number];

export const PLUGIN_VERSION_REFUSAL_STATUSES = {
	PLUGIN_VERSION_MALFORMED: 400,
} as const satisfies RefusalStatuses<PluginVersionRefusalCode>;
