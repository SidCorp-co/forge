// @vitest-environment jsdom
//

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mutate = vi.fn();
let isPending = false;

vi.mock("../hooks", () => ({
	useSetRunnerAdmission: () => ({ mutate, isPending }),
}));
vi.mock("@/design", () => ({
	Toggle: ({
		checked,
		onChange,
		disabled,
		...rest
	}: {
		checked: boolean;
		onChange?: (v: boolean) => void;
		disabled?: boolean;
	}) => (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onChange?.(!checked)}
			{...rest}
		/>
	),
}));

const { PoolAdmission } = await import("./pool-admission");

const RUNNER = "6d49aba1-efec-478a-91d4-8f769a970f0f";
const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";

function mount(status: string, canEdit = true) {
	render(
		<PoolAdmission projectId={PROJECT} runnerId={RUNNER} status={status} canEdit={canEdit} />,
	);
	return screen.getByRole("switch") as HTMLButtonElement;
}

beforeEach(() => {
	mutate.mockClear();
	isPending = false;
});
afterEach(cleanup);

describe("PoolAdmission at `disabled`", () => {
	it("leaves the toggle operable, so the control that withdrew the box can return it", () => {
		const toggle = mount("disabled");

		expect(toggle.disabled).toBe(false);
	});

	it("admits the runner when that toggle is operated", () => {
		fireEvent.click(mount("disabled"));

		expect(mutate).toHaveBeenCalledWith({ runnerId: RUNNER, admit: true });
	});

	it("names the toggle as the way back, never a re-registration the unique index refuses", () => {
		mount("disabled");

		const caption = screen.getByText(/Retired by an operator/);
		expect(caption.textContent).toMatch(/switch this back on/i);
		expect(caption.textContent).not.toMatch(/re-register/i);
	});
});

/**
 * Criterion 25, and the defect this issue reproduces. The owner turned this
 * control off expecting the resident master session to stop, and it kept
 * running — because this control governs jobs offered from the pool and
 * nothing that is already up.
 */
describe("PoolAdmission and the resident master it does not reach", () => {
	it("says that switching it off ends no resident master session already running", () => {
		mount("online");

		const said = screen.getByText(/does not end a resident master session/i);
		expect(said.textContent).toMatch(/already\s+running/i);
	});

	it("says it at every status, because the reader is looking at whichever one they are in", () => {
		for (const status of ["online", "draining", "disabled"]) {
			mount(status);
			expect(
				screen.getByText(/does not end a resident master session/i),
			).toBeTruthy();
			cleanup();
		}
	});
});

describe("PoolAdmission everywhere else", () => {
	it("still reads `draining` as withdrawn and offers the way back", () => {
		const toggle = mount("draining");

		expect(toggle.getAttribute("aria-checked")).toBe("false");
		expect(toggle.disabled).toBe(false);
	});

	it("reads an admitted runner as on", () => {
		expect(mount("online").getAttribute("aria-checked")).toBe("true");
	});

	it("locks the toggle for a reader who may not edit, and while the write is in flight", () => {
		expect(mount("disabled", false).disabled).toBe(true);
		cleanup();
		isPending = true;
		expect(mount("online").disabled).toBe(true);
	});
});
