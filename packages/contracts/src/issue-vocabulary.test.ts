import { describe, expect, it } from "vitest";
import {
	AUTONOMOUS_LABELS,
	type AutonomousLabel,
	LABEL_TO_KERNEL,
	renderStatus,
	statusesForLabels,
	toAutonomousLabel,
} from "./issue-vocabulary.js";
import { REGISTRY_ISSUE_STATUSES } from "./pipeline-registry.js";

describe("toAutonomousLabel", () => {
	// cm:guard a kernel status with no label renders as a blank cell on the board, which nobody reports as a bug — so the map must be total over the enum, not over the statuses the driver happens to write
	it("has a label for every kernel status, including ones the driver never writes", () => {
		for (const status of REGISTRY_ISSUE_STATUSES) {
			expect(AUTONOMOUS_LABELS).toContain(toAutonomousLabel(status));
		}
	});

	it("collapses the whole staged middle into running", () => {
		for (const status of [
			"confirmed",
			"approved",
			"developed",
			"testing",
		] as const) {
			expect(toAutonomousLabel(status)).toBe("running");
		}
	});

	it("collapses the two statuses that ask a human into needs_human", () => {
		for (const status of ["waiting", "needs_info"] as const) {
			expect(toAutonomousLabel(status)).toBe("needs_human");
		}
	});

	// cm:guard ISS-970 — a deliberate pause must NOT read as a question. `on_hold` is set by `cancel` with the `parkIssue: true` default on every duplicate run, so folding it in here manufactures a "needs a human" row per cancellation: 3 cancels on 2026-09-07 produced 3 alarms and 0 questions. It is the negative case, and it is the one that would have caught the bug.
	it("reads a deliberate pause as paused, never as a question for a human", () => {
		expect(toAutonomousLabel("on_hold")).toBe("paused");
		expect(toAutonomousLabel("on_hold")).not.toBe("needs_human");
	});

	// cm:guard done and dropped must never collapse into each other: closing stamps merged_at and dropping does not, which is the only difference the kernel actually enforces between them
	it("keeps done and dropped apart", () => {
		expect(toAutonomousLabel("closed")).toBe("done");
		expect(toAutonomousLabel("dropped")).toBe("dropped");
	});

	// cm:guard ISS-897 moved the release park from `tested` to `released`, and BOTH must read as awaiting_release: the migration moved 74 live issues, and any row written before it — or by a client still on the old literal — is at `tested` and must not render as a running session nobody is running.
	it("reads either release park as its own label, not as running", () => {
		expect(toAutonomousLabel("released")).toBe("awaiting_release");
		expect(toAutonomousLabel("tested")).toBe("awaiting_release");
	});

	// cm:guard neither `running` nor `open`: ISS-141 rendered `reopen` as `running` with no session alive and none starting, and `open` is the label that promises a dispatcher. Nothing dispatches at `reopen` since the `reopen → open` rewrite was retired 2026-09-10 — a person routes it — so it owns a label and the third assertion holds it out of the bucket `needs_human` feeds.
	it("reads reopen as a close somebody disputed, not as a session or a queue", () => {
		expect(toAutonomousLabel("reopen")).toBe("reopened");
		expect(toAutonomousLabel("reopen")).not.toBe("open");
		expect(statusesForLabels("needs_human")).not.toContain("reopen");
	});
});

describe("LABEL_TO_KERNEL", () => {
	it("writes every label to a status the kernel enum defines", () => {
		for (const label of AUTONOMOUS_LABELS) {
			expect(REGISTRY_ISSUE_STATUSES).toContain(LABEL_TO_KERNEL[label]);
		}
	});

	it("round-trips every label through the kernel and back", () => {
		for (const label of AUTONOMOUS_LABELS) {
			expect(toAutonomousLabel(LABEL_TO_KERNEL[label])).toBe(
				label as AutonomousLabel,
			);
		}
	});
});

describe("renderStatus", () => {
	// cm:guard there is ONE vocabulary since ISS-897 removed the lane switch, so this takes no mode argument. Re-adding one means re-adding `pipelineConfig.mode` to the settings surface and the project rows, which that issue deleted on all 38 projects.
	it("labels every status without asking the project", () => {
		expect(renderStatus("in_progress")).toBe("running");
		expect(renderStatus("needs_info")).toBe("needs_human");
		expect(renderStatus("released")).toBe("awaiting_release");
	});
});

describe("statusesForLabels", () => {
	// cm:guard this is the reader every client uses INSTEAD of hand-copying a status tuple, which is the drift ISS-970 was filed about — three surfaces each held their own list and one of them was wrong.
	it("answers with exactly the statuses carrying the labels asked for", () => {
		expect(statusesForLabels("needs_human")).toEqual(["waiting", "needs_info"]);
		expect(statusesForLabels("paused")).toEqual(["on_hold"]);
		expect(statusesForLabels("needs_human", "paused")).toEqual([
			"waiting",
			"on_hold",
			"needs_info",
		]);
	});

	it("answers with nothing when no status carries the label", () => {
		expect(statusesForLabels()).toEqual([]);
	});

	it("returns statuses in the map's own order, not the caller's", () => {
		expect(statusesForLabels("paused", "needs_human")).toEqual(
			statusesForLabels("needs_human", "paused"),
		);
	});
});
