// One rule for a verdict judged on a release (ISS-900, FB-479): on a project whose production names no
// commit it serves (no source probe: its releases are its agent's record by version, agenfold's owner
// rule `release-is-the-agents-record`), a verdict names the release version it was judged on, and
// counts while that release, or a later one the record carries, is what the record says is live. The
// issue's verdict door and weighing, the release hold and a requirement's coverage and verdict door all
// read this one rule. Nothing here reads production, and no commit is compared.

/**
 * A project's shipped releases as its record carries them, where its production names no commit it
 * serves: `why` says so, `live` is the highest version shipped on production's branch, the one the
 * record says is live, never the record written last (null where none shipped), and per shipped version when it shipped and whether the live one carries it (core
 * `release-batch/released-line.ts:releasedLineOf`).
 */
export interface ReleasedLine {
	why: string;
	live: { version: string; at: Date } | null;
	/**
	 * Per shipped version: when it shipped, whether the live release carries it, and every earlier
	 * version it carries itself (shipped no later, at no higher a version), one rule for both.
	 */
	shipped: ReadonlyMap<
		string,
		{
			at: Date;
			carried: boolean;
			carries: readonly string[];
			/** The issues its own record names (ISS-957); absent where the reader did not list them. */
			issueIds?: readonly string[];
			/**
			 * Of those, the ones reopened since it claimed them and re-landed since, or with no landing
			 * standing now (ISS-967, ISS-971): it carried an earlier round of each, never the fix
			 * re-landed after, so it holds none of them (`releaseHoldsIssue`). One reopened with its
			 * landing unchanged is not listed: the release still holds the landing it shipped.
			 */
			reworked?: readonly string[];
		}
	>;
}

/** Whether a verdict judged on a release counts, and if not why; `countedAs` where a later release carries it. */
export interface ReleaseReading {
	/** Whether the release the record says is live carries it; null where nothing places it. */
	inLiveBuild: boolean | null;
	notCounted: string | null;
	countedAs?: string;
}

/**
 * A verdict judged on release `version`: it counts while that release, or a later one the record
 * carries, is the one the record says is live (`ReleasedLine.shipped[].carried`). On a project whose
 * production reads the commit it serves (`line` absent) no version is placed, so it does not count,
 * saying why: there a verdict names the commit judged.
 */
export function readOnRelease(
	version: string,
	line: ReleasedLine | null | undefined,
): ReleaseReading {
	const judged = `judged on release ${version}`;
	const none = (inLiveBuild: boolean | null, why: string): ReleaseReading => ({
		inLiveBuild,
		notCounted: `${judged}, ${why}`,
	});
	if (!line) {
		return none(
			null,
			"and this project reads the commit its production serves, so a verdict there names the commit judged",
		);
	}
	if (!line.live)
		return none(null, `and no release is recorded as shipped: ${line.why}`);
	const shipped = line.shipped.get(version);
	if (!shipped) {
		return none(
			null,
			`which no release this project recorded as shipped names; release ${line.live.version} is what its record says is live`,
		);
	}
	if (!shipped.carried) {
		return none(
			false,
			`and it was recorded after release ${line.live.version}, the highest version shipped and what the record says is live, so nothing says ${line.live.version} carries it: judge it again on release ${line.live.version}`,
		);
	}
	if (version === line.live.version)
		return { inLiveBuild: true, notCounted: null };
	return {
		inLiveBuild: true,
		notCounted: null,
		countedAs: `release ${version}, carried by live release ${line.live.version}`,
	};
}

/**
 * Whether release `version` holds issue `issueId` by the record (ISS-957): its own record names the
 * issue, or the record of an earlier release it carries does, for the round the issue stands in now.
 * A release recorded before an issue landed names none of it, so a verdict judged on it judged a build
 * without the change; one that shipped the issue before its last reopen and its re-land since carried
 * the round the reopen rejected, never the fix re-landed (ISS-967, `ShippedOnLine.reworked`), while a
 * reopen that left the landing unchanged leaves it held (ISS-971). Null where the line
 * lists no issues for its releases, so nothing places it.
 */
export function releaseHoldsIssue(
	line: ReleasedLine | null | undefined,
	version: string,
	issueId: string,
): boolean | null {
	const read = roundsOn(line, version, issueId);
	return read === null ? null : read.current;
}

/**
 * Why release `version` does not hold issue `issueId` (`releaseHoldsIssue` false), in the words a
 * verdict judged on it is refused with: it carried a round the issue was reopened from since, or its
 * record names none of the issue because the change landed after it.
 */
export function releaseNotHoldingWhy(
	line: ReleasedLine | null | undefined,
	version: string,
	issueId: string,
): string {
	return roundsOn(line, version, issueId)?.earlier
		? `judged on release ${version}, which carried this issue before it was reopened, not the fix landed since`
		: `judged on release ${version}, whose record does not hold this issue: the change landed after it`;
}

/** What release `version` and every one it carries hold of `issueId`: its current round, or only an earlier one. */
function roundsOn(
	line: ReleasedLine | null | undefined,
	version: string,
	issueId: string,
): { current: boolean; earlier: boolean } | null {
	const shipped = line?.shipped.get(version);
	if (!line || !shipped?.issueIds) return null;
	const id = issueId.toLowerCase();
	const has = (list: readonly string[] | undefined) =>
		list?.some((i) => i.toLowerCase() === id) ?? false;
	let current = false;
	let earlier = false;
	for (const v of [version, ...shipped.carries]) {
		const held = line.shipped.get(v);
		if (!has(held?.issueIds)) continue;
		if (has(held?.reworked)) earlier = true;
		else current = true;
	}
	return { current, earlier };
}

/**
 * The release a judge judges issue `issueId` on, where its production names no commit it serves: the
 * one the record says is live, once it holds the issue's current round (`releaseHoldsIssue`). Null
 * where no live release holds it yet, a reopened issue's re-landed fix included, so no release can be
 * named: the issue is judged at its landing, or after the release that carries it ships.
 */
export function liveReleaseHolding(
	line: ReleasedLine | null | undefined,
	issueId: string,
): string | null {
	const live = line?.live?.version;
	if (!live) return null;
	return releaseHoldsIssue(line, live, issueId) === true ? live : null;
}

/**
 * The release versions a verdict may name and count on release `version`: that release, and every one
 * the record says it carries (`ReleasedLine.shipped[].carries`). Empty with no version; the release
 * alone where no line is read.
 */
export function versionsCountedOn(
	line: ReleasedLine | null | undefined,
	version: string | null,
): ReadonlySet<string> {
	if (version === null) return new Set();
	return new Set([version, ...(line?.shipped.get(version)?.carries ?? [])]);
}

/** Why a release a verdict names is refused: no version, no place for one, or none recorded. */
export type ReleaseIdentityFault = "shape" | "unused" | "unknown";

/**
 * The version a verdict judged on a release names, as the record stores it, or why it is refused,
 * where it sits in the body and in words naming `subject` (`BC-2`, `criterion 3`). `line` is the
 * project's release line, null where its production reads the commit it serves or it declares none;
 * `versionOf` reads a version as the record stores it (`v0.76.0` → `0.76.0`).
 */
export function releaseIdentityOf(
	subject: string,
	sent: string,
	line: ReleasedLine | null,
	versionOf: (text: string) => string | null,
):
	| { version: string }
	| { fault: ReleaseIdentityFault; path: string; detail: string } {
	const version = versionOf(sent);
	if (!version) {
		return {
			fault: "shape",
			path: "/identity/version",
			detail: `${subject} names release \`${sent}\`, which is no release version: send MAJOR.MINOR.PATCH (e.g. 0.76.0), with or without a leading \`v\`, as the app reported it.`,
		};
	}
	if (!line) {
		return {
			fault: "unused",
			path: "/identity/kind",
			detail: `${subject} names release ${version}, and this project's production reads the commit it serves (or it declares no production environment), so a verdict there names the commit judged: send { kind: 'commit', sha: <40 hex> }.`,
		};
	}
	if (!line.shipped.has(version)) {
		return {
			fault: "unknown",
			path: "/identity/version",
			detail: line.live
				? `${subject} names release ${version}, and this project recorded no release shipped under it; its record says ${line.live.version} is live: name the version the app reported, or record that release first (POST /api/projects/:id/release-records).`
				: `${subject} names release ${version}, and this project has recorded no release as shipped yet: record the release production serves first (POST /api/projects/:id/release-records), then judge it.`,
		};
	}
	return { version };
}

/**
 * Where a commit or runtime judged on a project whose production names no commit does not count, the
 * act that can count: a judgement on the release the record says is live, named on the issue for an
 * issue criterion and at the requirement for a verdict there, or, with none recorded, the record
 * itself. Null on any other project.
 */
export function releaseHint(
	line: ReleasedLine | null | undefined,
	where: "issue" | "requirement",
): string | null {
	if (!line) return null;
	if (!line.live)
		return `${line.why}, and none is recorded yet: record the release production serves (POST /api/projects/:id/release-records { issueIds, version, account }), then judge each criterion on it`;
	const at = where === "issue" ? "on the issue" : "at the requirement";
	return `${line.why}: judge it on release ${line.live.version}, naming \`{ kind: 'release', version: '${line.live.version}' }\` ${at}`;
}
