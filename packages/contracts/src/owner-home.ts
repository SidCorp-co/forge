// A person's home (ISS-919, FB-483): across every project they can read, what is moving for what
// they gave and what is live. Core composes it from reads it already serves (feedback with its
// progress block, the issue list and standing, the run standing, the release list) and computes no
// date of its own: `likelyBy` is the forecast's held p50 or null, never a guess (VISION:
// state-never-lies). What waits on the person is `/api/me/attention`'s, not repeated here.

/** How far a moving item has got, read from its carrier issues' status and the runs on them now. */
export const HOME_STAGES = [
	"new",
	"planned",
	"building",
	"landed",
	"releasing",
] as const;
export type HomeStage = (typeof HOME_STAGES)[number];

/** One item the person gave (their feedback) or owns (an issue they filed or hold) that is not live. */
export interface HomeMovingItem {
	kind: "feedback" | "issue";
	/** FB-n or ISS-n: what its link and tooltip name it by, never shown as text. */
	key: string;
	title: string;
	projectSlug: string;
	projectName: string;
	stage: HomeStage;
	/** A run works on it right now (claimed or running). */
	running: boolean;
	/** Who owes the next move and what, as its standing or progress says it; null where nobody is named. */
	owes: { who: string; act: string } | null;
	/** The forecast's held p50 (`progress.eta.likelyBy`, or the issue forecast's), else null. */
	likelyBy: string | null;
	/** Why there is no date, where `likelyBy` is null: the progress block's own words. */
	noDate: string | null;
}

/** A project's latest release on one environment. */
export interface HomeLiveRelease {
	projectSlug: string;
	projectName: string;
	/** `production`: shipped to what production serves. `testing`: landed on a branch production does not serve. */
	environment: "production" | "testing";
	/** The environment's own name where the project names it (its production's name, or the branch). */
	environmentName: string | null;
	version: string;
	/** The release's name, null until written. */
	name: string | null;
	at: string;
	/** How many of the person's items (issues they own, carriers of their feedback) it carried. */
	mine: number;
}

/** `GET /api/me/home`. */
export interface HomeResponse {
	generatedAt: string;
	moving: HomeMovingItem[];
	/** Production first, then testing; newest first inside each. */
	live: HomeLiveRelease[];
}

/** Where a found item stands: live (and where, since when, in which version) or its moving stage. */
export type HomeFoundStanding =
	| {
			kind: "live";
			environment: "production" | "testing";
			version: string;
			since: string;
	  }
	| { kind: "moving"; stage: HomeStage }
	| { kind: "ended"; how: "dropped" | "declined" | "closed" | "answered" };

export interface HomeFoundItem {
	kind: "feedback" | "issue";
	key: string;
	title: string;
	projectSlug: string;
	projectName: string;
	standing: HomeFoundStanding;
}

/** `GET /api/me/home/find?q=`: at most `HOME_FIND_LIMIT` items, by key first, then title. */
export interface HomeFindResponse {
	q: string;
	items: HomeFoundItem[];
}

export const HOME_FIND_LIMIT = 8;
export const HOME_MOVING_LIMIT = 50;
