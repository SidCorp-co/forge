import { describe, expect, it } from "vitest";
import {
	AUTONOMOUS_LABELS,
	type AutonomousLabel,
	LABEL_TO_KERNEL,
	readPipelineMode,
	renderStatus,
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
			"released",
		] as const) {
			expect(toAutonomousLabel(status)).toBe("running");
		}
	});

	it("collapses the three parked statuses into needs_human", () => {
		for (const status of ["waiting", "on_hold", "needs_info"] as const) {
			expect(toAutonomousLabel(status)).toBe("needs_human");
		}
	});

	// cm:guard done and dropped must never collapse into each other: closing stamps merged_at and dropping does not, which is the only difference the kernel actually enforces between them
	it("keeps done and dropped apart", () => {
		expect(toAutonomousLabel("closed")).toBe("done");
		expect(toAutonomousLabel("dropped")).toBe("dropped");
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
	it("leaves a staged project reading exactly as it does today", () => {
		expect(renderStatus("in_progress", "staged")).toBe("in_progress");
		expect(renderStatus("in_progress", undefined)).toBe("in_progress");
		expect(renderStatus("needs_info", "something-else")).toBe("needs_info");
	});

	it("relabels only under autonomous", () => {
		expect(renderStatus("in_progress", "autonomous")).toBe("running");
	});
});

describe("readPipelineMode", () => {
	it("reads the mode a project declared", () => {
		expect(readPipelineMode({ pipelineConfig: { mode: "autonomous" } })).toBe(
			"autonomous",
		);
	});

	// cm:guard absent must read as staged, not as unknown — a board that relabels on a malformed config tells an operator their project runs a driver it does not
	it("treats anything malformed or absent as no declaration", () => {
		expect(readPipelineMode({ pipelineConfig: { mode: 42 } })).toBeUndefined();
		expect(readPipelineMode({ pipelineConfig: null })).toBeUndefined();
		expect(readPipelineMode({})).toBeUndefined();
		expect(readPipelineMode(null)).toBeUndefined();
		expect(readPipelineMode("nope")).toBeUndefined();
	});
});
