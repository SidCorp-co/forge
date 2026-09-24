// @vitest-environment jsdom
//
// ISS-1234 criteria 21, 22 and 23. A failed pool read must never read as an
// empty pool; the runner card is where the runner record is read, so it is where
// a box that cannot see its queue says so.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunnerPoolRead } from "../types";

const { PoolReadBanner } = await import("./pool-read");

const MIN = 60_000;

const blind = (over: Partial<RunnerPoolRead> = {}): RunnerPoolRead => ({
	verdict: "blind",
	failures: 30,
	countIsFloor: false,
	windowMs: 86_400_000,
	unreadSince: Date.now() - 5 * MIN,
	consecutive: 30,
	recoveredAt: null,
	lastFailure: {
		at: Date.now() - 10_000,
		status: 525,
		what: "525 (gateway: the TLS handshake with the origin failed)",
		reason: "pool 525 (gateway: the TLS handshake with the origin failed): <!DOCTYPE html>",
	},
	receivedAt: new Date().toISOString(),
	...over,
});

const intermittent = (over: Partial<RunnerPoolRead> = {}): RunnerPoolRead => ({
	...blind(),
	verdict: "intermittent",
	failures: 3,
	unreadSince: null,
	consecutive: 0,
	recoveredAt: Date.now() - 50 * MIN,
	lastFailure: {
		at: Date.now() - 60 * MIN,
		status: 520,
		what: "520 (gateway: the origin returned an unknown error)",
		reason: "pool 520 (gateway: the origin returned an unknown error)",
	},
	...over,
});

/** The Banner states its tone only as its colours, so that is what is read. */
const toneOf = (container: HTMLElement) =>
	(container.firstElementChild as HTMLElement | null)?.getAttribute("style") ?? "";

afterEach(cleanup);

describe("a box that cannot read the pool now", () => {
	it("says so as a danger, with the status and since when", () => {
		const { container } = render(<PoolReadBanner poolRead={blind()} />);
		const text = container.textContent ?? "";
		expect(screen.getByText(/this box cannot read the project's job pool/i)).toBeTruthy();
		expect(text).toContain("525 (gateway: the TLS handshake with the origin failed)");
		expect(text).toMatch(/unread since 5m ago/);
		expect(text).toMatch(/30\s+consecutive failed read/);
		expect(text).toMatch(/not the same as an empty one/);
		expect(toneOf(container)).toContain("--red-600");
	});

	it("names the transport's reason where no status came back", () => {
		const { container } = render(
			<PoolReadBanner
				poolRead={blind({
					lastFailure: {
						at: Date.now() - 10_000,
						status: null,
						what: "pool request: operation timed out",
						reason: "pool request: operation timed out",
					},
				})}
			/>,
		);
		const text = container.textContent ?? "";
		expect(text).toContain("pool request: operation timed out");
		expect(text).not.toMatch(/null|undefined/);
	});
});

describe("a box that failed a read and reads again", () => {
	it("says so as an attention, with the count in the window and the newest status", () => {
		const { container } = render(<PoolReadBanner poolRead={intermittent()} />);
		const text = container.textContent ?? "";
		expect(text).toMatch(/^3 failed pool read\(s\) in the last 24h/);
		expect(text).toContain("520 (gateway: the origin returned an unknown error)");
		expect(text).toMatch(/newest 1h ago/);
		expect(text).toMatch(/reading\s+again since 50m ago/i);
		expect(toneOf(container)).toContain("--amberw-600");
	});

	it("says at least where the box dropped failures past its cap", () => {
		const { container } = render(
			<PoolReadBanner poolRead={intermittent({ failures: 200, countIsFloor: true })} />,
		);
		expect(container.textContent).toMatch(/^At least 200 failed pool read\(s\)/);
	});
});

describe("a report the box stopped renewing", () => {
	const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();

	it("dates a blind report and does not state it in the present tense", () => {
		const { container } = render(
			<PoolReadBanner poolRead={blind({ receivedAt: twoDaysAgo })} />,
		);
		const text = container.textContent ?? "";
		expect(text).toMatch(/could not read the project's job pool when it last reported/);
		expect(text).not.toMatch(/cannot read/);
		expect(text).toMatch(/This is the box's last report,\s+2d ago; nothing newer has arrived/);
	});

	it("dates an intermittent report and puts its window before that report", () => {
		const { container } = render(
			<PoolReadBanner poolRead={intermittent({ receivedAt: twoDaysAgo })} />,
		);
		const text = container.textContent ?? "";
		expect(text).toMatch(/^3 failed pool read\(s\) in the 24h before its last report/);
		expect(text).not.toMatch(/in the last 24h/);
		expect(text).toMatch(/last report,\s+2d ago/);
	});

	it("reads a report heard inside the renewal window as current", () => {
		const { container } = render(
			<PoolReadBanner
				poolRead={blind({ receivedAt: new Date(Date.now() - 60_000).toISOString() })}
			/>,
		);
		expect(container.textContent).not.toMatch(/last report/);
	});
});

describe("a box that reported no failed read", () => {
	it("shows nothing at all, for null and for a core that does not serve the field", () => {
		const a = render(<PoolReadBanner poolRead={null} />);
		expect(a.container.textContent).toBe("");
		cleanup();
		const b = render(<PoolReadBanner poolRead={undefined} />);
		expect(b.container.textContent).toBe("");
	});
});
