// @vitest-environment jsdom
//
// The section's job is to make a mandate decidable, so what it must never do is
// look confident while saying nothing. Every state the read can be in is held
// here — in flight, failed, empty window, populated — because a panel that
// renders a blank row for "couldn't load" is the exact failure the number was
// added to end: a decision argued from an impression.
//
// The save shape is the other half: clearing a stage must DELETE the key, not
// store an empty one, and core's `z.enum` would 400 the empty string anyway.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BodyPolicySection } from "./components/body-policy-section";
import type { BodyAdoptionReport, PipelineConfig } from "./types";

expect.extend(matchers);
afterEach(cleanup);

const mutate = vi.fn();
const reset = vi.fn();
const refetch = vi.fn();

const adoption = {
	isPending: false,
	isError: false,
	isSuccess: true,
	error: null as unknown,
	data: undefined as BodyAdoptionReport | undefined,
	refetch,
};

const components = {
	isPending: false,
	isError: false,
	data: [
		{ name: "forge-outcome", root: true },
		{ name: "forge-review", root: true },
		{ name: "forge-finding", root: false },
	] as unknown[],
};

vi.mock("./hooks", async () => {
	const actual = await vi.importActual<typeof import("./hooks")>("./hooks");
	return {
		...actual,
		useUpdatePipelineConfig: () => ({
			mutate,
			reset,
			isPending: false,
			isError: false,
			error: null,
		}),
		useBodyAdoption: () => adoption,
	};
});

vi.mock("@tanstack/react-query", () => ({
	useQuery: () => components,
}));

const PROJECT = "11111111-1111-4111-8111-111111111111";

const REPORT: BodyAdoptionReport = {
	windowDays: 14,
	since: "2026-08-24T00:00:00.000Z",
	stages: [
		{
			stage: "open",
			total: 4,
			byComponent: { "forge-outcome": 3 },
			requireComponent: null,
			carryingRequired: null,
			fractionRequired: null,
		},
		{
			stage: "in_progress",
			total: 0,
			byComponent: {},
			requireComponent: null,
			carryingRequired: null,
			fractionRequired: null,
		},
		{
			stage: "needs_info",
			total: 0,
			byComponent: {},
			requireComponent: null,
			carryingRequired: null,
			fractionRequired: null,
		},
		{
			stage: "awaiting_release",
			total: 0,
			byComponent: {},
			requireComponent: null,
			carryingRequired: null,
			fractionRequired: null,
		},
	],
};

function renderWith(config: PipelineConfig, canEdit = true) {
	return render(
		<BodyPolicySection projectId={PROJECT} config={config} canEdit={canEdit} />,
	);
}

beforeEach(() => {
	mutate.mockReset();
	reset.mockReset();
	refetch.mockReset();
	adoption.isPending = false;
	adoption.isError = false;
	adoption.isSuccess = true;
	adoption.error = null;
	adoption.data = REPORT;
	components.isPending = false;
	components.isError = false;
});

describe("BodyPolicySection", () => {
	// cm:guard the sentence that says nothing is required until you set it. Without it the picker reads as a description of what IS enforced, and an operator would assume the mandate is already on — which is the one misreading that makes them stop reading the number.
	it("says in copy that nothing is required until it is set here", () => {
		renderWith({});
		expect(
			screen.getByText(/Nothing is\s+required anywhere until you set it here/i),
		).toBeInTheDocument();
	});

	it("says a person writing prose is never refused", () => {
		renderWith({});
		expect(screen.getByText(/never refused/i)).toBeInTheDocument();
	});

	it("shows the fraction carrying a component, per stage, over the window", () => {
		renderWith({});
		expect(screen.getByText(/3 of 4 carry a component \(75%\)/)).toBeInTheDocument();
		expect(screen.getByText(/Last 14 days/i)).toBeInTheDocument();
	});

	// cm:guard the window-empty line must be DISTINCT from a zero fraction. "0%" reads as "agents wrote things and none were typed"; the truth at a silent stage is that nothing was written at all, and the two lead to opposite decisions.
	it("says a stage's window is empty rather than showing it as 0%", () => {
		renderWith({});
		expect(
			screen.getAllByText(/no agent comments in the window/i).length,
		).toBeGreaterThan(0);
	});

	it("renders a skeleton while the number is in flight", () => {
		adoption.isPending = true;
		adoption.isSuccess = false;
		adoption.data = undefined;
		const { container } = renderWith({});
		expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
		expect(screen.queryByText(/carry a component/)).toBeNull();
	});

	it("renders an error with a retry when the number cannot be read", () => {
		adoption.isPending = false;
		adoption.isSuccess = false;
		adoption.isError = true;
		adoption.error = new Error("upstream is down");
		adoption.data = undefined;
		renderWith({});
		const retry = screen.getByRole("button", { name: /retry/i });
		fireEvent.click(retry);
		expect(refetch).toHaveBeenCalled();
	});

	it("offers only ROOT components — a slot can never be a body's root", () => {
		renderWith({});
		const select = screen.getByLabelText(/Component required at Open/i);
		const values = Array.from(
			select.querySelectorAll("option"),
			(o) => (o as HTMLOptionElement).value,
		);
		expect(values).toContain("forge-outcome");
		expect(values).not.toContain("forge-finding");
	});

	it("shows a stage's declared requirement and how much of it is met", () => {
		adoption.data = {
			...REPORT,
			stages: REPORT.stages.map((s) =>
				s.stage === "open"
					? {
							...s,
							requireComponent: "forge-outcome",
							carryingRequired: 3,
							fractionRequired: 0.75,
						}
					: s,
			),
		};
		renderWith({
			states: { open: { bodyPolicy: { requireComponent: "forge-outcome" } } },
		});
		expect(
			screen.getByText(/3 of 4 carry forge-outcome \(75%\)/),
		).toBeInTheDocument();
	});

	it("saves a required component under the stage that asked for it", () => {
		renderWith({ enabled: true });
		fireEvent.change(screen.getByLabelText(/Component required at Open/i), {
			target: { value: "forge-outcome" },
		});
		fireEvent.click(screen.getByRole("button", { name: /save body policy/i }));
		expect(mutate).toHaveBeenCalledTimes(1);
		const sent = mutate.mock.calls[0]?.[0] as PipelineConfig;
		expect(sent.states?.open?.bodyPolicy).toEqual({
			requireComponent: "forge-outcome",
		});
		expect(sent.enabled).toBe(true);
	});

	// cm:guard clearing must remove the key. `{ requireComponent: "" }` is a second spelling of "off" that reads as configured on the next screen that looks, and core refuses the empty string, so the save would 400 instead.
	it("removes the key when a stage is cleared rather than storing an empty one", () => {
		renderWith({
			states: {
				open: { enabled: true, bodyPolicy: { requireComponent: "forge-outcome" } },
			},
		});
		fireEvent.change(screen.getByLabelText(/Component required at Open/i), {
			target: { value: "" },
		});
		fireEvent.click(screen.getByRole("button", { name: /save body policy/i }));
		const sent = mutate.mock.calls[0]?.[0] as PipelineConfig;
		expect(sent.states?.open).toEqual({ enabled: true });
		expect("bodyPolicy" in (sent.states?.open ?? {})).toBe(false);
	});

	it("keeps the save disabled until something actually changed", () => {
		renderWith({});
		expect(
			screen.getByRole("button", { name: /save body policy/i }),
		).toBeDisabled();
	});

	it("offers no save at all to a reader who cannot edit", () => {
		renderWith({}, false);
		expect(screen.queryByRole("button", { name: /save body policy/i })).toBeNull();
	});

	it("says the picker is empty when the component list could not be read", () => {
		components.isError = true;
		components.data = [];
		renderWith({});
		expect(
			screen.getByText(/Couldn’t load the component list/i),
		).toBeInTheDocument();
	});
});
