// @vitest-environment jsdom
//
// ISS-1421 r14. At 390px the refusal of a passphrase-protected key arrived as a toast over the
// dialog's title and its Name field. A refusal of the pasted key belongs under the Private key
// field, and any other create refusal at the foot of the form; neither is a toast.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";

const state = vi.hoisted(() => ({
	error: null as unknown,
	reset: (() => undefined) as () => void,
}));

vi.mock("../hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("../hooks")>()),
	useCreateSshKey: () => ({
		mutate: vi.fn(),
		reset: state.reset,
		isPending: false,
		error: state.error,
	}),
}));

const { PrivateKeyCreateSlideOver } = await import("./private-key-create-slideover");

const PASSPHRASE =
	"Forge could not read this SSH private key, because a passphrase protects it. Forge uses keys unattended, so paste one without a passphrase or generate one here.";

function openPasted() {
	render(<PrivateKeyCreateSlideOver open onClose={() => undefined} orgId="o-1" />);
	fireEvent.click(screen.getByRole("button", { name: "Paste existing" }));
	return screen.getByLabelText("Private key");
}

afterEach(() => {
	cleanup();
	state.error = null;
	state.reset = () => undefined;
});

describe("the create private key form's refusals", () => {
	it("shows a refused key under the Private key field, described by it", () => {
		state.error = new ApiError(400, PASSPHRASE, "INVALID_PRIVATE_KEY", { reason: "passphrase" });
		const field = openPasted();

		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe(PASSPHRASE);
		expect(field.getAttribute("aria-describedby")).toBe(alert.id);
		expect(field.getAttribute("aria-invalid")).toBe("true");
	});

	it("words a duplicate key under the same field", () => {
		state.error = new ApiError(409, "duplicate", "DUPLICATE_FINGERPRINT");
		const field = openPasted();

		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe("This key is already in the pool: one there has the same fingerprint.");
		expect(field.getAttribute("aria-describedby")).toBe(alert.id);
	});

	it("clears the refusal once the key is edited", () => {
		const reset = vi.fn();
		state.reset = reset;
		state.error = new ApiError(400, PASSPHRASE, "INVALID_PRIVATE_KEY");
		const field = openPasted();

		fireEvent.change(field, { target: { value: "-----BEGIN OPENSSH PRIVATE KEY-----" } });
		expect(reset).toHaveBeenCalled();
	});

	it("keeps a key refusal on screen, at the foot, once Generate new hides the field", () => {
		state.error = new ApiError(400, PASSPHRASE, "INVALID_PRIVATE_KEY");
		openPasted();
		fireEvent.click(screen.getByRole("button", { name: "Generate new" }));

		expect(screen.queryByLabelText("Private key")).toBeNull();
		expect(screen.getByRole("alert").textContent).toBe(PASSPHRASE);
	});

	it("shows any other refusal at the foot of the form, not on a field", () => {
		state.error = new ApiError(500, "The vault is not configured.", "VAULT_NOT_CONFIGURED");
		const field = openPasted();

		expect(screen.getByRole("alert").textContent).toContain("The vault is not configured.");
		expect(field.getAttribute("aria-invalid")).toBeNull();
	});
});
