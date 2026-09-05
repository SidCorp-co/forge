// @vitest-environment jsdom
//
// cm:guard the typed-name match is the ONLY thing between a click and a destructive call, since the route carries no gate of its own — so the cases that matter are the ones that must NOT fire: a near-miss name, a prefix, and a different case. Two fleet hosts are literally `ubuntu6` and `ubuntu6 (barlow)`.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const revokeMutate = vi.fn();

vi.mock("../hooks", () => ({
	useRevokeDevice: () => ({ mutate: revokeMutate, isPending: false }),
}));
vi.mock("@/design", () => ({
	Button: ({
		children,
		onClick,
		disabled,
	}: {
		children: React.ReactNode;
		onClick?: () => void;
		disabled?: boolean;
	}) => (
		<button type="button" onClick={onClick} disabled={disabled}>
			{children}
		</button>
	),
	Input: (p: Record<string, unknown>) => <input {...p} />,
}));

const { RevokeDeviceControl } = await import("./revoke-device-control");

const NAME = "ubuntu6";

function mount(onDone = vi.fn(), deviceName = NAME) {
	render(<RevokeDeviceControl deviceId="dev-1" deviceName={deviceName} onDone={onDone} />);
	return {
		onDone,
		field: () => screen.getByLabelText(`Type ${deviceName} to confirm revoking it`),
		button: () => screen.getByText("Revoke") as HTMLButtonElement,
		type: (v: string) => fireEvent.change(screen.getByLabelText(`Type ${deviceName} to confirm revoking it`), { target: { value: v } }),
	};
}

describe("RevokeDeviceControl", () => {
	afterEach(cleanup);
	beforeEach(() => revokeMutate.mockReset());

	it("revokes once the name matches exactly", () => {
		const ui = mount();
		ui.type(NAME);
		fireEvent.click(ui.button());
		expect(revokeMutate).toHaveBeenCalledTimes(1);
		expect(revokeMutate.mock.calls[0]?.[0]).toBe("dev-1");
	});

	it("closes the row when the revoke settles, however it settled", () => {
		const ui = mount();
		ui.type(NAME);
		fireEvent.click(ui.button());
		const opts = revokeMutate.mock.calls[0]?.[1] as { onSettled?: () => void };
		expect(opts?.onSettled).toBeTypeOf("function");
		opts.onSettled?.();
		expect(ui.onDone).toHaveBeenCalled();
	});

	it.each([
		["nothing typed", ""],
		["a prefix", "ubuntu"],
		["the sibling host", "ubuntu6 (barlow)"],
		["a different case", "UBUNTU6"],
		["a near miss", "ubuntu5"],
	])("refuses to fire on %s", (_label, typed) => {
		const ui = mount();
		ui.type(typed);
		expect(ui.button().disabled).toBe(true);
		fireEvent.click(ui.button());
		expect(revokeMutate).not.toHaveBeenCalled();
	});

	it("ignores surrounding whitespace, which a paste carries", () => {
		const ui = mount();
		ui.type(`  ${NAME}  `);
		fireEvent.click(ui.button());
		expect(revokeMutate).toHaveBeenCalledTimes(1);
	});

	it("Enter does not fire while the name is still wrong", () => {
		const ui = mount();
		ui.type("ubuntu");
		fireEvent.keyDown(ui.field(), { key: "Enter" });
		expect(revokeMutate).not.toHaveBeenCalled();
	});

	it("Cancel closes without revoking", () => {
		const ui = mount();
		ui.type(NAME);
		fireEvent.click(screen.getByText("Cancel"));
		expect(revokeMutate).not.toHaveBeenCalled();
		expect(ui.onDone).toHaveBeenCalled();
	});
});
