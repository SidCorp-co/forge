// @vitest-environment jsdom
//
// The knob's single most misreadable claim is that admitting a status makes it
// run — it does not. These tests hold the copy that says so, the save shape
// (absent key, not an empty array), and the two places the `intakeGate`
// contradiction has to be readable: before the save, and in the server's own
// refusal if it arrives anyway.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { PoolBacklogSection } from "./components/pool-backlog-section";
import type { PipelineConfig } from "./types";

expect.extend(matchers);
afterEach(cleanup);

const mutate = vi.fn();
const reset = vi.fn();
const state = {
	isPending: false,
	isError: false,
	isSuccess: false,
	error: null as unknown,
};

vi.mock("./hooks", async () => {
	const actual = await vi.importActual<typeof import("./hooks")>("./hooks");
	return {
		...actual,
		useUpdatePipelineConfig: () => ({ mutate, reset, ...state }),
	};
});

const PROJECT = "11111111-1111-4111-8111-111111111111";

function renderWith(config: PipelineConfig) {
	return render(
		<PoolBacklogSection projectId={PROJECT} config={config} canEdit={true} />,
	);
}

beforeEach(() => {
	mutate.mockReset();
	reset.mockReset();
	state.isPending = false;
	state.isError = false;
	state.isSuccess = false;
	state.error = null;
});

describe("PoolBacklogSection", () => {
	// cm:guard AC12 — the copy that admitting a status does NOT make it run is the one sentence this screen cannot lose. Without it the toggle reads as "start drafts automatically", which is the design ISS-917 rejected, and an operator would turn it on expecting exactly that.
	it("states in copy that admitting a status does not make it run", () => {
		renderWith({});
		expect(
			screen.getByText(/does not make it run/i, { exact: false }),
		).toBeInTheDocument();
	});

	it("is off for a project that declared no backlog", () => {
		renderWith({});
		const toggle = screen.getByRole("switch", { name: /show a backlog/i });
		expect(toggle).not.toBeChecked();
		expect(screen.queryByLabelText(/rows a master may read/i)).toBeNull();
	});

	it("shows the admitted statuses and the row limit for a project that declared one", () => {
		renderWith({ poolBacklog: { statuses: ["draft"], limit: 7 } });
		expect(
			screen.getByRole("switch", { name: /show a backlog/i }),
		).toBeChecked();
		expect(screen.getByLabelText(/rows a master may read/i)).toHaveValue(7);
	});

	// cm:guard clearing the selection must write the key ABSENT, never `{ statuses: [] }`. Absent is the documented "no backlog" state every other project is in; a stored empty object is a second spelling of it that the next screen reads as "configured".
	it("deletes the key rather than saving an empty statuses array", () => {
		renderWith({
			enabled: true,
			poolBacklog: { statuses: ["draft"], limit: 7 },
		});
		fireEvent.click(screen.getByRole("switch", { name: /show a backlog/i }));
		fireEvent.click(
			screen.getByRole("button", { name: /save master backlog/i }),
		);
		expect(mutate).toHaveBeenCalledTimes(1);
		const sent = mutate.mock.calls[0]?.[0] as PipelineConfig;
		expect(sent).not.toHaveProperty("poolBacklog");
		expect(sent.enabled).toBe(true);
	});

	it("preserves sibling keys the screen does not edit", () => {
		renderWith({
			enabled: true,
			intakeGate: { enabled: false },
			poolBacklog: { statuses: ["draft"], limit: 7 },
		});
		fireEvent.change(screen.getByLabelText(/rows a master may read/i), {
			target: { value: "9" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: /save master backlog/i }),
		);
		const sent = mutate.mock.calls[0]?.[0] as PipelineConfig;
		expect(sent.poolBacklog).toEqual({ statuses: ["draft"], limit: 9 });
		expect(sent.intakeGate).toEqual({ enabled: false });
	});

	// cm:guard AC12/B5 — the contradiction is shown BEFORE the save and the save is blocked, so the reason reads as a rule of the product rather than as a rejected request. Letting it through would answer a rule with a round trip.
	it("names the intakeGate contradiction and refuses to save it", () => {
		renderWith({
			intakeGate: { enabled: true },
			poolBacklog: { statuses: ["draft"] },
		});
		expect(screen.getByText(/intake gate is on/i)).toBeInTheDocument();
		// cm:why dirty the form first, so the disabled Save below can only be the conflict — an untouched form is disabled anyway and would prove nothing
		fireEvent.change(screen.getByLabelText(/rows a master may read/i), {
			target: { value: "9" },
		});
		expect(
			screen.getByRole("button", { name: /save master backlog/i }),
		).toBeDisabled();
	});

	it("says nothing about the intake gate when the admitted status is not draft", () => {
		renderWith({
			intakeGate: { enabled: true },
			poolBacklog: { statuses: ["on_hold"] },
		});
		expect(screen.queryByText(/intake gate is on/i)).toBeNull();
	});

	// cm:guard the server's refusal must arrive as its own sentence, not as a zod path. `CONFIG_CONFLICT` and the `superRefine` message inside a BAD_REQUEST both already name the two settings; rendering "Invalid input" throws that away at the one moment the operator needs it.
	it("renders a server refusal as its readable reason, not a raw zod dump", () => {
		state.isError = true;
		state.error = new ApiError(
			400,
			"intakeGate is on, which parks every new issue at `draft` for a human to approve",
			"CONFIG_CONFLICT",
		);
		renderWith({ poolBacklog: { statuses: ["draft"] } });
		expect(screen.getByText(/intakeGate is on/)).toBeInTheDocument();
		expect(screen.queryByText(/Invalid input/)).toBeNull();
	});

	it("shows the save as pending while the mutation is in flight", () => {
		state.isPending = true;
		renderWith({ poolBacklog: { statuses: ["draft"], limit: 7 } });
		expect(
			screen.getByRole("button", { name: /save master backlog/i }),
		).toBeDisabled();
	});

	it("hides every control for a viewer who cannot edit", () => {
		render(
			<PoolBacklogSection
				projectId={PROJECT}
				config={{ poolBacklog: { statuses: ["draft"] } }}
				canEdit={false}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: /save master backlog/i }),
		).toBeNull();
		expect(
			screen.getByRole("switch", { name: /show a backlog/i }),
		).toBeDisabled();
	});
});
