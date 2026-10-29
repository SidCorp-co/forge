import { describe, expect, it } from "vitest";
import {
	GATE_CATALOG,
	GATE_IDS,
	type GateId,
	gateSays,
	gatesConfigSchema,
	KERNEL_RULES,
	projectGate,
	projectGates,
} from "./gate-profiles.js";
import { effectiveApprovals } from "./person-gates.js";

const modeOf = (
	doc: Parameters<typeof projectGate>[0],
	id: GateId,
	policy: Parameters<typeof projectGate>[1] = null,
) => projectGate(doc, policy, id).mode;

describe("REQ-76 BC-1: the catalog names every policy gate, what it refuses and its default in each profile", () => {
	it("gives every gate a title, a refusal, a place and a default for strict, standard and yolo within its modes", () => {
		expect(GATE_CATALOG.length).toBeGreaterThan(20);
		for (const g of GATE_CATALOG) {
			expect(g.title, g.id).not.toBe("");
			expect(g.refuses, g.id).not.toBe("");
			expect(g.at, g.id).not.toBe("");
			for (const profile of ["strict", "standard", "yolo"] as const) {
				const d = g.defaults[profile];
				if (typeof d === "string") expect(g.modes, `${g.id} ${profile}`).toContain(d);
				else expect(d.key, `${g.id} ${profile}`).not.toBe("");
			}
		}
	});

	it("keeps the kernel out of the catalog", () => {
		const kernel = KERNEL_RULES.map((k) => k.id) as readonly string[];
		expect(GATE_IDS.filter((id) => kernel.includes(id))).toEqual([]);
	});
});

describe("REQ-76 BC-2: no gates declared reads as today's gates", () => {
	it("resolves an absent profile as standard, and a keyed gate from its own switch", () => {
		expect(projectGate(null, null, "issue_ready")).toMatchObject({
			profile: "standard",
			mode: "enforce",
			from: "profile",
		});
		expect(projectGate(null, null, "approval_admit")).toMatchObject({
			mode: "off",
			from: "key",
			key: "approvals.admit",
		});
		expect(modeOf({ approvals: { admit: true } }, "approval_admit")).toBe("enforce");
		expect(modeOf({ plan: { approval: { required: true } } }, "plan_approval")).toBe("enforce");
		expect(modeOf(null, "plan_approval")).toBe("off");
		expect(modeOf({ validation: { mergeCheck: "required" } }, "merge_check")).toBe("enforce");
		expect(modeOf(null, "independent_qa", { qa: "independent" })).toBe("enforce");
		expect(modeOf(null, "intake", { intake: { mode: "manual" } })).toBe("enforce");
		expect(modeOf({ release: { approval: { required: true } } }, "release_approval")).toBe("enforce");
	});

	it("leaves the person gates exactly as the approvals switches say", () => {
		expect(effectiveApprovals({ approvals: { agree: true } })).toMatchObject({ agree: true, admit: false });
	});
});

describe("REQ-76 profiles", () => {
	it("strict enforces every gate that has no switch of its own to read", () => {
		const doc = { gates: { profile: "strict" as const } };
		for (const g of projectGates(doc, null)) {
			if (g.from === "profile") expect(g.mode, g.id).toBe("enforce");
		}
		expect(modeOf(doc, "approval_admit")).toBe("enforce");
		expect(modeOf(doc, "plan_approval")).toBe("enforce");
	});

	it("yolo turns the acts BC-4..BC-9 name off or to advice, and keeps the take and feedback gates", () => {
		const doc = { gates: { profile: "yolo" as const }, approvals: { admit: true, agree: true } };
		expect(modeOf(doc, "issue_ready")).toBe("advise"); // BC-4
		expect(modeOf(doc, "link_requirement_agreed")).toBe("off"); // BC-4
		expect(modeOf(doc, "plan_approval")).toBe("off"); // BC-4
		expect(modeOf(doc, "requirement_ready")).toBe("advise"); // BC-5
		expect(modeOf(doc, "scope_hold")).toBe("off"); // BC-6
		expect(modeOf(doc, "builder_verdict")).toBe("off"); // BC-7
		expect(modeOf(doc, "release_approval")).toBe("off"); // BC-7
		expect(modeOf(doc, "issue_before_code")).toBe("off"); // BC-8
		expect(modeOf(doc, "master_admitted_only")).toBe("off"); // BC-9
		expect(modeOf(doc, "chat_files_issue")).toBe("off"); // BC-9
		// a switch set under standard does not outlive the profile that defers to it
		expect(modeOf(doc, "approval_admit")).toBe("off");
		expect(modeOf(doc, "take_blocked")).toBe("enforce");
		expect(modeOf(doc, "feedback_triage")).toBe("enforce");
	});
});

describe("REQ-76 BC-3: one gate is overridden on its own", () => {
	it("an override wins over the profile and names its key", () => {
		const doc = { gates: { profile: "yolo" as const, overrides: { scope_hold: "enforce" as const } } };
		expect(projectGate(doc, null, "scope_hold")).toMatchObject({
			mode: "enforce",
			from: "override",
			key: "gates.overrides.scope_hold",
		});
		expect(modeOf(doc, "design_record")).toBe("off");
	});

	it("refuses an override naming a kernel rule or an unknown gate, and a profile it does not know (BC-10)", () => {
		expect(gatesConfigSchema.safeParse({ profile: "yolo", overrides: { merged: "off" } }).success).toBe(false);
		expect(gatesConfigSchema.safeParse({ profile: "yolo", overrides: { nonsense: "off" } }).success).toBe(false);
		expect(gatesConfigSchema.safeParse({ profile: "loose" }).success).toBe(false);
	});
});

describe("REQ-76 BC-11: a refusal names the gate, the profile and the key", () => {
	it("says which gate, by what, and the override that relaxes it", () => {
		expect(gateSays(projectGate({ gates: { profile: "strict" } }, null, "scope_hold"))).toBe(
			"Gate scope_hold is enforced by this project's gate profile strict (gates.profile); gates.overrides.scope_hold relaxes it.",
		);
		expect(gateSays(projectGate({ approvals: { admit: true } }, null, "approval_admit"))).toBe(
			"Gate approval_admit is enforced by this project's approvals.admit setting, which its gate profile standard defers to; changing approvals.admit, or gates.overrides.approval_admit, relaxes it.",
		);
		expect(
			gateSays(projectGate({ gates: { profile: "yolo", overrides: { scope_hold: "enforce" } } }, null, "scope_hold")),
		).toContain("this project's override gates.overrides.scope_hold");
	});
});
