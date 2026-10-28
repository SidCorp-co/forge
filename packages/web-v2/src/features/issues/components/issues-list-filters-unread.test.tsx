// @vitest-environment jsdom
//
// ISS-1229 r48: with the project's members or labels unread, the Creator and Label filters offered only
// "anyone" and "any", as if the project held nobody and no label. The failed read is said, with Retry.
import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/providers/toast-provider";

expect.extend(matchers);

const down = new Error("The server is down.");
const reads = vi.hoisted(() => ({
  membersFail: false,
  labelsFail: false,
  failure: null as unknown,
  readMembers: vi.fn(),
  readLabels: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/forge-dev/issues",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/features/shell", async () => {
  const actual = await vi.importActual<typeof import("@/features/shell")>("@/features/shell");
  return { ...actual, usePinnedViews: () => ({ isPinned: () => false, toggle: vi.fn(), remove: vi.fn() }) };
});
vi.mock("./release-gate-panel", () => ({ ReleaseGatePanel: () => null }));
vi.mock("../hooks", async () => {
  const actual = await vi.importActual<typeof import("../hooks")>("../hooks");
  return {
    ...actual,
    useIssues: () => ({ data: { items: [], totalCount: 0 }, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
    useModuleRollup: () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
    useProjectMembers: () =>
      reads.membersFail
        ? { data: undefined, isError: true, error: reads.failure, refetch: reads.readMembers }
        : { data: [], isError: false, error: null, refetch: reads.readMembers },
    useProjectLabels: () =>
      reads.labelsFail
        ? { data: undefined, isError: true, error: reads.failure, refetch: reads.readLabels }
        : { data: [], isError: false, error: null, refetch: reads.readLabels },
    useProjectModules: () => ({ modules: [], data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() }),
    usePatchIssue: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

const { IssuesListView } = await import("./issues-list-view");
const { ApiError } = await import("@/lib/api/client");

function mount() {
  window.history.replaceState({}, "", "/projects/forge-dev/issues");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <IssuesListView scope={{ projectId: "p1", slug: "forge-dev" }} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  reads.membersFail = false;
  reads.labelsFail = false;
  reads.failure = down;
  reads.readMembers.mockClear();
  reads.readLabels.mockClear();
});
afterEach(cleanup);

describe("the issue list's filters whose choices could not be read", () => {
  it("say the people the Creator filter offers could not be loaded, and Retry reads them again", () => {
    reads.membersFail = true;
    mount();
    const failure = screen.getByTestId("filters-unread");
    expect(failure).toHaveTextContent("Couldn't load the people the Creator filter offers. The server is down.");
    fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(reads.readMembers).toHaveBeenCalledTimes(1);
  });

  it("say the labels the Label filter offers could not be loaded, and Retry reads them again", () => {
    reads.labelsFail = true;
    mount();
    const failure = screen.getByTestId("filters-unread");
    expect(failure).toHaveTextContent("Couldn't load the labels the Label filter offers. The server is down.");
    fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(reads.readLabels).toHaveBeenCalledTimes(1);
  });

  it("say nothing of the kind while both are read", () => {
    mount();
    expect(screen.queryByTestId("filters-unread")).toBeNull();
  });
});

// ISS-1229 r49, judge-146 at 390: the Filters sheet showed "Label: any" as for a project with no label, while
// the failure lines stood on the page behind the sheet.
describe("the phone's Filters sheet whose choices could not be read", () => {
  it("says each failure, with its Retry, under the filter it holds back", () => {
    reads.membersFail = true;
    reads.labelsFail = true;
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const sheet = screen.getByRole("dialog", { name: "Filters" });
    const lines = within(sheet).getAllByText(/^Couldn't load the (people|labels)/);
    expect(lines.map((l) => l.closest("[data-testid]")?.textContent ?? l.textContent)).toHaveLength(2);
    expect(sheet).toHaveTextContent("Couldn't load the people the Creator filter offers. The server is down.");
    expect(sheet).toHaveTextContent("Couldn't load the labels the Label filter offers. The server is down.");
    const retries = within(sheet).getAllByRole("button", { name: "Retry" });
    fireEvent.click(retries[0] as HTMLElement);
    fireEvent.click(retries[1] as HTMLElement);
    expect(reads.readMembers).toHaveBeenCalledTimes(1);
    expect(reads.readLabels).toHaveBeenCalledTimes(1);
  });

  it("says nothing of the kind in the sheet while both are read", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(within(screen.getByRole("dialog", { name: "Filters" })).queryByText(/^Couldn't load/)).toBeNull();
  });
});

// ISS-1229 r50, judge-152's note on criterion 477: at 1280 the opened Label menu showed only "Label: any" while the
// failure stood under the filter row, so a reader inside the menu read a project with no labels.
describe("an opened filter menu whose choices could not be read (criterion 504)", () => {
  // The listbox scrolls its chosen option into view, which jsdom does not draw.
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
  });

  it.each([
    ["Label filter", "labelsFail", "Couldn't load the labels to choose from"],
    ["Creator filter", "membersFail", "Couldn't load the people to choose from"],
  ] as const)("the %s says so inside the menu, as a line nobody can pick", (name, fail, said) => {
    reads[fail] = true;
    mount();
    fireEvent.click(screen.getAllByRole("combobox", { name })[0] as HTMLElement);
    const line = screen.getByRole("option", { name: new RegExp(said) });
    expect(line).toHaveAttribute("aria-disabled", "true");
    expect(line).toHaveTextContent("The server is down. Retry is beside the filters.");
  });

  // ISS-1229 r51, judge-158 on 478: on a 403 the line still said "Retry is beside the filters." where none stood.
  it.each([
    ["Label filter", "labelsFail", "Couldn't load the labels to choose from"],
    ["Creator filter", "membersFail", "Couldn't load the people to choose from"],
  ] as const)("the %s points at no Retry where the rule offers none", (name, fail, said) => {
    reads[fail] = true;
    reads.failure = new ApiError(403, "You do not have access to this.");
    mount();
    expect(within(screen.getByTestId("filters-unread")).queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getAllByRole("combobox", { name })[0] as HTMLElement);
    const line = screen.getByRole("option", { name: new RegExp(said) });
    expect(line).toHaveTextContent("You do not have access to this.");
    expect(line).not.toHaveTextContent(/Retry/);
  });

  it("holds no such line while the choices are read", () => {
    mount();
    fireEvent.click(screen.getAllByRole("combobox", { name: "Label filter" })[0] as HTMLElement);
    expect(screen.queryByRole("option", { name: /Couldn't load/ })).toBeNull();
  });
});

/** What a line shows a sighted reader: its text, without the status a screen reader alone is handed. */
function shown(el: HTMLElement): string {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const status of copy.querySelectorAll('[role="status"]')) status.remove();
  return copy.textContent ?? "";
}

/** Core's own answer to a rate-limited read, as its source writes it: the body judge-162 planted. */
function coreRateLimited(seconds: number) {
  const source = readFileSync(join(__dirname, "../../../../../core/src/middleware/rate-limit.ts"), "utf8");
  const template = /export function rateLimitedMessage[\s\S]*?return `([^`]*)`/.exec(source)?.[1] ?? "";
  // biome-ignore lint/suspicious/noTemplateCurlyInString: core's template, as its source spells it
  const said = template.replace("${waitWords(retryAfterSeconds)}", `${seconds} seconds`);
  expect(said).toContain(`Try again in ${seconds} seconds.`);
  return new ApiError(429, said, "RATE_LIMITED", { retryAfterSeconds: seconds }, undefined, seconds * 1000);
}

// ISS-1229 r52, judge-162 on 479: with core's own 429, the line read "Too many requests in a short time. Try again in
// 30 seconds. You can retry in 15 seconds.", two waits that disagree, and still "Try again in 30 seconds." beside the
// Retry once the wait was over. One place says how long, and it counts.
describe("a filter's failed read the server asked to wait on", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Element.prototype.scrollIntoView = () => {};
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says the wait once, counting, and never the server's fixed time, during the wait and after it", () => {
    reads.membersFail = true;
    reads.failure = coreRateLimited(30);
    mount();
    const failure = screen.getByTestId("filters-unread");
    expect(failure).toHaveTextContent("Couldn't load the people the Creator filter offers. Too many requests in a short time.");
    expect(failure).toHaveTextContent("You can retry in 30 seconds.");
    act(() => vi.advanceTimersByTime(15_000));
    expect(failure).toHaveTextContent("You can retry in 15 seconds.");
    expect(shown(failure).match(/\d+ seconds?/g)).toEqual(["15 seconds"]);
    act(() => vi.advanceTimersByTime(20_000));
    expect(failure).not.toHaveTextContent(/\d/);
    expect(failure).not.toHaveTextContent(/Try again/);
    fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(reads.readMembers).toHaveBeenCalledTimes(1);
  });

  // ISS-1229 r53, judge-165: both lines counted inside role="alert", 38 announcements in 20 seconds at 1280. A screen
  // reader is told each line's wait as it starts and as it ends, and nothing while it counts.
  it("hands a screen reader each line's wait at its start and its end, never a tick", () => {
    reads.membersFail = true;
    reads.labelsFail = true;
    reads.failure = coreRateLimited(20);
    mount();
    const live = '[role="alert"], [role="status"], [role="log"], [aria-live="polite"], [aria-live="assertive"]';
    const said: string[] = [];
    let last = new Map<Element, string>();
    for (let t = 0; t <= 46; t++) {
      const now = new Map([...document.querySelectorAll(live)].map((el) => [el, el.textContent ?? ""] as const));
      for (const [el, text] of now) if (last.get(el) !== text && /retry|asked/i.test(text)) said.push(text);
      last = now;
      act(() => vi.advanceTimersByTime(500));
    }
    expect(said).toEqual([
      "The server asked for 20 seconds before Retry.",
      "The server asked for 20 seconds before Retry.",
      "You can retry now.",
      "You can retry now.",
    ]);
  });

  it("points the opened menu at the wait while it runs, and at Retry once it is over", () => {
    reads.labelsFail = true;
    reads.failure = coreRateLimited(30);
    mount();
    const open = () => fireEvent.click(screen.getAllByRole("combobox", { name: "Label filter" })[0] as HTMLElement);
    open();
    const during = screen.getByRole("option", { name: /Couldn't load the labels to choose from/ });
    expect(during).toHaveTextContent("Too many requests in a short time. Retry comes back beside the filters when the wait there ends.");
    expect(during).not.toHaveTextContent("Retry is beside the filters.");
    act(() => vi.advanceTimersByTime(31_000));
    const after = screen.getByRole("option", { name: /Couldn't load the labels to choose from/ });
    expect(after).toHaveTextContent("Too many requests in a short time. Retry is beside the filters.");
    expect(after).not.toHaveTextContent(/\d|when the wait/);
  });
});
