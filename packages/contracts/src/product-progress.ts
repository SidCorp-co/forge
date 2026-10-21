// The progress block every requirement and feedback answer of the product layer carries (owner rule
// 2026-10-16: a person is always told whether work is running and when it is forecast to be done).
// Core builds it (`packages/core/src/product-progress/progress.ts:progressOf`) and never computes a date
// of its own; a reader repeats `says` and never gives a date the block does not hold.

import type {
	FORECAST_LABEL,
	ForecastConfidenceLevel,
	ForecastLate,
	IssueProgress,
} from "./forecast.js";
import type { RunState } from "./run-standing.js";

/** A run on the item's work that has not finished, as the Runs screen reads it. */
export interface ProgressRun {
	issue: string | null;
	title: string;
	issueStatus: string | null;
	state: RunState;
	step: string | null;
	since: string | null;
}

/** Something the work waits on before it can go on: who, what they owe, and why. */
export interface ProgressWait {
	who: string;
	act: string;
	why: string;
	ref: string | null;
	/** When the act is due or the wait began, where the read knows it. */
	at: string | null;
	late: boolean;
}

export type ProgressEta =
	| {
			estimate: true;
			/** The forecast's p50: half of similar work was done by then. */
			likelyBy: string;
			/** The forecast's p85. */
			almostSurelyBy: string;
			/** `hands`: in people's hands. `landing`: merged; the release after it is a person's act, so it has no date. */
			of: "hands" | "landing";
			basis: string;
			confidence: ForecastConfidenceLevel | null;
			late: ForecastLate | null;
	  }
	| { estimate: false; done: boolean; why: string };

export interface ProductProgress {
	label: typeof FORECAST_LABEL;
	asOf: string;
	/** A run is working on it right now (claimed or running). */
	running: boolean;
	/** The block in one paragraph, to repeat to the person as it is. */
	says: string;
	/** Its live issues by how far each has got; null where no issue carries it. */
	work: IssueProgress | null;
	runs: ProgressRun[];
	waitingOn: ProgressWait[];
	eta: ProgressEta;
}
