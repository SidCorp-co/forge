// @vitest-environment jsdom
//
// The link beside a release sentence is how a person goes to find what stops the release, so it
// opens the statuses that sentence counts. Judge j16 followed "Open the issues at Awaiting release"
// from a sentence counting one issue at Testing and landed on an empty list (ISS-1229).

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReleaseBlockerCode } from "@forge/contracts";
import type { ReleaseReadiness } from "../types";

expect.extend(matchers);

/** What core sends an API caller beside the reader sentence these fixtures plant; never drawn. */
const CALLER_SENTENCE = "The caller's sentence, which this screen does not draw.";

const readiness = vi.fn();
vi.mock("../hooks", async (importActual) => {
	const actual = await importActual<typeof import("../hooks")>();
	return { ...actual, useReleaseReadiness: () => readiness() };
});

const { ReleaseAnswer } = await import("./release-section");
const { StrandedNotice } = await import("./shape-sections");

function blockedBy(blocker: ReleaseReadiness["blockers"][number]): ReleaseReadiness {
	return {
		hasReleaseGate: true,
		releaseChain: [{ branch: "main" }],
		releaseModel: "publish",
		releaseStrategy: null,
		baseBranch: "main",
		liveBranch: null,
		targetUndeclared: false,
		providers: ["coolify"],
		releaseRunnerLabel: null,
		rollback: null,
		rollbackMode: null,
		hasVerify: true,
		declarationRead: true,
		channelsRead: true,
		blockers: [blocker],
		warnings: [],
		gaps: [],
	} as ReleaseReadiness;
}

function drawWith(blocker: ReleaseReadiness["blockers"][number]) {
	readiness.mockReturnValue({ isLoading: false, isError: false, data: blockedBy(blocker) });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<ReleaseAnswer projectId="p-1" slug="desk" />
		</QueryClientProvider>,
	);
}

function issueLinks(container: HTMLElement): { text: string; href: string | null }[] {
	return [...container.querySelectorAll("li a")].map((a) => ({
		text: a.textContent ?? "",
		href: a.getAttribute("href"),
	}));
}

afterEach(cleanup);

describe("the issue link beside a release sentence opens what that sentence counts", () => {
	it("opens Testing and Tested where the sentence counts issues near the gate", () => {
		const { container } = drawWith({
			code: "RELEASE_ROSTER_EMPTY",
			evaluated: true,
			message: CALLER_SENTENCE,
			reader:
				"Nothing is ready to release: 1 issue is at Testing or Tested, and each moves to Awaiting release once it records where its change now runs.",
			details: { nearGate: 1 },
		});

		expect(issueLinks(container)).toEqual([
			{
				text: "Open the issue at Testing or Tested",
				href: "/projects/desk/issues?status=testing,tested",
			},
		]);
	});

	it("offers no issue link where the sentence counts no issue at any status", () => {
		const { container } = drawWith({
			code: "RELEASE_ROSTER_EMPTY",
			evaluated: true,
			message: CALLER_SENTENCE,
			reader: "Nothing is ready to release: no issue is at Testing, Tested or Awaiting release.",
			details: { nearGate: 0 },
		});

		expect(screen.getByText(/no issue is at Testing, Tested or Awaiting release/)).toBeInTheDocument();
		expect(issueLinks(container)).toEqual([]);
	});

	it("offers no issue link where the roster is empty and nothing says what is near it", () => {
		const { container } = drawWith({
			code: "RELEASE_ROSTER_EMPTY",
			evaluated: true,
			message: CALLER_SENTENCE,
			reader: "Nothing is ready to release: no issue is at Awaiting release.",
		});

		expect(issueLinks(container)).toEqual([]);
	});

	it("still opens Awaiting release where the sentence is about the issues waiting there", () => {
		const { container } = drawWith({
			code: "RELEASE_CRITERIA_UNEARNED",
			evaluated: true,
			message: CALLER_SENTENCE,
			reader:
				"Every issue at Awaiting release still owes a verdict on an acceptance criterion, so the automatic release cuts nothing until each is recorded: `ISS-4` owes criteria 1–3.",
		});

		expect(issueLinks(container)).toEqual([
			{
				text: "Open the issues at Awaiting release",
				href: "/projects/desk/issues?status=awaiting_release",
			},
		]);
	});
});

type Planted = { details?: Record<string, unknown>; links: { text: string; href: string }[] };

const issuePage = (id: string) => ({ text: id, href: `/projects/desk/issues/${id}` });
const AWAITING = { text: "Open the issues at Awaiting release", href: "/projects/desk/issues?status=awaiting_release" };

/** Every code core sends, with what its sentence names and so where its link goes (ISS-1229 j17).
 *  Keyed by the union, so a code core adds is a type error here until somebody decides it. */
const EVERY_CODE: Record<ReleaseBlockerCode, Planted> = {
	NO_RELEASE_GATE: { links: [] },
	RELEASE_TARGET_UNDECLARED: {
		links: [{ text: "Add a live deploy target", href: "/projects/desk/settings?tab=integrations&add=live-deploy-target" }],
	},
	CLAIM_CONFLICT: {
		details: {
			issueIds: ["u-4"],
			projectId: "p-1",
			gateStatus: "awaiting_release",
			conflicts: [{ id: "u-4", key: "ISS-4", standing: "status", status: "testing" }],
		},
		links: [issuePage("ISS-4")],
	},
	RELEASE_ROSTER_EMPTY: {
		details: { nearGate: 2 },
		links: [{ text: "Open the issues at Testing or Tested", href: "/projects/desk/issues?status=testing,tested" }],
	},
	RELEASE_ROSTER_OVERSIZE: { details: { waiting: 51 }, links: [AWAITING] },
	RELEASE_RECORD_MISSING: {
		details: { issueIds: ["u-4", "u-7"], displayIds: ["ISS-4", "ISS-7"] },
		links: [issuePage("ISS-4"), issuePage("ISS-7")],
	},
	RELEASE_WORK_UNMERGED: { details: { issueIds: ["u-5"], displayIds: ["ISS-5"] }, links: [issuePage("ISS-5")] },
	RELEASE_ISSUES_UNCLOSABLE: { details: { issueIds: ["u-6"], displayIds: ["ISS-6"] }, links: [issuePage("ISS-6")] },
	RELEASE_RUNNER_AMBIGUOUS: {
		links: [{ text: "Reconcile the release runner labels", href: "/projects/desk/settings?tab=integrations" }],
	},
	RELEASE_PROBES_UNREADABLE: {
		links: [{ text: "Correct the probe's url", href: "/projects/desk/settings?tab=integrations" }],
	},
	RELEASE_POOL_EMPTY: { links: [{ text: "Assign a runner", href: "/projects/desk/settings?tab=runners" }] },
	NO_RUNNER_ONLINE: { links: [{ text: "See the runners", href: "/projects/desk/settings?tab=runners" }] },
	BATCH_IN_FLIGHT: { links: [] },
	RELEASE_CRITERIA_UNEARNED: { links: [AWAITING] },
	RELEASE_RUNTIME_UNROUTED: { details: { missing: "a live commit endpoint" }, links: [AWAITING] },
	RELEASE_CARRIES_UNDECIDED: {
		details: { carried: [{ displayId: "ISS-8", status: "developed" }], start: "dev", cut: "abc", live: "main" },
		links: [issuePage("ISS-8")],
	},
	RELEASE_CARRIED_DECISION_REFUSED: {
		details: { refused: [{ displayId: "ISS-9", decision: "revert", why: "not reverted" }] },
		links: [issuePage("ISS-9")],
	},
	RELEASE_CUT_DROPS_ROSTER: { details: { issueIds: ["u-3"], displayIds: ["ISS-3"], cut: "abc" }, links: [issuePage("ISS-3")] },
	RELEASE_CHECK_UNEVALUATED: { details: { check: "criteria" }, links: [] },
};

function linksOf(container: HTMLElement) {
	return [...container.querySelectorAll("li a")].map((a) => ({
		text: a.textContent ?? "",
		href: a.getAttribute("href") ?? "",
	}));
}

describe("a link beside a release sentence opens exactly the set that sentence names", () => {
	for (const [code, planted] of Object.entries(EVERY_CODE)) {
		it(`${code}: ${planted.links.length === 0 ? "no link" : planted.links.map((l) => l.text).join(", ")}`, () => {
			const { container } = drawWith({
				code,
				evaluated: code !== "RELEASE_CHECK_UNEVALUATED",
				message: CALLER_SENTENCE,
			reader: `The sentence core sends for ${code}.`,
				...(planted.details ? { details: planted.details } : {}),
			});
			expect(linksOf(container)).toEqual(planted.links);
		});
	}

	it("links the issue a running release's question is open on", () => {
		const { container } = drawWith({
			code: "BATCH_IN_FLIGHT",
			evaluated: true,
			message: CALLER_SENTENCE,
			reader: "A release is already running for this project and is waiting on a decision.",
			details: { decision: { displayId: "ISS-12" } },
		});
		expect(linksOf(container)).toEqual([issuePage("ISS-12")]);
	});

	it("offers no link for a code this screen does not know", () => {
		const { container } = drawWith({ code: "RELEASE_SOMETHING_NEW", evaluated: true, message: CALLER_SENTENCE,
			reader: "Something new stops it." });
		expect(screen.getByText("Something new stops it.")).toBeInTheDocument();
		expect(linksOf(container)).toEqual([]);
	});

	it("names the issues it links after the word Open", () => {
		const { container } = drawWith({
			code: "RELEASE_RECORD_MISSING",
			evaluated: true,
			message: CALLER_SENTENCE,
			reader: "2 issues named here have no release note.",
			details: { issueIds: ["u-4", "u-7"], displayIds: ["ISS-4", "ISS-7"] },
		});
		expect(container.querySelector("li [data-testid='release-named-issues']")?.textContent).toBe("Open ISS-4, ISS-7");
	});
});

// Judge-23 read "Check the live binding's probes" under a sentence naming two bindings (ISS-1229
// r10): a link refers back to what its sentence counts, so its label follows that count too.
type Counted = { one: Record<string, unknown>; two: Record<string, unknown>; labels: [string, string] };

const SETTINGS = "/projects/desk/settings";

/** Every code, with the details its sentence counts by at one and at two and the label each draws;
 *  a code whose sentence counts nothing its link names says why instead. */
const EVERY_COUNT: Record<ReleaseBlockerCode, Counted | string> = {
	NO_RELEASE_GATE: "no link",
	RELEASE_TARGET_UNDECLARED: "the sentence counts no target; the link adds one",
	CLAIM_CONFLICT: "links each issue by its own name",
	RELEASE_ROSTER_EMPTY: {
		one: { nearGate: 1 },
		two: { nearGate: 2 },
		labels: ["Open the issue at Testing or Tested", "Open the issues at Testing or Tested"],
	},
	RELEASE_ROSTER_OVERSIZE: "the sentence counts more than a release carries, never one",
	RELEASE_RECORD_MISSING: "links each issue by its own name",
	RELEASE_WORK_UNMERGED: "links each issue by its own name",
	RELEASE_ISSUES_UNCLOSABLE: "links each issue by its own name",
	RELEASE_RUNNER_AMBIGUOUS: "the sentence names two labels or more, never one",
	RELEASE_PROBES_UNREADABLE: {
		one: { urls: [], bindings: ["coolify-a"] },
		two: { urls: [], bindings: ["coolify-a", "coolify-b"] },
		labels: ["Check the live binding's verify step", "Check the live bindings' verify steps"],
	},
	RELEASE_POOL_EMPTY: "the sentence counts no runner; the link pairs one",
	NO_RUNNER_ONLINE: {
		one: { runners: [{ deviceName: "box-a" }] },
		two: { runners: [{ deviceName: "box-a" }, { deviceName: "box-b" }] },
		labels: ["See the runner", "See the runners"],
	},
	BATCH_IN_FLIGHT: "links the issue its question is open on, by name",
	RELEASE_CRITERIA_UNEARNED: {
		one: { held: [{ issueId: "u-4", displayId: "ISS-4", criteria: [1] }] },
		two: {
			held: [
				{ issueId: "u-4", displayId: "ISS-4", criteria: [1] },
				{ issueId: "u-5", displayId: "ISS-5", criteria: [2] },
			],
		},
		labels: ["Open the issue at Awaiting release", "Open the issues at Awaiting release"],
	},
	RELEASE_RUNTIME_UNROUTED: {
		one: { missing: "a live commit endpoint", held: [{ issueId: "u-4", displayId: "ISS-4", criteria: [1] }] },
		two: {
			missing: "a live commit endpoint",
			held: [
				{ issueId: "u-4", displayId: "ISS-4", criteria: [1] },
				{ issueId: "u-5", displayId: "ISS-5", criteria: [2] },
			],
		},
		labels: ["Open the issue at Awaiting release", "Open the issues at Awaiting release"],
	},
	RELEASE_CARRIES_UNDECIDED: "links each issue by its own name",
	RELEASE_CARRIED_DECISION_REFUSED: "links each issue by its own name",
	RELEASE_CUT_DROPS_ROSTER: "links each issue by its own name",
	RELEASE_CHECK_UNEVALUATED: "no link",
};

describe("a link beside a counted release sentence agrees with that count", () => {
	const linkText = (code: string, details: Record<string, unknown>) =>
		linksOf(
			drawWith({ code, evaluated: true, message: CALLER_SENTENCE, reader: `The sentence for ${code}.`, details })
				.container,
		).map((l) => l.text);

	for (const [code, counted] of Object.entries(EVERY_COUNT)) {
		if (typeof counted === "string") continue;
		it(`${code}: "${counted.labels[0]}" at one`, () => {
			expect(linkText(code, counted.one)).toEqual([counted.labels[0]]);
		});
		it(`${code}: "${counted.labels[1]}" at two`, () => {
			expect(linkText(code, counted.two)).toEqual([counted.labels[1]]);
		});
	}

	it("names the probe url where the sentence names no binding, at one and at two", () => {
		expect(linkText("RELEASE_PROBES_UNREADABLE", { urls: ["api/version"] })).toEqual(["Correct the probe's url"]);
		expect(linkText("RELEASE_PROBES_UNREADABLE", { urls: ["api/version", "health"] })).toEqual([
			"Correct the probes' urls",
		]);
	});

	it("counts a binding beside a bad probe url as two places to look", () => {
		expect(linkText("RELEASE_PROBES_UNREADABLE", { urls: ["api/version"], bindings: ["coolify-a"] })).toEqual([
			"Check the live bindings' verify steps",
		]);
	});

	it("opens the runners tab and the integrations tab whatever the count", () => {
		const hrefs = (code: string, details: Record<string, unknown>) =>
			linksOf(
				drawWith({ code, evaluated: true, message: CALLER_SENTENCE, reader: "x", details }).container,
			).map((l) => l.href);
		expect(hrefs("NO_RUNNER_ONLINE", { runners: [{ deviceName: "box-a" }] })).toEqual([`${SETTINGS}?tab=runners`]);
		expect(hrefs("RELEASE_PROBES_UNREADABLE", { urls: [], bindings: ["a", "b"] })).toEqual([
			`${SETTINGS}?tab=integrations`,
		]);
	});
});

// The coordinator saw an empty band and a second hairline between the last reason and the stranded
// notice under it (ISS-1229 r7): the notice joins the list it follows, one divider between them.
describe("a notice after the release answer", () => {
	function drawAnswer(data: ReleaseReadiness) {
		readiness.mockReturnValue({ isLoading: false, isError: false, data });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		return render(
			<QueryClientProvider client={client}>
				<ReleaseAnswer projectId="p-1" slug="desk" after={<StrandedNotice waiting={2} slug="desk" />} />
			</QueryClientProvider>,
		);
	}

	it("follows a list of reasons with no gap, its top hairline laid on the list's last one", () => {
		const { container } = drawAnswer(
			blockedBy({ code: "BATCH_IN_FLIGHT", evaluated: true, message: CALLER_SENTENCE,
			reader: "A release is already running." }),
		);
		const notice = screen.getByTestId("stranded-notice");
		const holder = notice.parentElement as HTMLElement;
		expect(holder.previousElementSibling?.tagName).toBe("UL");
		expect(holder.className.split(" ")).toContain("-mt-px");
		expect(holder.className.split(" ")).not.toContain("mt-3");
		expect(container.querySelectorAll("[data-testid=stranded-notice]")).toHaveLength(1);
	});

	it("keeps its own space under an answer that lists nothing", () => {
		drawAnswer({ ...blockedBy({ code: "X", evaluated: true, message: CALLER_SENTENCE,
			reader: "x" }), blockers: [], hasReleaseGate: false });
		const holder = screen.getByTestId("stranded-notice").parentElement as HTMLElement;
		expect(holder.className.split(" ")).toContain("mt-3");
	});
});
