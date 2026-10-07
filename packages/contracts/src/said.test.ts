import { describe, expect, it } from "vitest";
import { type Said, SAID_ENTRIES, SAID_KINDS, SaidRefused, saidDisagreements, saidSchema, say, sayEn, verbatim } from "./said.js";
import { waitingOn } from "./standing.js";

// A sentence core says is a registry key and typed values. A key the registry lacks, a value its
// template is not given, or a value of the wrong kind is refused where the sentence is built, by
// name, so no producer can ship a key a reader cannot read.

const refusal = (f: () => unknown): string => {
	try {
		f();
	} catch (err) {
		if (err instanceof SaidRefused) return err.code;
		throw err;
	}
	return "not refused";
};

describe("the registry", () => {
	it("declares every value its English template fills, of a known kind", () => {
		const wrong: string[] = [];
		for (const [key, entry] of Object.entries(SAID_ENTRIES)) {
			const slots = new Set([...entry.en.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string));
			const vars = Object.entries(entry.vars ?? {});
			for (const s of slots) if (!vars.some(([n]) => n === s)) wrong.push(`${key}: {${s}} undeclared`);
			for (const [n, k] of vars) {
				if (!slots.has(n)) wrong.push(`${key}: {${n}} declared and unused`);
				if (!(SAID_KINDS as readonly string[]).includes(k)) wrong.push(`${key}: {${n}} of unknown kind ${k}`);
			}
		}
		expect(wrong).toEqual([]);
	});
});

describe("saying a sentence", () => {
	it("refuses a key the registry lacks, by name", () => {
		expect(refusal(() => (say as (key: string) => Said)("standing.act.noSuchAct"))).toBe("SAID_KEY_UNKNOWN");
		expect(() => sayEn({ key: "standing.act.noSuchAct" } as unknown as Said)).toThrow(/SAID_KEY_UNKNOWN: "standing.act.noSuchAct"/);
	});

	it("refuses a template's value left out, naming it", () => {
		expect(refusal(() => say("standing.act.cut", { v: "0.1.0" } as never))).toBe("SAID_VAR_MISSING");
		expect(() => say("standing.act.cut", { v: "0.1.0" } as never)).toThrow(/\{more\}/);
	});

	it("refuses a value of the wrong kind, a nested one included", () => {
		expect(refusal(() => say("standing.act.agreeR", { r: "2" } as never))).toBe("SAID_VAR_KIND");
		expect(refusal(() => say("standing.act.markMerge", { on: "ISS-1" } as never))).toBe("SAID_VAR_KIND");
		expect(refusal(() => say("standing.acts", { acts: [{ key: "standing.act.noSuchAct" } as never] }))).toBe("SAID_KEY_UNKNOWN");
	});

	it("reads a nested sentence, a list and an absent one in English", () => {
		expect(sayEn(say("standing.act.cut", { v: "0.1.0", more: null }))).toBe("cut 0.1.0");
		expect(sayEn(say("issues.standing.act.stepFor", { step: "build", n: 12 }))).toBe("Build · 12 min");
		expect(sayEn(say("runs.final.shortOf", { close: say("runs.final.close", { close: "ended" }), missed: [say("runs.final.missed", { key: "ISS-110", status: "needs_info", landed: null })] }))).toBe(
			"the session closed (ended) with ISS-110 at needs_info, short of an outcome",
		);
	});

	it("carries words a person wrote as written", () => {
		expect(sayEn(verbatim("Dong y {r}"))).toBe("Dong y {r}");
	});
});

describe("a said sentence on the wire", () => {
	it("passes the schema when the registry holds it, and is refused by name when it does not", () => {
		expect(saidSchema.safeParse(say("standing.act.agreeR", { r: 2 })).success).toBe(true);
		const stray = saidSchema.safeParse({ key: "standing.act.noSuchAct" });
		expect(stray.success).toBe(false);
		expect(stray.error?.issues[0]?.message).toMatch(/SAID_KEY_UNKNOWN/);
		expect(saidSchema.safeParse({ key: "standing.act.agreeR", vars: { r: "2" } }).success).toBe(false);
	});
});

describe("a wait from what it says", () => {
	it("renders its English from the sentences it carries, never beside them", () => {
		const w = waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.agreeR", { r: 2 }), rule: verbatim("r") }, { ref: "REQ-1" });
		expect(w).toMatchObject({ kind: "you", who: "You", act: "agree r2", rule: "r", ref: "REQ-1", dueAt: null });
		expect(w.says.act).toEqual({ key: "standing.act.agreeR", vars: { r: 2 } });
	});
});

describe("a value whose English and what it said disagree", () => {
	const w = waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.agreeR", { r: 2 }), rule: verbatim("r") });

	it("agrees where the English was rendered from what it said", () => {
		expect(saidDisagreements({ items: [w], blocker: { act: { label: "Answer it" }, says: { act: say("issues.blocker.actAnswer"), detail: null }, detail: null } })).toEqual([]);
	});

	it("names the field whose English was written beside its sentence instead of from it", () => {
		expect(saidDisagreements({ items: [{ ...w, act: "agree r3" }] })).toEqual(['$.items[0].act: says "agree r2" beside "agree r3"']);
	});

	it("names a sentence the registry cannot read, and English beside a sentence that said nothing", () => {
		expect(saidDisagreements({ says: { rule: { key: "standing.act.noSuchAct" } }, rule: "x" })[0]).toMatch(/^\$\.says\.rule: SAID_KEY_UNKNOWN/);
		expect(saidDisagreements({ says: { detail: null }, detail: "x" })).toEqual(['$.detail: said nothing beside "x"']);
	});
});
