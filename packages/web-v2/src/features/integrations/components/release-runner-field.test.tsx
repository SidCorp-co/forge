// @vitest-environment jsdom
//
// ISS-1275 — the surface the release warning's free act had nowhere to be taken
// on. The warning offers clearing `releaseRunnerLabel` from the live deploy
// binding and from the connection behind it; before this control neither of
// those objects had a field anywhere in the product, so an operator read two
// names off a card that would not let them change either.
//
// What is asserted is the reading and the write: which tier the label in force
// was declared on, and the body each act sends.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BindingSummary } from "../types";

expect.extend(matchers);

const updateBinding = vi.fn();
const updateConnection = vi.fn();

vi.mock("../hooks", async (importActual) => {
	const actual = await importActual<typeof import("../hooks")>();
	return {
		...actual,
		useUpdateProviderIntegration: () => ({ mutate: updateBinding, isPending: false }),
		useUpdateConnection: () => ({ mutate: updateConnection, isPending: false }),
	};
});

const { BindingReleaseRunnerField, ConnectionReleaseRunnerField } = await import(
	"./release-runner-field"
);

function draw(node: ReactElement) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const BINDING_ID = "b1111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "c1111111-1111-4111-8111-111111111111";

/** The two config views the list route returns: `config` merged, `bindingConfig` this project's own. */
function binding(over: Partial<BindingSummary> = {}): BindingSummary {
	return {
		id: BINDING_ID,
		connectionId: CONNECTION_ID,
		projectId: PROJECT_ID,
		provider: "coolify",
		role: "deploy",
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

beforeEach(() => {
	updateBinding.mockReset();
	updateConnection.mockReset();
});

afterEach(cleanup);

describe("the release runner label on a deploy binding", () => {
	it("shows the label this project's own binding declares", () => {
		draw(
			<BindingReleaseRunnerField
				projectId={PROJECT_ID}
				binding={binding({
					bindingConfig: { releaseRunnerLabel: "release" },
					config: { releaseRunnerLabel: "release" },
				})}
				canEdit
			/>,
		);

		expect(screen.getByText("release")).toBeInTheDocument();
	});

	// The caveat criterion 22 put in the sentence, made operable: a clearing here
	// would remove nothing, and the reader is told so rather than finding out.
	it("says the label in force is the shared connection's where this binding declares none", () => {
		draw(
			<BindingReleaseRunnerField
				projectId={PROJECT_ID}
				binding={binding({ bindingConfig: {}, config: { releaseRunnerLabel: "other" } })}
				canEdit
			/>,
		);

		expect(screen.getByText("other")).toBeInTheDocument();
		expect(screen.getByText(/inherited from the shared connection/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
	});

	it("states where a release goes where neither tier declares a label", () => {
		draw(
			<BindingReleaseRunnerField projectId={PROJECT_ID} binding={binding()} canEdit />,
		);

		expect(
			screen.getByText("none — a release goes to any box in this project's pool"),
		).toBeInTheDocument();
	});

	// The binding summary's `config` is the overlay, so while this binding declares
	// a label the connection's is invisible here. The hint carries the caveat the
	// release warning carries rather than promising what a clearing cannot do.
	it("says a clearing falls back to the connection's label before one is taken", () => {
		draw(
			<BindingReleaseRunnerField
				projectId={PROJECT_ID}
				binding={binding({
					bindingConfig: { releaseRunnerLabel: "release" },
					config: { releaseRunnerLabel: "release" },
				})}
				canEdit
			/>,
		);

		expect(
			screen.getByText(/Clearing it falls back to the shared connection's label/),
		).toBeInTheDocument();
	});

	it("sends the typed label on the binding PATCH", () => {
		draw(
			<BindingReleaseRunnerField projectId={PROJECT_ID} binding={binding()} canEdit />,
		);

		fireEvent.change(screen.getByLabelText("Release runner label"), {
			target: { value: "release" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(updateBinding.mock.calls[0]?.[0]).toEqual({
			id: BINDING_ID,
			body: { config: { releaseRunnerLabel: "release" } },
		});
	});

	// Null and not an empty string: `withdrawNulls` on the binding PATCH removes
	// the key, and an empty string would be refused by the schema's `min(1)`.
	it("sends a null on the binding PATCH to clear it", () => {
		draw(
			<BindingReleaseRunnerField
				projectId={PROJECT_ID}
				binding={binding({
					bindingConfig: { releaseRunnerLabel: "release" },
					config: { releaseRunnerLabel: "release" },
				})}
				canEdit
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Clear" }));

		expect(updateBinding.mock.calls[0]?.[0]).toEqual({
			id: BINDING_ID,
			body: { config: { releaseRunnerLabel: null } },
		});
	});

	// No environment names a service binding, so a field there would offer a
	// setting that decides nothing.
	it("renders nothing for a service binding", () => {
		const { container } = draw(
			<BindingReleaseRunnerField
				projectId={PROJECT_ID}
				binding={binding({ role: "service" })}
				canEdit
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("offers no control to a caller who may not edit this project's integrations", () => {
		draw(
			<BindingReleaseRunnerField projectId={PROJECT_ID} binding={binding()} canEdit={false} />,
		);

		expect(screen.queryByLabelText("Release runner label")).not.toBeInTheDocument();
		expect(screen.getByText("Only a project admin can change this.")).toBeInTheDocument();
	});
});

describe("the release runner label on a shared connection", () => {
	it("renders for a connection some project binds as a deploy target", () => {
		draw(
			<ConnectionReleaseRunnerField
				connection={{ id: CONNECTION_ID, config: { releaseRunnerLabel: "other" } }}
				bindings={[binding()]}
				canManage
			/>,
		);

		expect(screen.getByText("other")).toBeInTheDocument();
		// A credential is not a project, so nothing here calls the pool one.
		expect(screen.queryByText(/this project's pool/)).not.toBeInTheDocument();
	});

	it("says what a credential declaring none means, which is not a project's pool", () => {
		draw(
			<ConnectionReleaseRunnerField
				connection={{ id: CONNECTION_ID, config: {} }}
				bindings={[binding()]}
				canManage
			/>,
		);

		expect(
			screen.getByText(
				"none — each project bound to this credential uses its own binding, or its own pool",
			),
		).toBeInTheDocument();
	});

	it("renders nothing for a connection no project binds as a deploy target", () => {
		const { container } = draw(
			<ConnectionReleaseRunnerField
				connection={{ id: CONNECTION_ID, config: {} }}
				bindings={[binding({ role: "service" })]}
				canManage
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("sends a null on the connection PATCH to clear it", () => {
		draw(
			<ConnectionReleaseRunnerField
				connection={{ id: CONNECTION_ID, config: { releaseRunnerLabel: "other" } }}
				bindings={[binding()]}
				canManage
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Clear" }));

		expect(updateConnection.mock.calls[0]?.[0]).toEqual({
			id: CONNECTION_ID,
			body: { config: { releaseRunnerLabel: null } },
		});
	});

	it("offers no control to a caller who may not manage the credential", () => {
		draw(
			<ConnectionReleaseRunnerField
				connection={{ id: CONNECTION_ID, config: {} }}
				bindings={[binding()]}
				canManage={false}
			/>,
		);

		expect(screen.queryByLabelText("Release runner label")).not.toBeInTheDocument();
		expect(
			screen.getByText(
				"Only the credential's owner, or an org owner or admin, can change this.",
			),
		).toBeInTheDocument();
	});
});
