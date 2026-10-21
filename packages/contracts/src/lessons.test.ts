import { describe, expect, it } from "vitest";
import { appliedLessonsIn } from "./lessons.js";

describe("the lessons an output says it applied (REQ-50 BC-4)", () => {
	it("reads its one line, once each, in order", () => {
		expect(appliedLessonsIn("Done.\n\nLessons applied: L-3, L-7, L-3")).toEqual(
			[3, 7],
		);
		expect(appliedLessonsIn("lessons applied: L-12.")).toEqual([12]);
	});

	it("reads nothing from text with no such line, or one naming no lesson", () => {
		expect(appliedLessonsIn("I applied the lesson about dates.")).toEqual([]);
		expect(appliedLessonsIn("Lessons applied: none")).toEqual([]);
		expect(
			appliedLessonsIn("We discussed Lessons applied: L-2 in passing"),
		).toEqual([]);
	});
});
