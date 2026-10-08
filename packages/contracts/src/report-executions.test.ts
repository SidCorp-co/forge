import { describe, expect, it } from "vitest";
import {
	ComputeRequestSchema,
	EXECUTION_MAX_INPUTS,
	framesFromReturn,
	normalizeScript,
} from "./report-executions.js";

describe("a script as its fingerprint reads it", () => {
	const script = "for r in rows:\n    total += r['n']\nprint(total)";

	it("does not change with line endings, trailing or inner spacing, or blank lines", () => {
		const spaced =
			"\r\nfor  r in\trows:   \r\n\r\n    total +=  r['n']\r\nprint(total)  \n\n";
		expect(normalizeScript(spaced)).toBe(normalizeScript(script));
	});

	it("changes with a line's indentation", () => {
		expect(
			normalizeScript("for r in rows:\ntotal += r['n']\nprint(total)"),
		).not.toBe(normalizeScript(script));
	});
});

describe("a compute request", () => {
	it("names runs as its inputs, never frames or tables, and at most eight", () => {
		const ok = {
			language: "javascript",
			script: "return { frames: [] }",
			inputs: ["run-1"],
		};
		expect(ComputeRequestSchema.safeParse(ok).success).toBe(true);
		expect(
			ComputeRequestSchema.safeParse({
				...ok,
				inputs: [{ fields: [], rows: [] }],
			}).success,
		).toBe(false);
		expect(
			ComputeRequestSchema.safeParse({ ...ok, table: "issues" }).success,
		).toBe(false);
		const many = Array.from(
			{ length: EXECUTION_MAX_INPUTS + 1 },
			(_, i) => `run-${i}`,
		);
		expect(
			ComputeRequestSchema.safeParse({ ...ok, inputs: many }).success,
		).toBe(false);
	});

	it.each(["python", "bash"])(
		"refuses a %s script by name, saying the sandbox runs javascript",
		(language) => {
			const read = ComputeRequestSchema.safeParse({
				language,
				script: "print(1)",
				inputs: [],
			});
			expect(read.success).toBe(false);
			expect(read.error?.issues[0]?.message).toContain(
				`language "${language}" is refused`,
			);
			expect(read.error?.issues[0]?.message).toContain("javascript");
		},
	);
});

describe("the frames a script returns", () => {
	const frame = {
		fields: [{ name: "n", type: "number", label: "N" }],
		rows: [{ n: 1 }],
	};

	it("reads { frames }", () => {
		expect(framesFromReturn({ frames: [frame] })).toEqual({
			ok: true,
			frames: [frame],
		});
	});

	it("names a return that holds no frames array, or frames that are not frames", () => {
		expect(framesFromReturn(undefined)).toMatchObject({
			ok: false,
			why: expect.stringContaining('no "frames" array'),
		});
		expect(framesFromReturn({ frames: [{ rows: [] }] })).toMatchObject({
			ok: false,
			why: expect.stringContaining("not frames of { fields, rows }"),
		});
	});
});
