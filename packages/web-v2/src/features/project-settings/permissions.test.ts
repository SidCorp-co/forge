import { describe, expect, it } from "vitest";
import { canManageUxContract } from "./permissions";

describe("canManageUxContract", () => {
	it("allows a project admin who is only an organization member", () => {
		expect(canManageUxContract({ role: "admin", orgRole: "member" })).toBe(
			true,
		);
	});

	it("does not allow a project member", () => {
		expect(canManageUxContract({ role: "member", orgRole: "member" })).toBe(
			false,
		);
	});
});
