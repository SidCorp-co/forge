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

	it("reads a deliberate pause as paused, never as a question for a human", () => {
		expect(toAutonomousLabel("on_hold")).toBe("paused");
		expect(toAutonomousLabel("on_hold")).not.toBe("needs_human");
	});

	it("keeps done and dropped apart", () => {
		expect(toAutonomousLabel("closed")).toBe("done");
		expect(toAutonomousLabel("dropped")).toBe("dropped");
	});

	it("reads either release park as its own label, not as running", () => {
		expect(toAutonomousLabel("awaiting_release")).toBe("awaiting_release");
		expect(toAutonomousLabel("tested")).toBe("awaiting_release");
	});

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
	it("labels every status without asking the project", () => {
		expect(renderStatus("in_progress")).toBe("running");
		expect(renderStatus("needs_info")).toBe("needs_human");
		expect(renderStatus("awaiting_release")).toBe("awaiting_release");
	});
});

describe("statusesForLabels", () => {
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
