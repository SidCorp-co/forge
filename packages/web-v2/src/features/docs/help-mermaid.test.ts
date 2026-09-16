// @vitest-environment jsdom
//
// ISS-1010 — every mermaid block in the help content has to parse, because a
// block that does not renders the parser's error message in place of the
// picture, on the published page, silently. The status page shipped at
// `778ab9dd` with `classDef end`: `end` is a flowchart keyword, so the one
// figure the page exists for had never drawn at all and nothing said so.

import mermaid from "mermaid";
import { describe, expect, it } from "vitest";
import { HELP_DOCS } from "./help-content.generated";

const blocks = HELP_DOCS.flatMap((doc) =>
	[...doc.body.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m, i) => ({
		where: `${doc.slug} block ${i + 1}`,
		source: m[1],
	})),
);

describe("the mermaid figures in the help content", () => {
	it("finds the ones the pages carry, so an empty sweep cannot pass for a clean one", () => {
		expect(blocks.length).toBeGreaterThan(0);
	});

	it.each(blocks)("$where parses", async ({ source }) => {
		mermaid.initialize({ startOnLoad: false });
		await expect(mermaid.parse(source)).resolves.toBeTruthy();
	});
});
