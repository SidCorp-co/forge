// ISS-276 / FB-87: master passes were refused 16:02Z-16:34Z with "resets 2:30am (Asia/Ho_Chi_Minh)"
// (19:30Z) and the 16:42Z pass ran. The Passes table reads a refused pass as refused, next try at the
// next nudge, keeps the account's own words only as what it said, and marks the pass that recovered.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MasterClosedPass } from "../types";
import { PassesTable } from "./master-views";

const WORDS = "You've hit your session limit · resets 2:30am (Asia/Ho_Chi_Minh)";

const pass = (over: Partial<MasterClosedPass>): MasterClosedPass => ({
	id: "p1",
	sessionId: "s1",
	verb: "dispatch",
	startedAt: "2026-10-06T16:02:00Z",
	endedAt: "2026-10-06T16:02:05Z",
	issueKey: null,
	trigger: "nudge",
	dispatched: [],
	skipped: [],
	parked: [],
	refused: null,
	recovers: null,
	closeReason: "turn_ended",
	...over,
});

const refused = pass({ id: "refused", refused: { reason: "usage_limit", detail: WORDS } });
const recovered = pass({
	id: "recovered",
	startedAt: "2026-10-06T16:42:00Z",
	endedAt: "2026-10-06T16:44:00Z",
	dispatched: ["ISS-253"],
	recovers: { refusedSince: "2026-10-06T16:02:00Z", refusedPasses: 4, reason: "usage_limit" },
});

const rowOf = (id: string) => {
	const rows = screen.getAllByRole("row").slice(1);
	const at = [recovered, refused].findIndex((p) => p.id === id);
	const row = rows[at];
	if (!row) throw new Error(`no row for pass ${id}`);
	return row;
};

describe("the Passes table", () => {
	it("reads a refused pass as refused, with its next try at the next nudge", () => {
		render(<PassesTable items={[recovered, refused]} hasMore={false} slug="forge" />);
		expect(rowOf("refused")).toHaveTextContent("Refused before it ran: usage limit; next try at the next nudge");
	});

	it("keeps the account's own words only as what it said, never as the time work resumes", () => {
		render(<PassesTable items={[recovered, refused]} hasMore={false} slug="forge" />);
		const row = rowOf("refused");
		expect(within(row).getByTitle(`The account said: ${WORDS}`)).toBeInTheDocument();
		expect(row.textContent).not.toMatch(/2:30am|resets/);
	});

	it("marks the first pass that ran after the refusals as the recovery", () => {
		render(<PassesTable items={[recovered, refused]} hasMore={false} slug="forge" />);
		const mark = within(rowOf("recovered")).getByText("recovered");
		expect(mark.getAttribute("title")).toMatch(/^Recovered: the account answered again after 4 refused passes since /);
		expect(within(rowOf("refused")).queryByText("recovered")).toBeNull();
	});
});
