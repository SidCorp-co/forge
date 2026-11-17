import { describe, expect, it } from "vitest";
import { appliedLessonsIn, recordAppliedRequestSchema } from "./lessons.js";

describe("the lessons an output says it applied (REQ-50 BC-4)", () => {
	it("reads its one line, once each, in order", () => {
		expect(appliedLessonsIn("Done.\n\nLessons applied: L-3, L-7, L-3")).toEqual(
			[3, 7],
		);
		expect(appliedLessonsIn("lessons applied: L-12.")).toEqual([12]);
	});

	// ISS-1251 c10: the map names each lesson by its slug, which is what an agent copies
	it("reads a lesson named by its slug as the map lists it, in the line and at the door", () => {
		expect(appliedLessonsIn("Lessons applied: lesson-103, L-7")).toEqual([103, 7]);
		const body = (lessons: unknown[]) =>
			recordAppliedRequestSchema.safeParse({ lessons, output: { kind: "issue", ref: "ISS-1" } });
		expect(body(["lesson-103", "L-7", 9]).data?.lessons).toEqual([103, 7, 9]);
		expect(body(["lessons-3"]).success).toBe(false);
		expect(body(["L-0"]).success).toBe(false);
	});

	it("reads nothing from text with no such line, or one naming no lesson", () => {
		expect(appliedLessonsIn("I applied the lesson about dates.")).toEqual([]);
		expect(appliedLessonsIn("Lessons applied: none")).toEqual([]);
		// the map's own example, copied as it reads, applies nothing (ISS-1251 round 5)
		expect(appliedLessonsIn("Lessons applied: L-<n>, …")).toEqual([]);
		expect(
			appliedLessonsIn("We discussed Lessons applied: L-2 in passing"),
		).toEqual([]);
	});
});
