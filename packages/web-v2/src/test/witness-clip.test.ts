// @vitest-environment node
// The judge's clip recorder (REQ-40 BC-4) reads its run from its arguments and refuses every one it
// does not take by name, before a browser starts: a clip recorded at the wrong width, or into the
// tree, is evidence of the wrong thing.
//
// @direct-test-of packages/web-v2/witness/clip.mjs

import { afterEach, describe, expect, it, vi } from "vitest";
import { argsOf } from "../../witness/clip.mjs";

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function refusal(argv: string[]): { code: number; said: string } {
  const said: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => void said.push(line));
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Exit(Number(code));
  });
  try {
    argsOf(argv);
  } catch (err) {
    if (err instanceof Exit) return { code: err.code, said: said.join("\n") };
    throw err;
  }
  throw new Error("argsOf took a run it should have refused");
}

afterEach(() => vi.restoreAllMocks());

describe("the clip recorder's run", () => {
  it("records a phone width at a phone's height, light, under a name the attachment keeps", () => {
    const run = argsOf(["https://forge-dev.example/projects/forge/workflows", "--out", "/tmp/clips", "--width", "390", "--name", "workflows-390", "--login"]);
    expect(run).toMatchObject({ out: "/tmp/clips", name: "workflows-390", width: 390, height: 844, theme: "light", steps: null, login: true });
    expect(run.url.href).toBe("https://forge-dev.example/projects/forge/workflows");
    expect(argsOf(["https://x.example/", "--out", "/tmp/c", "--theme", "dark"])).toMatchObject({ width: 1440, height: 900, name: "clip-1440-dark" });
  });

  it.each([
    [["https://x.example/"], "no --out directory named"],
    [["https://x.example/", "--out", "/tmp/c", "--clip"], "--clip is not a flag the recorder takes"],
    [["--out", "/tmp/c"], "no URL named"],
    [["not a url", "--out", "/tmp/c"], "not a URL"],
    [["https://x.example/", "--out", "/tmp/c", "--width", "100"], "is not a window width from 320 to 2560"],
    [["https://x.example/", "--out", "/tmp/c", "--theme", "sepia"], "is light or dark"],
    [["https://x.example/", "--out", "/tmp/c", "--name", "../escape"], "it is the attachment's name"],
  ])("refuses %j by name, before any browser starts", (argv, said) => {
    const out = refusal(argv);
    expect(out.code).toBe(2);
    expect(out.said).toContain(said);
  });
});
