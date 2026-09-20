// @vitest-environment jsdom

// ISS-1119 — the three states the one Forge version can be in. The in-flight
// state renders nothing on purpose; a failed one says so, because a silent gap
// there is the same lie an unreported runner version would be.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useForgeVersion = vi.fn();

vi.mock("../hooks", () => ({ useForgeVersion }));

const { ForgeVersion } = await import("./forge-version");

afterEach(() => {
	cleanup();
	useForgeVersion.mockReset();
});

describe("ForgeVersion", () => {
	it("renders nothing while the request is in flight", () => {
		useForgeVersion.mockReturnValue({ isPending: true, data: undefined });

		const { container } = render(<ForgeVersion />);

		expect(container.innerHTML).toBe("");
	});

	it("shows the version the deployment reported, labelled as Forge's", () => {
		useForgeVersion.mockReturnValue({
			isPending: false,
			data: { version: "0.3.0", sourceCommit: null, uptimeSeconds: 12 },
		});

		render(<ForgeVersion />);

		expect(screen.getByText("Forge v0.3.0")).toBeTruthy();
	});

	it("carries the serving commit in its tooltip when the deployment reports one", () => {
		useForgeVersion.mockReturnValue({
			isPending: false,
			data: {
				version: "0.3.0",
				sourceCommit: "749400892e520f64ea6dc380d390b8805b03b689",
				uptimeSeconds: 12,
			},
		});

		render(<ForgeVersion />);

		expect(screen.getByText("Forge v0.3.0").getAttribute("title")).toBe(
			"Forge v0.3.0 · 7494008",
		);
	});

	it("says the version is unavailable once the request has failed, rather than nothing", () => {
		useForgeVersion.mockReturnValue({ isPending: false, isError: true, data: undefined });

		render(<ForgeVersion />);

		expect(screen.getByText("Forge version unavailable")).toBeTruthy();
	});

	it("never substitutes a number for a version it does not have", () => {
		useForgeVersion.mockReturnValue({ isPending: false, isError: true, data: undefined });

		const { container } = render(<ForgeVersion />);

		expect(container.textContent).not.toMatch(/\d/);
	});
});
