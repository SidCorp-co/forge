import { describe, expect, it } from "vitest";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./workflow-template-builtins.js";

// The built-in templates are every Forge project's, so their labels, tooltips and purposes carry no one
// customer's domain word: a canvas in any project would otherwise read "Patient action".
describe("the built-in workflow templates", () => {
	for (const template of BUILTIN_WORKFLOW_TEMPLATES) {
		it(`${template.id}: its copy names no healthcare word`, () => {
			expect(JSON.stringify(template)).not.toMatch(/patient|clinic|hospital|bệnh nhân/i);
		});
	}

	it("labels the service-blueprint customer node with the generic word", () => {
		const blueprint = BUILTIN_WORKFLOW_TEMPLATES.find((t) => t.id === "service-blueprint");
		expect(blueprint?.nodeTypes.find((n) => n.id === "CUSTOMER_ACTION")?.label).toBe("Customer action");
	});
});
