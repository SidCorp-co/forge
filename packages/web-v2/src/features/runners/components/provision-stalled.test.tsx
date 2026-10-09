// @vitest-environment jsdom
//
// ISS-1359 criterion 8. `cloning` reads the same for a clone running now and one that died, so a
// provision past core's stall window says it is stalled, for how long, and whether it holds
// anything back.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectRunner } from "../types";
import { ProvisionStalledBanner, stalledFor } from "./provision-stalled";

afterEach(cleanup);

const runner = (over: Partial<ProjectRunner> = {}) =>
	({
		provisionStatus: "cloning",
		provisionStalledSeconds: 47 * 60,
		residentMaster: null,
		...over,
	}) as ProjectRunner;

describe("ProvisionStalledBanner", () => {
	it("says stalled, at which step, for how long, and what re-runs it", () => {
		render(<ProvisionStalledBanner runner={runner()} />);

		const text = screen.getByText(/Stalled\./).parentElement?.textContent ?? "";
		expect(text).toContain("Cloning repo for 47 minutes");
		expect(text).toContain("not in progress");
		expect(text).toContain("use Re-provision");
	});

	it("says nothing is held back where the box is serving the project from it", () => {
		render(
			<ProvisionStalledBanner
				runner={runner({
					provisionStalledSeconds: 9 * 86_400,
					residentMaster: { sessionId: "s", name: "forge-master-anhome", lastHeartbeatAt: null },
				})}
			/>,
		);

		const text = screen.getByText(/Stalled\./).parentElement?.textContent ?? "";
		expect(text).toContain("for 9 days");
		expect(text).toContain("nothing is held back");
		expect(text).toContain("refused while that master runs");
	});

	it("says nothing about the box serving the project where core did not report it", () => {
		render(<ProvisionStalledBanner runner={runner({ residentMaster: undefined })} />);

		const text = screen.getByText(/Stalled\./).parentElement?.textContent ?? "";
		expect(text).toContain("not in progress");
		expect(text).not.toContain("Re-provision");
		expect(text).not.toContain("nothing is held back");
	});

	it.each([
		["a recent provision", { provisionStalledSeconds: null }],
		["a core that does not serve the field", { provisionStalledSeconds: undefined }],
		["a row with no provision at all", { provisionStatus: null }],
	])("renders nothing for %s", (_label, over) => {
		const { container } = render(<ProvisionStalledBanner runner={runner(over)} />);

		expect(container.textContent).toBe("");
	});
});

describe("stalledFor", () => {
	it.each([
		[30, "1 minute"],
		[47 * 60, "47 minutes"],
		[2 * 3600, "2 hours"],
		[3600, "1 hour"],
		[9 * 86_400, "9 days"],
	])("%d seconds reads %s", (seconds, said) => {
		expect(stalledFor(seconds)).toBe(said);
	});
});
