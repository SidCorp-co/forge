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
	it("says a resident master session is registered on this box for this project", () => {
		render(
			<ResidentMaster master={LIVE} slug="forge-dev" deviceName="sid-desk" />,
		);

		expect(
			screen.getByText(/one is registered on this box for this project/i),
		).toBeTruthy();
	});

	it("does not claim the session is running now, which a registration does not prove", () => {
		render(
			<ResidentMaster master={LIVE} slug="forge-dev" deviceName="sid-desk" />,
		);

		const said = screen.getByText(/one is registered on this box/i);
		expect(said.textContent).toMatch(/not what its terminal is doing now/i);
		expect(said.textContent).toMatch(/went quiet/i);
	});

	it("says the same of a stale registration, where the box stopped reporting a day ago", () => {
		render(
			<ResidentMaster
				master={{ ...LIVE, lastHeartbeatAt: new Date(Date.now() - 86_400_000).toISOString() }}
				slug="forge-dev"
				deviceName="sid-desk"
			/>,
		);

		const said = screen.getByText(/one is registered on this box/i);
		expect(said.textContent).toMatch(/not what its terminal is doing now/i);
	});

	it("says the same of one that has never reported at all", () => {
		render(
			<ResidentMaster
				master={{ ...LIVE, lastHeartbeatAt: null }}
				slug="forge-dev"
				deviceName="sid-desk"
			/>,
		);

		const said = screen.getByText(/one is registered on this box/i);
		expect(said.textContent).toMatch(/last reported never/i);
		expect(said.textContent).toMatch(/not what its terminal is doing now/i);
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

describe("a core that does not serve the field at all", () => {
	it("says the question could not be answered, never that there is none", () => {
		render(
			<ResidentMaster
				master={undefined}
				slug="forge-dev"
				deviceName="sid-desk"
			/>,
		);

		expect(
			screen.getByText(/does not report resident master sessions/i),
		).toBeTruthy();
		expect(
			screen.queryByText(/no resident master session is registered/i),
		).toBeNull();
	});

	it("still names the controls, because the reader is still deciding what to do", () => {
		render(
			<ResidentMaster
				master={undefined}
				slug="forge-dev"
				deviceName="sid-desk"
			/>,
		);

		expect(
			screen.getByText(/forge-runner master stand-down forge-dev/),
		).toBeTruthy();
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
