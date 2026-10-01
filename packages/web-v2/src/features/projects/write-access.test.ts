import { describe, expect, it } from "vitest";
import { canWriteProject } from "./write-access";

describe("canWriteProject", () => {
	it.each(["member", "admin"] as const)("lets a %s write", (role) => {
		expect(canWriteProject(role)).toBe(true);
	});

	it.each(["viewer", null, undefined] as const)("leaves a %s role reading", (role) => {
		expect(canWriteProject(role)).toBe(false);
	});
});
