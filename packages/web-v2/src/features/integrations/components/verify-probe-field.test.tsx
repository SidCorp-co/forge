// @vitest-environment jsdom
//
// ISS-1339 r2 — the live deploy binding's verify probe, which a person declares, sees, changes and
// removes here since round 1 took it off Shape & release. What is asserted is the reading and the
// body each act sends: the binding PATCH takes `config.verify` whole, and `null` removes it.
// ISS-1339 r3 — what judge-99 found on it: the all-probes removal, the labels, the double press,
// the error that outlived its row and the focus that fell to the page.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { LeaveGuardProvider, useLeaveGuardAttempt } from "@/design";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BindingSummary } from "../types";

expect.extend(matchers);

const updateBinding = vi.fn();
/** The project's bindings as the list read answers them; `undefined` is a read not back yet. */
let listed: BindingSummary[] | undefined;

vi.mock("../hooks", async (importActual) => {
	const actual = await importActual<typeof import("../hooks")>();
	return {
		...actual,
		useUpdateProviderIntegration: () => ({ mutate: updateBinding, isPending: false }),
		useIntegrationsList: () => ({ data: listed ? { items: listed } : undefined }),
	};
});

const { BindingVerifyProbeField, probeIsUsable } = await import("./verify-probe-field");

function draw(node: ReactElement) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<LeaveGuardProvider>{node}</LeaveGuardProvider>
		</QueryClientProvider>,
	);
}

const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const BINDING_ID = "b1111111-1111-4111-8111-111111111111";
const PROBE = { url: "https://api.example.com/version", commitPath: "sourceCommit" };

function binding(over: Partial<BindingSummary> = {}): BindingSummary {
	return {
		id: BINDING_ID,
		connectionId: "c1111111-1111-4111-8111-111111111111",
		projectId: PROJECT_ID,
		provider: "coolify",
		role: "deploy",
		stages: ["live"],
		config: {},
		bindingConfig: {},
		label: "",
		active: true,
		bindingActive: true,
		connectionActive: true,
		lastHealthStatus: "ok",
		lastHealthAt: null,
		breakerOpenedAt: null,
		hasSecrets: true,
		integrationSecretSet: true,
		agentAccess: "all",
		agentPathKind: "core-mediated",
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		...over,
	} as BindingSummary;
}

/** A binding declaring `verify` on its own tier, which `config` shows merged. */
function declaring(verify: Record<string, unknown>, over: Partial<BindingSummary> = {}): BindingSummary {
	return binding({ config: { verify }, bindingConfig: { verify }, ...over });
}

const sent = () => updateBinding.mock.calls.map((c) => c[0]);

beforeEach(() => {
	updateBinding.mockReset();
	listed = undefined;
});
afterEach(cleanup);

describe("what the section says is declared", () => {
	it("names each probe's url and the commit field it reads", () => {
		draw(
			<BindingVerifyProbeField
				projectId={PROJECT_ID}
				binding={declaring({ probes: [PROBE, { url: "https://www.example.com/build-info" }] })}
				canEdit
			/>,
		);
		const listed = screen.getByRole("list", { name: "Declared probes" });
		expect(listed).toHaveTextContent("https://api.example.com/version — commit read from sourceCommit");
		expect(listed).toHaveTextContent("https://www.example.com/build-info — commit read from the whole answer");
	});

	it("says none is declared, and what a release then records", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={binding()} canEdit />);
		expect(screen.getByText(/None declared — a release reads nothing on this binding/)).toBeInTheDocument();
		expect(screen.getByText(/the release closes unverified/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Remove all probes" })).toBeNull();
	});

	it("says a stored block names no probe a release can read", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring({ probes: [] })} canEdit />);
		expect(screen.getByText(/names no probe a release can read/)).toBeInTheDocument();
	});

	it("says where an inherited probe is declared", () => {
		draw(
			<BindingVerifyProbeField
				projectId={PROJECT_ID}
				binding={binding({ config: { verify: { probes: [PROBE] } } })}
				canEdit
			/>,
		);
		expect(screen.getByText(/Inherited from the shared connection/)).toBeInTheDocument();
		// Removing it here removes nothing: the binding declares none of its own.
		expect(screen.queryByRole("button", { name: "Remove all probes" })).toBeNull();
	});

	it.each([
		["a binding that serves only Preview", binding({ stages: ["preview"] })],
		["a service binding", binding({ role: "service", stages: [] })],
	])("is not drawn on %s, whose probe no release reads", (_, b) => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={b} canEdit />);
		expect(screen.queryByText("Verify probe")).toBeNull();
	});

	it("offers no edit to a reader who may not make one", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring({ probes: [PROBE] })} canEdit={false} />);
		expect(screen.queryByLabelText("Probe 1 URL")).toBeNull();
		expect(screen.getByText("Only a project admin can change this.")).toBeInTheDocument();
	});
});

describe("the write each act sends", () => {
	it("declares a probe as config.verify through the binding write", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={binding()} canEdit />);
		fireEvent.change(screen.getByLabelText("Probe 1 URL"), { target: { value: " https://api.example.com/version " } });
		fireEvent.change(screen.getByLabelText("Probe 1 commit field"), { target: { value: "sourceCommit" } });
		fireEvent.click(screen.getByRole("button", { name: "Save probe" }));
		expect(sent()).toEqual([{ id: BINDING_ID, body: { config: { verify: { probes: [PROBE] } } } }]);
	});

	it("replaces the probe it showed with the changed one, keeping a stored stableReads", () => {
		draw(
			<BindingVerifyProbeField
				projectId={PROJECT_ID}
				binding={declaring({ probes: [PROBE], stableReads: 3 })}
				canEdit
			/>,
		);
		expect(screen.getByLabelText("Probe 1 URL")).toHaveValue(PROBE.url);
		fireEvent.change(screen.getByLabelText("Probe 1 URL"), { target: { value: "https://api.example.com/v2/version" } });
		fireEvent.change(screen.getByLabelText("Probe 1 commit field"), { target: { value: "data.commit" } });
		fireEvent.click(screen.getByRole("button", { name: "Save probe" }));
		expect(sent()).toEqual([
			{
				id: BINDING_ID,
				body: {
					config: {
						verify: { probes: [{ url: "https://api.example.com/v2/version", commitPath: "data.commit" }], stableReads: 3 },
					},
				},
			},
		]);
	});

	it("sends a blank commit field as no commitPath, which reads the whole answer", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={binding()} canEdit />);
		fireEvent.change(screen.getByLabelText("Probe 1 URL"), { target: { value: "https://api.example.com/sha" } });
		fireEvent.click(screen.getByRole("button", { name: "Save probe" }));
		expect(sent()).toEqual([
			{ id: BINDING_ID, body: { config: { verify: { probes: [{ url: "https://api.example.com/sha" }] } } } },
		]);
	});

	it("names a stored timeoutSeconds a save leaves out, and leaves it out", () => {
		draw(
			<BindingVerifyProbeField
				projectId={PROJECT_ID}
				binding={declaring({ probes: [PROBE], stableReads: 2, timeoutSeconds: 300 })}
				canEdit
			/>,
		);
		expect(screen.getByText(/which no release reads any more. Saving here leaves it out./)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Save probe" }));
		expect(sent()).toEqual([
			{ id: BINDING_ID, body: { config: { verify: { probes: [PROBE], stableReads: 2 } } } },
		]);
	});

	it("declares a second probe beside the first", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring({ probes: [PROBE] })} canEdit />);
		fireEvent.click(screen.getByRole("button", { name: "Add another probe" }));
		fireEvent.change(screen.getByLabelText("Probe 2 URL"), { target: { value: "https://www.example.com/build-info" } });
		fireEvent.change(screen.getByLabelText("Probe 2 commit field"), { target: { value: "commit" } });
		fireEvent.click(screen.getByRole("button", { name: "Save probe" }));
		expect(sent()[0].body.config.verify.probes).toEqual([
			PROBE,
			{ url: "https://www.example.com/build-info", commitPath: "commit" },
		]);
	});

	it("removes every probe by sending null, once the person has confirmed it", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring({ probes: [PROBE] })} canEdit />);
		fireEvent.click(screen.getByRole("button", { name: "Remove all probes" }));
		expect(sent()).toEqual([]);
		fireEvent.click(within(screen.getAllByRole("dialog").at(-1) as HTMLElement).getByRole("button", { name: "Remove all probes" }));
		expect(sent()).toEqual([{ id: BINDING_ID, body: { config: { verify: null } } }]);
	});

	it("keeps a stored stableReads when one of two rows is removed and the rest saved", () => {
		draw(
			<BindingVerifyProbeField
				projectId={PROJECT_ID}
				binding={declaring({ probes: [PROBE, { url: "https://www.example.com/build-info" }], stableReads: 3 })}
				canEdit
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Remove probe 1" }));
		fireEvent.click(screen.getByRole("button", { name: "Save probe" }));
		expect(sent()).toEqual([
			{
				id: BINDING_ID,
				body: { config: { verify: { probes: [{ url: "https://www.example.com/build-info" }], stableReads: 3 } } },
			},
		]);
	});

	it("sends one write for two presses of Save before the first answers", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={binding()} canEdit />);
		fireEvent.change(screen.getByLabelText("Probe 1 URL"), { target: { value: "https://api.example.com/sha" } });
		const save = screen.getByRole("button", { name: "Save probe" });
		fireEvent.click(save);
		fireEvent.click(save);
		expect(updateBinding).toHaveBeenCalledTimes(1);
	});

	it("takes a second save once the first has answered", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={binding()} canEdit />);
		fireEvent.change(screen.getByLabelText("Probe 1 URL"), { target: { value: "https://api.example.com/sha" } });
		fireEvent.click(screen.getByRole("button", { name: "Save probe" }));
		act(() => updateBinding.mock.calls[0]?.[1]?.onSettled?.());
		fireEvent.click(screen.getByRole("button", { name: "Save probe" }));
		expect(updateBinding).toHaveBeenCalledTimes(2);
	});
});

describe("removing every probe asks once, and says what goes", () => {
	const TWO = { probes: [PROBE, { url: "https://www.example.com/build-info" }] };
	const dialog = () => screen.getAllByRole("dialog").at(-1) as HTMLElement;

	it("names how many probes go and that a release then closes unverified", () => {
		listed = [declaring(TWO)];
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring(TWO)} canEdit />);
		fireEvent.click(screen.getByRole("button", { name: "Remove all probes" }));
		expect(dialog()).toHaveTextContent("Remove all 2 probes?");
		expect(dialog()).toHaveTextContent("This removes all 2 probes this binding declares.");
		expect(dialog()).toHaveTextContent("No other live binding declares a probe, so a release then closes unverified.");
		expect(sent()).toEqual([]);
	});

	it("says a release reads the other live binding's probes where one declares them", () => {
		const other = declaring({ probes: [PROBE] }, { id: "b2222222-2222-4222-8222-222222222222", provider: "epodsystem" });
		listed = [declaring(TWO), other];
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring(TWO)} canEdit />);
		fireEvent.click(screen.getByRole("button", { name: "Remove all probes" }));
		expect(dialog()).toHaveTextContent("A release then reads only the probes the project's other live bindings declare.");
	});

	it("says a release is refused where another live binding declares a probe it cannot read", () => {
		const other = declaring({ probes: [] }, { id: "b3333333-3333-4333-8333-333333333333", provider: "epodsystem" });
		listed = [declaring(TWO), declaring({ probes: [PROBE] }, { id: "b2222222-2222-4222-8222-222222222222" }), other];
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring(TWO)} canEdit />);
		fireEvent.click(screen.getByRole("button", { name: "Remove all probes" }));
		expect(dialog()).toHaveTextContent("Another live binding declares a probe a release cannot read, so a release is refused until that probe is corrected.");
		expect(dialog()).not.toHaveTextContent("closes unverified");
	});

	it("names a stored stableReads as removed with them", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring({ ...TWO, stableReads: 3 })} canEdit />);
		fireEvent.click(screen.getByRole("button", { name: "Remove all probes" }));
		expect(dialog()).toHaveTextContent("The stored stableReads (3) is removed with them");
	});

	it("sends nothing on Keep them, and leaves an unsaved edit as it was", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring(TWO)} canEdit />);
		fireEvent.change(screen.getByLabelText("Probe 1 URL"), { target: { value: "https://api.example.com/edited" } });
		fireEvent.click(screen.getByRole("button", { name: "Remove all probes" }));
		fireEvent.click(within(dialog()).getByRole("button", { name: "Keep them" }));
		expect(screen.queryAllByRole("dialog")).toHaveLength(0);
		expect(sent()).toEqual([]);
		expect(screen.getByLabelText("Probe 1 URL")).toHaveValue("https://api.example.com/edited");
		expect(screen.getByLabelText("Probe 2 URL")).toHaveValue("https://www.example.com/build-info");
	});

	it("says a refused removal inside the confirmation, which stays open to try again", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring(TWO)} canEdit />);
		fireEvent.click(screen.getByRole("button", { name: "Remove all probes" }));
		fireEvent.click(within(dialog()).getByRole("button", { name: "Remove all probes" }));
		act(() => {
			const callbacks = updateBinding.mock.calls[0]?.[1];
			callbacks?.onError?.(new Error("the binding is locked"));
			callbacks?.onSettled?.();
		});
		expect(within(dialog()).getByTestId("panel-failure")).toHaveTextContent("The probes were not removed.");
		expect(within(dialog()).getByTestId("panel-failure")).toHaveTextContent("the binding is locked");
		fireEvent.click(within(dialog()).getByRole("button", { name: "Remove all probes" }));
		expect(updateBinding).toHaveBeenCalledTimes(2);
	});

	it("sends one write for two presses of the confirmation", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring(TWO)} canEdit />);
		fireEvent.click(screen.getByRole("button", { name: "Remove all probes" }));
		const confirm = within(dialog()).getByRole("button", { name: "Remove all probes" });
		fireEvent.click(confirm);
		fireEvent.click(confirm);
		expect(sent()).toEqual([{ id: BINDING_ID, body: { config: { verify: null } } }]);
	});
});

describe("the rows say what each input is", () => {
	it("labels each input on screen, and the labels stay once both are filled", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring({ probes: [PROBE] })} canEdit />);
		fireEvent.click(screen.getByRole("button", { name: "Add another probe" }));
		fireEvent.change(screen.getByLabelText("Probe 2 URL"), { target: { value: "https://www.example.com/build-info" } });
		fireEvent.change(screen.getByLabelText("Probe 2 commit field"), { target: { value: "commit" } });
		for (const words of ["Probe 1 URL", "Probe 1 commit field", "Probe 2 URL", "Probe 2 commit field"]) {
			const label = screen.getByText(words, { selector: "label" });
			expect(label).toBeVisible();
			expect(document.getElementById(label.getAttribute("for") ?? "")).toBe(screen.getByLabelText(words));
		}
	});

	it("shows no placeholder in either input", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={binding()} canEdit />);
		expect(screen.getByLabelText("Probe 1 URL")).not.toHaveAttribute("placeholder");
		expect(screen.getByLabelText("Probe 1 commit field")).not.toHaveAttribute("placeholder");
	});

	it("gives the example address and what a blank commit field reads in its help text", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={binding()} canEdit />);
		const help = screen.getByText(/The URL answers with the commit the live deployment is serving/);
		expect(help).toHaveTextContent("such as https://api.example.com/version");
		expect(help).toHaveTextContent("Left blank, the whole answer is read as the commit.");
	});
});

describe("a probe typed wrong is refused on the section, before any write", () => {
	it.each([
		["no url beside a commit field", "", "sourceCommit", "Probe 1 has a commit field and no URL."],
		["a url that is not one", "api.example.com/version", "", "Probe 1's URL is not an http or https address"],
		["a url on another scheme", "ftp://api.example.com/version", "", "Probe 1's URL is not an http or https address"],
		["nothing typed at all", "", "", "Type the address the live deployment answers its commit on"],
	])("%s", (_, url, commitPath, said) => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={binding()} canEdit />);
		fireEvent.change(screen.getByLabelText("Probe 1 URL"), { target: { value: url } });
		fireEvent.change(screen.getByLabelText("Probe 1 commit field"), { target: { value: commitPath } });
		fireEvent.click(screen.getByRole("button", { name: "Save probe" }));
		expect(screen.getByRole("alert")).toHaveTextContent(said);
		expect(updateBinding).not.toHaveBeenCalled();
	});

	it("names the row at fault among several", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring({ probes: [PROBE] })} canEdit />);
		fireEvent.click(screen.getByRole("button", { name: "Add another probe" }));
		fireEvent.change(screen.getByLabelText("Probe 2 URL"), { target: { value: "not a url" } });
		fireEvent.click(screen.getByRole("button", { name: "Save probe" }));
		expect(screen.getByRole("alert")).toHaveTextContent("Probe 2's URL is not an http or https address");
		expect(screen.getByRole("alert")).not.toHaveTextContent("Probe 1");
		expect(screen.getByLabelText("Probe 2 URL")).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByLabelText("Probe 1 URL")).not.toHaveAttribute("aria-invalid");
		expect(updateBinding).not.toHaveBeenCalled();
	});

	it("draws a row's error under that row, and removing the row removes it", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring({ probes: [PROBE] })} canEdit />);
		fireEvent.click(screen.getByRole("button", { name: "Add another probe" }));
		fireEvent.change(screen.getByLabelText("Probe 2 URL"), { target: { value: "not a url" } });
		fireEvent.click(screen.getByRole("button", { name: "Save probe" }));
		const error = screen.getByRole("alert");
		expect(screen.getByLabelText("Probe 2 URL").getAttribute("aria-describedby")).toBe(error.id);
		fireEvent.click(screen.getByRole("button", { name: "Remove probe 2" }));
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByText(/is not an http or https address/)).toBeNull();
	});

	it("keeps a row's error with that row, under its new number, when a row above it goes", () => {
		draw(
			<BindingVerifyProbeField
				projectId={PROJECT_ID}
				binding={declaring({ probes: [PROBE, { url: "https://www.example.com/build-info" }] })}
				canEdit
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add another probe" }));
		fireEvent.change(screen.getByLabelText("Probe 3 URL"), { target: { value: "not a url" } });
		fireEvent.click(screen.getByRole("button", { name: "Save probe" }));
		fireEvent.click(screen.getByRole("button", { name: "Remove probe 1" }));
		expect(screen.getByRole("alert")).toHaveTextContent("Probe 2's URL is not an http or https address");
		expect(screen.getByLabelText("Probe 2 URL")).toHaveValue("not a url");
	});

	it("drops a row's error once the row is typed in again", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={binding()} canEdit />);
		fireEvent.change(screen.getByLabelText("Probe 1 URL"), { target: { value: "not a url" } });
		fireEvent.click(screen.getByRole("button", { name: "Save probe" }));
		expect(screen.getByRole("alert")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Probe 1 URL"), { target: { value: "https://api.example.com/sha" } });
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

// What the Settings tabs do to move: ask the leave guard, which asks the person where a page holds
// an unsaved edit.
function SettingsTab({ onMove }: { onMove: () => void }) {
	const leave = useLeaveGuardAttempt();
	return (
		<button type="button" onClick={() => leave(onMove)}>
			Shape &amp; release
		</button>
	);
}

describe("an unsaved edit is one the page knows about", () => {
	it("asks before another Settings tab is opened over it", () => {
		const moved = vi.fn();
		draw(
			<>
				<SettingsTab onMove={moved} />
				<BindingVerifyProbeField projectId={PROJECT_ID} binding={binding()} canEdit />
			</>,
		);
		fireEvent.change(screen.getByLabelText("Probe 1 URL"), { target: { value: "https://api.example.com/sha" } });
		fireEvent.click(screen.getByRole("button", { name: "Shape & release" }));
		expect(moved).not.toHaveBeenCalled();
		expect(screen.getByText("Leave without saving?")).toBeInTheDocument();
	});

	it("moves without asking where nothing differs from what is stored", () => {
		const moved = vi.fn();
		draw(
			<>
				<SettingsTab onMove={moved} />
				<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring({ probes: [PROBE] })} canEdit />
			</>,
		);
		fireEvent.change(screen.getByLabelText("Probe 1 URL"), { target: { value: ` ${PROBE.url} ` } });
		fireEvent.click(screen.getByRole("button", { name: "Shape & release" }));
		expect(moved).toHaveBeenCalledOnce();
	});

	it("tells the drawer when it holds one, and when it no longer does", () => {
		const dirty = vi.fn();
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={binding()} canEdit onDirtyChange={dirty} />);
		fireEvent.change(screen.getByLabelText("Probe 1 URL"), { target: { value: "https://api.example.com/sha" } });
		expect(dirty).toHaveBeenLastCalledWith(true);
		fireEvent.change(screen.getByLabelText("Probe 1 URL"), { target: { value: "" } });
		expect(dirty).toHaveBeenLastCalledWith(false);
	});
});

describe("focus after a row is removed", () => {
	const THREE = {
		probes: [PROBE, { url: "https://b.example.com/v" }, { url: "https://c.example.com/v" }],
	};

	it("lands in the URL of the row that took the removed one's place", async () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring(THREE)} canEdit />);
		fireEvent.click(screen.getByRole("button", { name: "Remove probe 2" }));
		await waitFor(() => expect(screen.getByLabelText("Probe 2 URL")).toHaveFocus());
		expect(screen.getByLabelText("Probe 2 URL")).toHaveValue("https://c.example.com/v");
	});

	it("lands in the last row's URL where the removed row was last", async () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring(THREE)} canEdit />);
		fireEvent.click(screen.getByRole("button", { name: "Remove probe 3" }));
		await waitFor(() => expect(screen.getByLabelText("Probe 2 URL")).toHaveFocus());
		expect(screen.getByLabelText("Probe 2 URL")).toHaveValue("https://b.example.com/v");
	});
});

describe("a link that names the section lands on it", () => {
	it("puts the cursor in the first probe's url, after whatever took focus as it was drawn", async () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={binding()} canEdit focus />);
		// What the drawer around it does once it opens: focus its first control.
		screen.getByRole("button", { name: "Save probe" }).focus();
		await waitFor(() => expect(screen.getByLabelText("Probe 1 URL")).toHaveFocus());
	});

	it("leaves the cursor where it was without one", async () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={binding()} canEdit />);
		await new Promise((r) => setTimeout(r, 10));
		expect(screen.getByLabelText("Probe 1 URL")).not.toHaveFocus();
	});
});

describe("probeIsUsable, the reading the landing picks a binding by", () => {
	it.each([
		[{ probes: [PROBE] }, true],
		[{ probes: [{ url: "https://a.example/v" }, { url: "https://b.example/v", commitPath: "c" }] }, true],
		[undefined, false],
		[null, false],
		[{ probes: [] }, false],
		[{ probes: [{ commitPath: "sourceCommit" }] }, false],
		[{ probes: [{ url: "api/version" }] }, false],
		[{ probes: [PROBE, { url: "health" }] }, false],
	])("%j → %s", (raw, usable) => {
		expect(probeIsUsable(raw)).toBe(usable);
	});
});
