// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnTestMessage } from "./conn-test-message";

const ours =
	"The git host refused this deploy key. Give it read access to the repository, which is all Forge needs; devices that push with it need write access.";
const host = "git@github.com: Permission denied (publickey).";

describe("a Test connection answer (ISS-1421 r11, r15)", () => {
	it("shows the host's own words on a line of their own, said to be the host's", () => {
		const { container } = render(<ConnTestMessage message={ours} hostSaid={host} />);
		const lines = [...container.querySelectorAll("span.block")].map((s) => s.textContent);
		expect(lines).toEqual([ours, `The git host said: ${host}`]);
	});

	it("shows Forge's sentences alone where the host said nothing", () => {
		const { container } = render(<ConnTestMessage message="Forge could not reach the git host." />);
		const lines = [...container.querySelectorAll("span.block")].map((s) => s.textContent);
		expect(lines).toEqual(["Forge could not reach the git host."]);
	});
});
