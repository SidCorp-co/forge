// @vitest-environment node
// The page beside the Ask Agent panel, at Large and at Half, reflows with no sideways scroll, nothing
// cut off at its edge, and its back control where a click on it lands (REQ-69 BC-9, REQ-31 BC-3;
// ISS-1154, after a judge found the requirement page's acts drawn over its back control at 86ba777).
// jsdom lays nothing out, so the issue, requirement, board and run pages and a page whose bar carries
// more acts than the bar holds in one row are drawn in headless Chrome by witness/page-beside-dock.witness.tsx
// at 390 to 2560 px; it answers one sentence per wrong, and this fails naming them.
//
// It costs one witness run, under a minute. Chrome (`WITNESS_CHROME`, else `google-chrome`) is a
// program the whole-tree guard cannot read inside, so it counts the run as listing the root; it reads
// only the web package and its own fresh profile. A box without Chrome fails here by name.
// @gate-input whole-tree
// @direct-test-of packages/web-v2/src/features/shell/components/shell-top-bar.tsx
// @direct-test-of packages/web-v2/src/design/patterns/detail-header.tsx
// @direct-test-of packages/web-v2/src/features/conversations/components/chat-dock.tsx
// @direct-test-of packages/web-v2/src/features/chat-dock/dock-size.ts
// @direct-test-of packages/web-v2/witness/page-beside-dock.witness.tsx

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const WEB = resolve(import.meta.dirname, "../../../..");
const out = mkdtempSync(join(tmpdir(), "page-beside-dock-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("the page beside the Ask Agent panel", () => {
  it("reflows at Large and Half with its back control uncovered and nothing scrolling sideways", () => {
    const run = spawnSync(process.execPath, ["witness/run.mjs", "witness/page-beside-dock.witness.tsx", "--out", out], {
      cwd: WEB,
      encoding: "utf8",
      // vitest's NODE_ENV=test would build the page on React's dev runtime, which the bundle does not carry
      env: { ...process.env, NODE_ENV: "production" },
      timeout: 540_000,
    });
    const said = `${run.stdout}\n${run.stderr}`;
    const failed = said.split("\n").filter((l) => l.startsWith("witness: FAIL"));
    expect(failed).toEqual([]);
    expect(run.status, `the witness could not run (exit ${run.status}):\n${said.slice(-2000)}`).toBe(0);
  }, 600_000);
});
