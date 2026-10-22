// @vitest-environment jsdom
//
// ISS-1339 r2 — the live deploy binding's verify probe, which a person declares, sees, changes and
// removes here since round 1 took it off Shape & release. What is asserted is the reading and the
// body each act sends: the binding PATCH takes `config.verify` whole, and `null` removes it.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BindingSummary } from "../types";

expect.extend(matchers);

const updateBinding = vi.fn();

vi.mock("../hooks", async (importActual) => {
	const actual = await importActual<typeof import("../hooks")>();
	return {
		...actual,
		useUpdateProviderIntegration: () => ({ mutate: updateBinding, isPending: false }),
	};
});

const { BindingVerifyProbeField, probeIsUsable } = await import("./verify-probe-field");

function draw(node: ReactElement) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
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

beforeEach(() => updateBinding.mockReset());
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
		expect(screen.queryByRole("button", { name: "Remove probe" })).toBeNull();
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
		expect(screen.queryByRole("button", { name: "Remove probe" })).toBeNull();
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

	it("removes the probe by sending null", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={declaring({ probes: [PROBE] })} canEdit />);
		fireEvent.click(screen.getByRole("button", { name: "Remove probe" }));
		expect(sent()).toEqual([{ id: BINDING_ID, body: { config: { verify: null } } }]);
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
		expect(updateBinding).not.toHaveBeenCalled();
	});
});

describe("a link that names the section lands on it", () => {
	it("puts the cursor in the first probe's url", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={binding()} canEdit focus />);
		expect(screen.getByLabelText("Probe 1 URL")).toHaveFocus();
	});

	it("leaves the cursor where it was without one", () => {
		draw(<BindingVerifyProbeField projectId={PROJECT_ID} binding={binding()} canEdit />);
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
