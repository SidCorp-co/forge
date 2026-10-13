// @vitest-environment jsdom
//
// ISS-1262: the Account page is ONE form over two routes. What is asserted is what it sends — each
// route only when its own fields moved — and what it does when one of the two fails: the route that
// landed reads as saved and the other's edit stays held, so a retry sends the failed route alone.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaveGuardProvider } from "@/design";
import { ApiError } from "@/lib/api/client";
import { AccountTab } from "./components/account-tab";

expect.extend(matchers);

let prefs: { theme: string; language: string };
let assistant: { answerStyle: string; assistantInstructions: string | null };
let prefsWrites: unknown[];
let assistantWrites: unknown[];
let assistantFails: boolean;

vi.mock("@/lib/api/client", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
	return {
		...actual,
		apiClient: async (path: string, init?: { method?: string; body?: string }) => {
			const body = init?.body ? JSON.parse(init.body) : undefined;
			if (path === "/auth/me/preferences" && init?.method === "PATCH") {
				prefsWrites.push(body);
				prefs = { ...prefs, ...body };
				return { ...prefs };
			}
			if (path === "/auth/me/preferences") return { ...prefs };
			if (path === "/auth/preferences" && init?.method === "PATCH") {
				assistantWrites.push(body);
				if (assistantFails) throw new ApiError(500, "the preferences store is down", "SERVER_ERROR");
				assistant = { ...assistant, ...body };
				return { ...prefs, ...assistant };
			}
			if (path === "/auth/preferences") return { ...prefs, ...assistant };
			if (path === "/auth/preferences/changes") return { items: [] };
			throw new Error(`unmocked ${init?.method ?? "GET"} ${path}`);
		},
	};
});

vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/providers/auth-provider", () => ({
	useAuth: () => ({ user: { id: "u1", email: "me@example.com" } }),
}));

function mount() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<LeaveGuardProvider>
				<AccountTab />
			</LeaveGuardProvider>
		</QueryClientProvider>,
	);
}

const saveButton = () => screen.getByRole("button", { name: "Save" });
const instructions = () => screen.getByLabelText("Standing instructions") as HTMLTextAreaElement;

beforeEach(() => {
	// The custom Select scrolls its chosen option into view, which jsdom does not implement.
	Element.prototype.scrollIntoView = () => undefined;
	prefs = { theme: "system", language: "en" };
	assistant = { answerStyle: "default", assistantInstructions: null };
	prefsWrites = [];
	assistantWrites = [];
	assistantFails = false;
});
afterEach(cleanup);

describe("one form, one save bar", () => {
	it("offers exactly one Save for the preferences and the assistant's answers together", async () => {
		mount();
		await screen.findByLabelText("Standing instructions");
		const saves = screen.getAllByRole("button").filter((b) => /^save/i.test(b.textContent ?? ""));
		expect(saves).toHaveLength(1);
		expect(saveButton()).toBeDisabled();
	});

	it("is dirty only while a value differs, and clean again when it is put back", async () => {
		mount();
		fireEvent.change(await screen.findByLabelText("Standing instructions"), { target: { value: "Be brief." } });
		expect(saveButton()).toBeEnabled();
		fireEvent.change(instructions(), { target: { value: "" } });
		expect(saveButton()).toBeDisabled();
	});
});

describe("what one Save writes", () => {
	it("writes the assistant route alone when only its fields moved", async () => {
		mount();
		fireEvent.change(await screen.findByLabelText("Standing instructions"), { target: { value: "Be brief." } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(assistantWrites).toHaveLength(1));
		expect(assistantWrites[0]).toEqual({ answerStyle: "default", assistantInstructions: "Be brief." });
		expect(prefsWrites).toEqual([]);
	});

	it("writes both routes when both moved, theme and language to the preferences route", async () => {
		mount();
		fireEvent.change(await screen.findByLabelText("Standing instructions"), { target: { value: "Be brief." } });
		fireEvent.click(screen.getAllByRole("combobox")[0] as HTMLElement);
		fireEvent.click(await screen.findByRole("option", { name: "Dark" }));
		fireEvent.click(saveButton());

		await waitFor(() => expect(assistantWrites).toHaveLength(1));
		expect(prefsWrites).toEqual([{ theme: "dark", language: "en" }]);
	});
});

describe("when one of the two routes fails", () => {
	it("reads what the other saved as clean, keeps the failed edit, and a retry sends the failed route alone", async () => {
		assistantFails = true;
		mount();
		fireEvent.change(await screen.findByLabelText("Standing instructions"), { target: { value: "Be brief." } });
		fireEvent.click(screen.getAllByRole("combobox")[0] as HTMLElement);
		fireEvent.click(await screen.findByRole("option", { name: "Dark" }));
		fireEvent.click(saveButton());

		const banner = await screen.findByText(/Theme and language saved, but not the rest/i);
		expect(banner.textContent).toMatch(/the preferences store is down/);
		expect(prefs.theme).toBe("dark");
		expect(instructions().value).toBe("Be brief.");
		await waitFor(() => expect(saveButton()).toBeEnabled());

		assistantFails = false;
		fireEvent.click(saveButton());
		await waitFor(() => expect(assistantWrites).toHaveLength(2));
		expect(prefsWrites).toHaveLength(1);
		await waitFor(() => expect(saveButton()).toBeDisabled());
	});
});
