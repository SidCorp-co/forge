// @vitest-environment jsdom
//
// ISS-1118 criteria 23, 24, 26 and 28. The Outcome this issue was filed for is
// that an owner can see, from the runner surface, whether a project keeps a
// resident master on a box and change it without guessing which of three
// controls governs it. Every assertion here is one half of that sentence.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

const { ResidentMaster } = await import("./resident-master");

const LIVE = {
	sessionId: "8f4b1f0c-7a2e-4f1a-9c3d-2b6e5a1d4c88",
	name: "forge-master-forge-dev",
	lastHeartbeatAt: new Date(Date.now() - 45_000).toISOString(),
};

afterEach(cleanup);

describe("what the screen says about a box that holds one", () => {
	it("says a resident master session is running on this box for this project", () => {
		render(
			<ResidentMaster master={LIVE} slug="forge-dev" deviceName="sid-desk" />,
		);

		expect(screen.getByText(/running one for this project/i)).toBeTruthy();
	});

	it("names the terminal session, so a reader can match it on the box", () => {
		render(
			<ResidentMaster master={LIVE} slug="forge-dev" deviceName="sid-desk" />,
		);

		expect(screen.getByText("forge-master-forge-dev")).toBeTruthy();
	});

	it("says when it last reported rather than calling it alive, because core cannot see the box's terminal", () => {
		render(
			<ResidentMaster master={LIVE} slug="forge-dev" deviceName="sid-desk" />,
		);

		expect(screen.getByText(/last reported/i)).toBeTruthy();
	});
});

describe("what it says about a box that holds none", () => {
	it("reads as none registered, not as an absent or unknown row", () => {
		render(
			<ResidentMaster master={null} slug="forge-dev" deviceName="sid-desk" />,
		);

		expect(
			screen.getByText(/no resident master session is registered/i),
		).toBeTruthy();
	});

	it("still names the controls, because the owner reading this is deciding what to do next", () => {
		render(
			<ResidentMaster master={null} slug="forge-dev" deviceName="sid-desk" />,
		);

		expect(
			screen.getByText(/forge-runner master stand-down forge-dev/),
		).toBeTruthy();
	});
});

describe("the control it names, and the guessing it ends", () => {
	it("names the command that stops one and the command that puts it back", () => {
		render(
			<ResidentMaster master={LIVE} slug="forge-dev" deviceName="sid-desk" />,
		);

		expect(
			screen.getByText(/forge-runner master stand-down forge-dev/),
		).toBeTruthy();
		expect(
			screen.getByText(/forge-runner master stand-up\s+forge-dev/),
		).toBeTruthy();
	});

	it("names the device the command has to be run on, since the standing is that box's own record", () => {
		render(
			<ResidentMaster master={LIVE} slug="forge-dev" deviceName="sid-desk" />,
		);

		expect(screen.getByText(/on sid-desk/)).toBeTruthy();
	});

	it("says the pool control and turning the device off reach none of it", () => {
		render(
			<ResidentMaster master={LIVE} slug="forge-dev" deviceName="sid-desk" />,
		);

		const said = screen.getByText(/pool control above does not govern it/i);
		expect(said.textContent).toMatch(/turning the device off/i);
		expect(said.textContent).toMatch(/ends? a session already running|neither ends a session/i);
	});

	it("does not promise the session stops, because a session holding live runs is left alone", () => {
		render(
			<ResidentMaster master={LIVE} slug="forge-dev" deviceName="sid-desk" />,
		);

		const said = screen.getByText(/stops a replacement being placed/i);
		expect(said.textContent).toMatch(/holds live runs/i);
		expect(said.textContent).toMatch(/cannot establish what it holds/i);
		expect(said.textContent).toMatch(/--force/);
		expect(said.textContent).toMatch(/work it was holding/i);
	});
});

describe("a row this screen cannot name a project for", () => {
	it("prints a placeholder rather than an empty command an operator would paste", () => {
		render(
			<ResidentMaster master={null} slug={undefined} deviceName={null} />,
		);

		expect(
			screen.getByText(/forge-runner master stand-down <project>/),
		).toBeTruthy();
		expect(screen.getByText(/on that device/)).toBeTruthy();
	});
});
