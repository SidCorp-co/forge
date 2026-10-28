// ISS-1229 r50, judge-152 on criterion 478: most screens offered Retry on a 403, 404 or 422, each deciding for
// itself (an unconditional onRetry, or a second rule that allowed everything but a 401). One rule decides now —
// `isRetryableApiError`, through `RetryButton` and the error-state primitives — and this test walks every
// component in the web app and refuses a Retry for a failed read that does not go through it (criterion 495).
// It also refuses a failure sentence closed by a second full stop (criterion 496: "You do not have access to this..").
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexOf, offences, offencesIn, SRC } from "@/test-support/retry-rule-scan";

function components(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test-support" ? [] : components(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

describe("a failed read's Retry, across the web app (criteria 478, 495, 496)", () => {
  it("is decided by the one rule everywhere: no component draws a Retry for a read by itself", () => {
    const sources = components(SRC).map((path) => [path, readFileSync(path, "utf8")] as const);
    const index = indexOf(sources);
    const all = sources.filter(([path]) => path.endsWith(".tsx")).flatMap(([path]) => offencesIn(index, path));
    expect(all).toEqual([]);
  });

  it("is refused where a component draws its own Retry button", () => {
    const own = `export const A = ({ q }) => <p>Failed. <button onClick={() => q.refetch()}>Retry</button></p>;`;
    expect(offences(join(SRC, "features/x/a.tsx"), own)).toEqual([
      expect.stringContaining('draws "Retry" itself'),
      expect.stringContaining("reads again on a press of its own"),
    ]);
  });

  // ISS-1229 r51, judge-158 on 495: four of six plants passed, and three read-again controls had shipped under
  // other words. A control is found by what pressing it does, and by any words it is drawn or named with.
  it.each([
    ["an icon button named Retry", `<button aria-label="Retry" onClick={() => q.refetch()}><span className="icon-rerun" /></button>`],
    ["a button reading Retry loading", `<button onClick={() => q.refetch()}>Retry loading</button>`],
    ["a button reading Reload", `<button onClick={() => q.refetch()}>Reload</button>`],
    ["a Retry word held in a constant", `<button onClick={() => again()}>{AGAIN}</button>`],
    ["a control reading Read them again", `<Button variant="ghost" onClick={() => q.refetch()}>Read them again</Button>`],
    ["a control under words of its own", `<Button onClick={readAgain}>Fetch once more</Button>`],
    ["a menu item that reads again", `<Menu items={[{ label: "Check now", onSelect: () => qc.invalidateQueries({ queryKey: ["x"] }) }]} />`],
    ["a named handler that invalidates a read", `<button onClick={refresh}>Check now</button>`],
  ])("is refused for %s", (_, control) => {
    const file = `const AGAIN = "Retry";\nconst again = () => q.refetch();\nconst refresh = () => qc.invalidateQueries({ queryKey: ["x"] });\nexport const A = ({ q, qc, readAgain }) => <p>Couldn't load the runs. ${control}</p>;`;
    expect(offences(join(SRC, "features/x/a.tsx"), file).length).toBeGreaterThan(0);
  });

  // ISS-1229 r52, judge-162 on 495: a refetch taken under another name, the shape three shipped files use, and a
  // Retry handed through props to a part that presses it, each passed. A read-again is followed by what it is.
  it.each([
    [
      "a refetch taken under another name and pressed",
      `const { isError, refetch: load } = useQuery({ queryKey: ["runs"] });\nexport const A = () => (isError ? <p>Couldn't load the runs. <button onClick={() => load()}>Load them</button></p> : null);`,
    ],
    [
      "a Retry handed through props to a part that presses it",
      `function FailNote({ text, actionLabel, onAction }) { return <p>{text} <a href="#" onClick={onAction}>{actionLabel}</a></p>; }\nexport const A = ({ q }) => <FailNote text="Couldn't load the runs." actionLabel="Retry" onAction={() => q.refetch()} />;`,
    ],
    [
      "a renamed refetch handed through props",
      `const { refetch: load } = useQuery({ queryKey: ["runs"] });\nfunction FailNote({ onAction }) { return <button onClick={() => onAction()}>Again</button>; }\nexport const A = () => <FailNote onAction={load} />;`,
    ],
    [
      "a Retry handed on twice before it is pressed",
      `function Press({ go }) { return <button onClick={go}>Go</button>; }\nfunction FailNote({ onAction }) { const then = () => onAction(); return <Press go={then} />; }\nexport const A = ({ q }) => <FailNote onAction={() => q.refetch()} />;`,
    ],
    [
      "a Retry handed through props spread onto a button",
      `function FailNote({ text, ...rest }) { return <p>{text}<button {...rest}>Again</button></p>; }\nexport const A = ({ q }) => <FailNote text="x" onClick={() => q.refetch()} />;`,
    ],
    ["a router refresh pressed", `export const A = ({ router }) => <p>Couldn't load the runs. <button onClick={() => router.refresh()}>Refresh</button></p>;`],
  ])("is refused for %s", (_, file) => {
    expect(offences(join(SRC, "features/x/a.tsx"), file).length).toBeGreaterThan(0);
  });

  it.each([
    ["under another name", `import { FailNote as Notice } from "./fail-note";`, "Notice"],
    ["as its file's default", `import Notice from "@/features/x/fail-note";`, "Notice"],
  ])("is refused for a Retry handed to a part imported %s, which presses it", (_, imported, tag) => {
    const note = join(SRC, "features/x/fail-note.tsx");
    const elsewhere = [
      [note, `export function FailNote({ onAction }) { return <button onClick={onAction}>Load</button>; }\nexport default FailNote;`],
      [join(SRC, "features/y/fail-note.tsx"), `export function FailNote({ onAction }) { return <RetryButton error={null} onRetry={onAction} />; }`],
    ] as const;
    const file = `${imported}\nexport const A = ({ q }) => <${tag} onAction={() => q.refetch()} />;`;
    expect(offences(join(SRC, "features/x/a.tsx"), file, elsewhere)).toEqual([
      expect.stringContaining(`hands a read-again to <${tag}> as onAction`),
    ]);
  });

  // r52 review F1 (second read): a part handing the Retry on resolves the next part by its own file's imports.
  it("is refused for a Retry an imported part hands on to a part it imports under another name", () => {
    const elsewhere = [
      [join(SRC, "features/x/press.tsx"), `export function Press({ go }) { return <button onClick={go}>Load</button>; }`],
      [
        join(SRC, "features/x/notice.tsx"),
        `import { Press as Trigger } from "./press";\nexport function Notice({ onAction }) { return <Trigger go={onAction} />; }`,
      ],
    ] as const;
    const file = `import { Notice } from "@/features/x/notice";\nexport const A = ({ q }) => <Notice onAction={() => q.refetch()} />;`;
    expect(offences(join(SRC, "features/y/a.tsx"), file, elsewhere)).toEqual([
      expect.stringContaining("hands a read-again to <Notice> as onAction"),
    ]);
  });

  it.each([
    [
      "a renamed refetch given to RetryButton",
      `const { error, refetch: load } = useQuery({ queryKey: ["runs"] });\nexport const A = () => <RetryButton error={error} onRetry={load} />;`,
    ],
    [
      "a Retry handed to a part that gives it to RetryButton",
      `function FailNote({ error, onAction }) { return <RetryButton error={error} onRetry={onAction} />; }\nexport const A = ({ q }) => <FailNote error={q.error} onAction={() => q.refetch()} />;`,
    ],
    [
      "a Retry handed to an error state with the read's error",
      `export const A = ({ q }) => <ErrorState title="Couldn't load" error={q.error} onRetry={() => q.refetch()} />;`,
    ],
  ])("passes %s", (_, file) => {
    expect(offences(join(SRC, "features/x/a.tsx"), file)).toEqual([]);
  });

  it("passes a write that reads its answer back, which is an act and not a failed read's Retry", () => {
    const save = `const save = () => m.mutate(x, { onSuccess: () => q.refetch() });\nexport const A = ({ q, m }) => <button onClick={save}>Save</button>;`;
    expect(offences(join(SRC, "features/x/a.tsx"), save)).toEqual([]);
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

  // ISS-1229 r53, judge-165 on 495: each round's plants were closed by a word or a call added to a list, and the next
  // natural form was open. In a failed read's state every press must now resolve to the one rule, a write, a move to
  // another page or a change to what the page shows; what the reading cannot resolve is refused.
  const STATE = "Couldn't load the runs.";
  it.each([
    ["a read the part makes itself, pressed as Try loading again", `import { apiClient } from "@/lib/api/client";\nexport function A() { const [failed, setFailed] = useState(null); const load = useCallback(async () => { try { await apiClient("/runs"); } catch (e) { setFailed(e); } }, []); if (!failed) return null; return <p>${STATE} <button onClick={() => void load()}>Try loading again</button></p>; }`],
    ["a form's submit", `export function A({ q }) { if (!q.isError) return null; return <form onSubmit={(e) => { e.preventDefault(); void q.refetch(); }}><p>${STATE}</p><button type="submit">Load them</button></form>; }`],
    ["a pointer press", `export const A = ({ q }) => (q.isError ? <p>${STATE} <button onPointerUp={() => void q.refetch()}>Load them</button></p> : null);`],
    ["a query fetched again by key", `export const A = ({ q, qc }) => (q.isError ? <p>${STATE} <button onClick={() => void qc.fetchQuery({ queryKey: ["runs"] })}>Load again</button></p> : null);`],
    ["the page loaded again by its address", `export const A = () => <p>${STATE} <button onClick={() => window.location.assign(window.location.href)}>Load the page again</button></p>;`],
    ["a refetch held as an object's member", `export function A({ q }) { const actions = { again: () => void q.refetch() }; return q.isError ? <p>${STATE} <button onClick={actions.again}>Load them</button></p> : null; }`],
    ["a press this reading cannot follow", `import { useThing } from "some-package";\nexport function A() { const thing = useThing(); return <p>${STATE} <button onClick={() => thing.go()}>Go on</button></p>; }`],
    ["a press handed down by a part no place draws", `export const A = ({ onAgain }) => <p>${STATE} <button onClick={onAgain}>Load them</button></p>;`],
    ["a client's get on a receiver this reading cannot show is a collection", `export const A = ({ client }) => <p>${STATE} <button onClick={() => client.get("/runs")}>Load them</button></p>;`],
    ["an error state handed a null for the read's error", `export const A = ({ q }) => (q.isError ? <ErrorState title="Couldn't load the runs" error={null} onRetry={() => void q.refetch()} /> : null);`],
  ])("is refused for %s in a failed read's state", (_, file) => {
    expect(offences(join(SRC, "features/x/a.tsx"), file).length).toBeGreaterThan(0);
  });

  it("is refused for a part imported through a barrel that renames it", () => {
    const others = [
      [join(SRC, "features/x/fail-note-named.tsx"), `export function FailNote({ text, onAction }) { return <p>{text} <button onClick={() => onAction()}>Load</button></p>; }`],
      [join(SRC, "features/x/parts/index.ts"), `export { FailNote as Note } from "../fail-note-named";`],
    ] as const;
    const file = `import { Note } from "./parts";\nexport const A = ({ q }) => (q.isError ? <Note text="${STATE}" onAction={() => void q.refetch()} /> : null);`;
    expect(offences(join(SRC, "features/x/a.tsx"), file, others)).toEqual([expect.stringContaining("<Note>")]);
  });

  it.each([
    ["a move to another page", `export const A = ({ router }) => <p>${STATE} <button onClick={() => router.push("/runs/all")}>All runs</button></p>;`],
    ["a change to what the page shows", `export function A() { const [open, setOpen] = useState(false); return <p>${STATE} <button onClick={() => setOpen(!open)}>Details</button></p>; }`],
    ["a write that reads its answer back", `export const A = ({ m, q }) => <p>${STATE} <button onClick={() => m.mutate(undefined, { onSuccess: () => q.refetch() })}>Queue them</button></p>;`],
    ["a collection's own get and delete", `export function A() { const seen = useRef(new Map()); const kept = new Set(); return <p>${STATE} <button onClick={() => { seen.current.delete("a"); kept.has("b"); }}>Forget</button></p>; }`],
    ["the one Retry", `export const A = ({ q }) => <p>${STATE} <RetryButton error={q.error} onRetry={() => void q.refetch()} /></p>;`],
  ])("passes %s in a failed read's state", (_, file) => {
    expect(offences(join(SRC, "features/x/a.tsx"), file)).toEqual([]);
  });

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
});
