import { describe, expect, it } from "vitest";
import {
	AUTONOMOUS_LABELS,
	type AutonomousLabel,
	LABEL_TO_KERNEL,
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

	// cm:guard ISS-897 moved the release park from `tested` to `released`, and BOTH must read as awaiting_release: the migration moved 74 live issues, and any row written before it — or by a client still on the old literal — is at `tested` and must not render as a running session nobody is running.
	it("reads either release park as its own label, not as running", () => {
		expect(toAutonomousLabel("released")).toBe("awaiting_release");
		expect(toAutonomousLabel("tested")).toBe("awaiting_release");
	});

	// cm:guard ISS-141 — `reopen` rendered as `running` while no session existed and none would start; a reopened issue must read as queued work, because that is what the autonomous rewrite makes it
	it("reads reopen as queued work rather than as a live session", () => {
		expect(toAutonomousLabel("reopen")).toBe("open");
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
