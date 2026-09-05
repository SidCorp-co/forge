// @vitest-environment jsdom
//
// The proposition: a 403 FRESH_AUTH_REQUIRED from `DELETE /api/devices/:id` is
// the FIRST half of revoking, not a failure. Before this control existed the
// screen reported it as one and pointed the operator at a Settings tab with no
// standalone re-auth action, so no sequence of clicks in the app could revoke a
// device once the sign-in was over five minutes old. Each test below fails if
// that dead end comes back.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const revokeMutate = vi.fn();
const reauthMutate = vi.fn();
const toast = vi.fn();

vi.mock("../hooks", () => ({
	useRevokeDevice: () => ({ mutate: revokeMutate, isPending: false }),
}));
vi.mock("@/features/settings/hooks", () => ({
	useReauth: () => ({ mutate: reauthMutate, isPending: false }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/api/error", () => ({ formatApiError: (e: unknown) => String(e) }));
vi.mock("@/features/auth/fresh-auth", () => ({
	isFreshAuthError: (e: unknown) => (e as { code?: string })?.code === "FRESH_AUTH_REQUIRED",
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

const FRESH_AUTH = { code: "FRESH_AUTH_REQUIRED" };

function mount(onDone = vi.fn()) {
	render(<RevokeDeviceControl deviceId="dev-1" deviceName="ubuntu4" onDone={onDone} />);
	return onDone;
}

/** Click Confirm and answer the revoke with `err` (or success when null). */
function confirmAnsweredWith(err: unknown | null) {
	revokeMutate.mockImplementation((_id: string, opts: Record<string, (e?: unknown) => void>) => {
		if (err) opts.onError?.(err);
		else opts.onSuccess?.();
	});
	fireEvent.click(screen.getByText("Confirm"));
}

describe("RevokeDeviceControl", () => {
	afterEach(cleanup);
	beforeEach(() => {
		revokeMutate.mockReset();
		reauthMutate.mockReset();
		toast.mockReset();
	});

	it("asks for the password instead of giving up when the revoke needs fresh auth", async () => {
		const onDone = mount();
		confirmAnsweredWith(FRESH_AUTH);

		await waitFor(() =>
			expect(screen.getByLabelText("Confirm password to revoke ubuntu4")).toBeTruthy(),
		);
		// cm:why the dead end was closing the row on that 403 — asserting onDone was NOT called is what keeps the operator with a control to act on
		expect(onDone).not.toHaveBeenCalled();
	});

	it("re-authenticates and retries the SAME revoke, so the loop actually closes", async () => {
		const onDone = mount();
		confirmAnsweredWith(FRESH_AUTH);
		await waitFor(() => screen.getByLabelText("Confirm password to revoke ubuntu4"));

		fireEvent.change(screen.getByLabelText("Confirm password to revoke ubuntu4"), {
			target: { value: "hunter2" },
		});
		reauthMutate.mockImplementation((_pw: string, opts: Record<string, () => void>) =>
			opts.onSuccess?.(),
		);
		revokeMutate.mockImplementation((_id: string, opts: Record<string, () => void>) =>
			opts.onSuccess?.(),
		);
		fireEvent.click(screen.getByText(/Confirm & revoke/));

		await waitFor(() => expect(reauthMutate).toHaveBeenCalledWith("hunter2", expect.anything()));
		expect(revokeMutate).toHaveBeenCalledTimes(2);
		expect(revokeMutate.mock.calls[1]?.[0]).toBe("dev-1");
		await waitFor(() => expect(onDone).toHaveBeenCalled());
	});

	it("does not mistake an ordinary failure for a fresh-auth prompt", async () => {
		const onDone = mount();
		confirmAnsweredWith({ code: "NOT_FOUND" });

		await waitFor(() => expect(onDone).toHaveBeenCalled());
		expect(screen.queryByLabelText("Confirm password to revoke ubuntu4")).toBeNull();
	});

	it("reports a wrong password rather than silently doing nothing", async () => {
		mount();
		confirmAnsweredWith(FRESH_AUTH);
		await waitFor(() => screen.getByLabelText("Confirm password to revoke ubuntu4"));

		fireEvent.change(screen.getByLabelText("Confirm password to revoke ubuntu4"), {
			target: { value: "wrong" },
		});
		reauthMutate.mockImplementation(
			(_pw: string, opts: Record<string, (e: unknown) => void>) =>
				opts.onError?.({ code: "INVALID_CREDENTIALS" }),
		);
		fireEvent.click(screen.getByText(/Confirm & revoke/));

		await waitFor(() => expect(toast).toHaveBeenCalled());
		expect(revokeMutate).toHaveBeenCalledTimes(1);
	});
});
