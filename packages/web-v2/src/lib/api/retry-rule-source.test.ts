// ISS-1229 r50, judge-152 on criterion 478: most screens offered Retry on a 403, 404 or 422, each deciding for
// itself. One rule decides now — `isRetryableApiError`, through `RetryButton` and the error-state primitives — and this
// test walks every component in the web app and refuses the words only that Retry draws written anywhere else, a
// failure part handed onRetry without the read's error, a failure sentence closed by a second full stop (criterion
// 496) and a wait counted inside a live region (criterion 479).
//
// It follows no press (r54, the master's ruling on 495): whether a read refused with a wait is asked again before it
// ends is the API client's to decide, and held-reads.test.tsx proves it for every way judges found. The client sees
// every request that goes through it; what it cannot see is one sent around it, which the last test refuses by name.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { indexOf, offences, offencesIn, SRC } from "@/test-support/retry-rule-scan";

function components(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test-support" ? [] : components(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

/** Files that send a request without the API client, each with why its request is not a read the client would hold. */
const AROUND_THE_CLIENT: Record<string, string> = {
  "lib/api/client.ts": "the client itself",
  "middleware.ts": "a server request made before any page, never offered Retry",
  "features/operator/server/whoami-fetch.ts": "a server render's read, answering many people",
  "features/guides/api.ts": "a server render's read of the public guides, cached by Next",
  "lib/changelog.ts": "a server render's read of the changelog, cached by Next",
  "features/settings/mcp.ts": "a write to the person's own MCP address, which is not core",
  "features/issues/components/html-attachment-card.tsx": "an attachment's bytes, shown as a link where they fail, never offered Retry",
};

/** Every place a file sends a request by itself: a fetch, an XMLHttpRequest, an EventSource or a beacon. */
function sendsAround(path: string, text: string): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const at = (node: ts.Node) => `${relative(SRC, path)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && /^(fetch|XMLHttpRequest|EventSource|sendBeacon)$/.test(node.text)) {
      const owner = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent.expression.getText() : null;
      const declaredHere = ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent) || ts.isPropertySignature(node.parent);
      if (!declaredHere && (owner === null || /^(window|globalThis|self|navigator)$/.test(owner))) found.push(`${at(node)} ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("a failed read's Retry, across the web app (criteria 478, 479, 496)", () => {
  it("is drawn by the one Retry everywhere, its sentences closed once and its wait counted outside every live region", () => {
    const sources = components(SRC).map((path) => [path, readFileSync(path, "utf8")] as const);
    const index = indexOf(sources);
    const all = sources.filter(([path]) => path.endsWith(".tsx")).flatMap(([path]) => offencesIn(index, path));
    expect(all).toEqual([]);
  });

  it("is refused where a component draws its own Retry button", () => {
    const own = `export const A = ({ q }) => <p>Failed. <button onClick={() => q.refetch()}>Retry</button></p>;`;
    expect(offences(join(SRC, "features/x/a.tsx"), own)).toEqual([expect.stringContaining('draws "Retry" itself')]);
  });

  // ISS-1229 r51, judge-158: read-again controls had shipped under other words. A control is found by any words only
  // the one Retry draws, as its text, its accessible name or a constant it is drawn from.
  it.each([
    ["an icon button named Retry", `<button aria-label="Retry" onClick={() => q.refetch()}><span className="icon-rerun" /></button>`],
    ["a button reading Retry loading", `<button onClick={() => q.refetch()}>Retry loading</button>`],
    ["a button reading Reload", `<button onClick={() => q.refetch()}>Reload</button>`],
    ["a Retry word held in a constant", `<button onClick={() => again()}>{AGAIN}</button>`],
    ["a control reading Read them again", `<Button variant="ghost" onClick={() => q.refetch()}>Read them again</Button>`],
  ])("is refused for %s", (_, control) => {
    const file = `const AGAIN = "Retry";\nconst again = () => q.refetch();\nconst refresh = () => qc.invalidateQueries({ queryKey: ["x"] });\nexport const A = ({ q, qc, readAgain }) => <p>Couldn't load the runs. ${control}</p>;`;
    expect(offences(join(SRC, "features/x/a.tsx"), file).length).toBeGreaterThan(0);
  });

  it.each([
    [
      "a Retry handed to an error state with the read's error",
      `export const A = ({ q }) => <ErrorState title="Couldn't load" error={q.error} onRetry={() => q.refetch()} />;`,
    ],
  ])("passes %s", (_, file) => {
    expect(offences(join(SRC, "features/x/a.tsx"), file)).toEqual([]);
  });

  it("is refused where an error state is given its Retry without the read's error", () => {
    const bare = `export const A = ({ q }) => <ErrorState title="Couldn't load" message="x" onRetry={() => q.refetch()} />;`;
    expect(offences(join(SRC, "features/x/a.tsx"), bare)).toEqual([
      expect.stringContaining("given onRetry without the failed read's error"),
    ]);
  });

  it("passes a Retry drawn by RetryButton, whatever its words", () => {
    const via = `export const A = ({ q }) => <RetryButton error={q.error} onRetry={() => q.refetch()}>Try again</RetryButton>;`;
    expect(offences(join(SRC, "features/x/a.tsx"), via)).toEqual([]);
  });

  it("refuses a second full stop after a failure sentence, in a template and in JSX", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the source text under test, not a template meant to interpolate
    const twice = "export const A = ({ e }) => <p>{`Could not: ${formatApiError(e)}.`} Runners: {formatApiError(e)}.</p>;";
    expect(offences(join(SRC, "features/x/a.tsx"), twice)).toHaveLength(2);
  });

  // ISS-1229 r51, judge-158 on 496: `formatApiError(e) + "."` passed.
  it("refuses a second full stop added with +, alone or at the end of a longer sum", () => {
    const added = `export const A = ({ e }) => <p>{formatApiError(e) + "."} {"Runs: " + formatApiError(e) + "."}</p>;`;
    expect(offences(join(SRC, "features/x/a.tsx"), added)).toHaveLength(2);
  });

  // ISS-1229 r52, judge-162 on 496: a sentence held in a name first, then given its own stop, passed.
  it("refuses a second full stop after a sentence held in a name, in JSX, in a template and with +", () => {
    const held =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the source text under test, not a template meant to interpolate
      "export function A({ e }) { const why = formatApiError(e); const told = why; return <p title={`Runs: ${why}.`}>Runs: {why}. {told + \".\"}</p>; }";
    expect(offences(join(SRC, "features/x/a.tsx"), held)).toHaveLength(3);
  });

  it("passes a held sentence closed by withStop, which adds a stop only where none stands", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the source text under test, not a template meant to interpolate
    const closed = "export function A({ e }) { const why = formatApiError(e); return <p>{`${withStop(why)} Save again.`}</p>; }";
    expect(offences(join(SRC, "features/x/a.tsx"), closed)).toEqual([]);
  });

  const STATE = "Couldn't load the runs.";

  // ISS-1229 r53, judge-165 on 479: a wait counted inside role="alert" was announced every second of it.
  it.each([
    ["a Retry inside an alert", `export const A = ({ e }) => <p role="alert">${STATE} <RetryButton error={e} onRetry={() => {}} /></p>;`],
    ["a Retry inside a status", `export const A = ({ e }) => <div role="status"><span>${STATE}</span><RetryLink error={e} onRetry={() => {}} /></div>;`],
    ["a part drawing a Retry inside a polite region", `function Line({ e }) { return <RetryButton error={e} onRetry={() => {}} />; }\nexport const A = ({ e }) => <div aria-live="polite"><Line e={e} /></div>;`],
    ["a Retry handed to a part that draws it inside an alert", `function Alert({ children }) { return <div role="alert">{children}</div>; }\nexport const A = ({ e }) => <Alert><RetryButton error={e} onRetry={() => {}} /></Alert>;`],
  ])("is refused for %s, whose wait would be announced each second", (_, file) => {
    const gate = [join(SRC, "design/primitives/retry-wait.tsx"), `export function RetryWaitGate({ children }) { return children; }`] as const;
    const button = [join(SRC, "design/primitives/retry-button.tsx"), `import { RetryWaitGate } from "./retry-wait";\nexport function RetryButton() { return <RetryWaitGate>x</RetryWaitGate>; }\nexport function RetryLink() { return <RetryWaitGate>x</RetryWaitGate>; }`] as const;
    const imports = `import { RetryButton, RetryLink } from "@/design/primitives/retry-button";\n`;
    expect(offences(join(SRC, "features/x/a.tsx"), imports + file, [gate, button])).toEqual([expect.stringContaining("counts a wait inside")]);
  });

  it("passes a Retry beside the live sentence rather than inside it", () => {
    const gate = [join(SRC, "design/primitives/retry-wait.tsx"), `export function RetryWaitGate({ children }) { return children; }`] as const;
    const button = [join(SRC, "design/primitives/retry-button.tsx"), `import { RetryWaitGate } from "./retry-wait";\nexport function RetryButton() { return <RetryWaitGate>x</RetryWaitGate>; }`] as const;
    const file = `import { RetryButton } from "@/design/primitives/retry-button";\nexport const A = ({ e }) => <div><p role="alert">${STATE}</p><RetryButton error={e} onRetry={() => {}} /></div>;`;
    expect(offences(join(SRC, "features/x/a.tsx"), file, [gate, button])).toEqual([]);
  });

  // ISS-1229 r53, judge-165's notes on 496: forms of a second stop the guard did not follow.
  it.each([
    ["a stop on the line after the sentence", "export const A = ({ e }) => (\n  <p>\n    Couldn't load: {formatApiError(e)}\n    .\n  </p>\n);"],
    ["a stop written as an expression", `export const A = ({ e }) => <p>Couldn't load: {formatApiError(e)}{"."}</p>;`],
    ["a sentence held behind a choice", `export function A({ e }) { const why = e ? formatApiError(e) : "Nothing answered."; return <p>Couldn't load: {why}.</p>; }`],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the source text under test, not a template meant to interpolate
    ["a failure's said, taken from it", "export function A({ e }) { const { said } = readFailure(e); return <p>Couldn't load: {`${said}.`}</p>; }"],
    ["a helper returning the sentence", `const reasonOf = (e) => formatApiError(e);\nexport function A({ e }) { return <p>Couldn't load: {reasonOf(e)}.</p>; }`],
    ["a name given the sentence after it is declared", `export function A({ e }) { let why = ""; why = formatApiError(e); return <p>Couldn't load: {why}.</p>; }`],
  ])("refuses a second full stop after %s", (_, file) => {
    expect(offences(join(SRC, "features/x/a.tsx"), file)).toEqual([expect.stringContaining("closes a sentence that already ends with its own stop")]);
  });

  // ISS-1229 r54: the client holds a read refused with a wait, so a request sent around it is the one way left to ask
  // again before the wait ends. Each file that sends one is named, with why its request is not such a read.
  it("sends every request through the API client, but for the files named with why", () => {
    const around = components(SRC).flatMap((path) => {
      const rel = relative(SRC, path);
      return rel in AROUND_THE_CLIENT ? [] : sendsAround(path, readFileSync(path, "utf8"));
    });
    expect(around).toEqual([]);
    const stale = Object.keys(AROUND_THE_CLIENT).filter((rel) => sendsAround(join(SRC, rel), readFileSync(join(SRC, rel), "utf8")).length === 0);
    expect(stale).toEqual([]);
  });

  it.each([
    ["a fetch", `export const A = () => <button onClick={() => fetch("/api/runs")}>Load them</button>;`],
    ["the window's fetch", `export const A = () => <button onClick={() => void window.fetch("/api/runs")}>Load them</button>;`],
    ["fetch under another name", `const get = globalThis.fetch;\nexport const A = () => <button onClick={() => get("/api/runs")}>Load them</button>;`],
    ["an XMLHttpRequest", `export function load() { const x = new XMLHttpRequest(); x.open("GET", "/api/runs"); x.send(); }`],
    ["a beacon", `export const ping = () => navigator.sendBeacon("/api/runs");`],
  ])("is refused for %s sent around the client", (_, text) => {
    expect(sendsAround(join(SRC, "features/x/a.tsx"), text)).toHaveLength(1);
  });

  it("passes a query's own fetch and a member that only shares the name", () => {
    const text = `export const A = ({ q, qc }) => <button onClick={() => { void q.refetch(); void qc.getQueryCache().find({ queryKey: ["x"] })?.fetch(); }}>Go</button>;\nconst api = { fetch: () => 1 };`;
    expect(sendsAround(join(SRC, "features/x/a.tsx"), text)).toEqual([]);
  });
});
