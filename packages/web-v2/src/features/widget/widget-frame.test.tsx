import type { WidgetIdentityMode, WidgetPublicConfig } from "@forge/contracts/widget";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { WidgetFrame } from "./components/widget-frame";

// The frame a client page embeds, over a core that answers the widget contract: each identity mode
// opens its session the way the binding asks, the live stream folds into the chat, a draft is sent or
// discarded from its card, a sent one shows its status link, a limit says why the line stopped, and
// each refusal reads by its code.

const HOST = "https://shop.example.com";
const SITE_KEY = `fw_site_${"k".repeat(32)}`;
const TOKEN = `fw_sess_${"s".repeat(43)}`;
const VISITOR = "7f0c0d3e-3b1a-4b8e-9a51-2d4c3b6f9e10";
const STATUS_URL = `/w/status/fw_stat_${"x".repeat(43)}`;
const SIGNED = { userId: "u-42", ts: 1760600000, sig: "c".repeat(64) };
const DRAFT = {
  draftId: "d1",
  title: "Pay button does nothing",
  did: "Pressed Pay on the cart",
  saw: "Nothing happened",
  expected: "The payment page",
  whereSeen: "/cart",
  kind: "bug" as const,
  state: "pending" as const,
};

interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

let calls: Call[] = [];
let streamWrite: ((event: unknown) => void) | null = null;
let replies: Record<string, { status?: number; body: unknown }> = {};

const configOf = (mode: WidgetIdentityMode): WidgetPublicConfig => ({
  title: "Kettle Co. help",
  greeting: "Hi! What went wrong?",
  accent: "#0f766e",
  identity: { mode },
  messageMaxChars: 4000,
});

function core(mode: WidgetIdentityMode) {
  replies = {
    [`GET /${SITE_KEY}/config`]: { body: configOf(mode) },
    [`POST /${SITE_KEY}/sessions`]: {
      body: { sessionToken: TOKEN, visitorId: VISITOR, conversationId: "c1", expiresAt: "2026-10-16T12:00:00.000Z" },
    },
    "GET /session/messages": { body: { messages: [], drafts: [] } },
    "POST /session/messages": { status: 201, body: { message: { id: "v1", role: "visitor", text: "It broke", at: "2026-10-16T10:00:01.000Z" } } },
    "POST /session/drafts/d1/confirm": { body: { feedbackKey: "FB-31", statusUrl: STATUS_URL } },
    "POST /session/drafts/d1/discard": { body: { ...DRAFT, state: "discarded" } },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://forge.test");
      const path = url.pathname.replace(/^\/api\/widget/, "");
      const method = init?.method ?? "GET";
      calls.push({ method, path, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined, auth: new Headers(init?.headers).get("authorization") });
      if (path === "/session/stream") {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start: (c) => {
            streamWrite = (event) => c.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          },
        });
        return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
      }
      const reply = replies[`${method} ${path}`];
      if (!reply) throw new Error(`no reply for ${method} ${path}`);
      return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } }));
    }),
  );
}

const refuse = (key: string, status: number, code: string, message = code) => {
  replies[key] = { status, body: { code, message, error: { code, message, refusals: [] } } };
};

/** The embedding page: a window the frame's parent is, at HOST. */
let hostWindow: Window;
function embedAt(origin: string) {
  const holder = document.createElement("iframe");
  document.body.appendChild(holder);
  if (!holder.contentWindow) throw new Error("no host window");
  hostWindow = holder.contentWindow;
  Object.defineProperty(window, "parent", { value: hostWindow, configurable: true });
  Object.defineProperty(document, "referrer", { value: `${origin}/catalog`, configurable: true });
  return vi.spyOn(hostWindow, "postMessage").mockImplementation(() => {});
}

const fromHost = (data: unknown, origin = HOST, source: Window = hostWindow) =>
  act(() => window.dispatchEvent(new MessageEvent("message", { data: { source: "forge-widget", ...(data as object) }, origin, source })));
/** Core writes one event on the stream; the frame has read it once the reads it starts have run. */
const push = (event: unknown) =>
  act(async () => {
    streamWrite?.(event);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
const sessionOpen = () => calls.find((c) => c.method === "POST" && c.path.endsWith("/sessions"));

let toHost: ReturnType<typeof embedAt>;
beforeEach(() => {
  calls = [];
  streamWrite = null;
  window.localStorage.clear();
  toHost = embedAt(HOST);
});
afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, "parent", { value: window, configurable: true });
  document.body.innerHTML = "";
});

describe("the widget frame's identity modes", () => {
  it("anonymous: tells the page it is ready, takes no email unless given, and keeps the visitor id", async () => {
    core("anonymous");
    renderWithQuery(<WidgetFrame siteKey={SITE_KEY} />);
    expect(toHost).toHaveBeenCalledWith({ source: "forge-widget", type: "ready" }, HOST);
    expect(await screen.findByText("Kettle Co. help")).toBeInTheDocument();
    expect(screen.getByLabelText("Email (optional)")).toBeInTheDocument();
    await fromHost({ type: "context", context: { url: `${HOST}/kettle`, productId: "kettle-blue" } });
    await userEvent.click(screen.getByRole("button", { name: "Start chat" }));
    await screen.findByTestId("widget-conversation");
    expect(sessionOpen()?.body).toEqual({ context: { url: `${HOST}/kettle`, productId: "kettle-blue" }, embeddedAt: HOST });
    expect(JSON.parse(window.localStorage.getItem(`forge-widget:${SITE_KEY}`) ?? "{}")).toMatchObject({ visitorId: VISITOR });
    expect(calls.find((c) => c.path === "/session/stream")?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("anonymous: a returning visitor goes straight in as the same visitor", async () => {
    window.localStorage.setItem(`forge-widget:${SITE_KEY}`, JSON.stringify({ visitorId: VISITOR, email: null }));
    core("anonymous");
    renderWithQuery(<WidgetFrame siteKey={SITE_KEY} />);
    await screen.findByTestId("widget-conversation");
    expect(sessionOpen()?.body).toEqual({ embeddedAt: HOST, visitorId: VISITOR });
    expect(screen.queryByTestId("widget-gate")).toBeNull();
  });

  it("email: opens nothing without a valid email, then opens with the one given", async () => {
    core("email");
    renderWithQuery(<WidgetFrame siteKey={SITE_KEY} />);
    await userEvent.click(await screen.findByRole("button", { name: "Start chat" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid email address.");
    await userEvent.type(screen.getByLabelText(/^Email/), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: "Start chat" }));
    expect(sessionOpen()).toBeUndefined();
    await userEvent.clear(screen.getByLabelText(/^Email/));
    await userEvent.type(screen.getByLabelText(/^Email/), "ana@kettle.example");
    await userEvent.click(screen.getByRole("button", { name: "Start chat" }));
    await screen.findByTestId("widget-conversation");
    expect(sessionOpen()?.body).toEqual({ visitor: { email: "ana@kettle.example" }, embeddedAt: HOST });
  });

  it("email: core's refusal for a missing identity reads in plain words, by its code", async () => {
    core("email");
    refuse(`POST /${SITE_KEY}/sessions`, 422, "WIDGET_IDENTITY_REQUIRED");
    renderWithQuery(<WidgetFrame siteKey={SITE_KEY} />);
    await userEvent.type(await screen.findByLabelText(/^Email/), "ana@kettle.example");
    await userEvent.click(screen.getByRole("button", { name: "Start chat" }));
    const note = await screen.findByTestId("widget-refusal");
    expect(note).toHaveAttribute("data-code", "WIDGET_IDENTITY_REQUIRED");
    expect(note).toHaveTextContent("Enter your email to start.");
    expect(screen.getByTestId("widget-gate")).toBeInTheDocument();
  });

  it("signed: waits for the page's signature, ignores one from another origin, and opens with the page's", async () => {
    core("signed");
    renderWithQuery(<WidgetFrame siteKey={SITE_KEY} />);
    expect(await screen.findByTestId("widget-wait")).toHaveTextContent("Waiting for your sign-in on this site…");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await fromHost({ type: "identify", signed: SIGNED }, "https://evil.example");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("https://evil.example is not from the page embedding this frame"));
    expect(sessionOpen()).toBeUndefined();
    await fromHost({ type: "identify", signed: SIGNED });
    await screen.findByTestId("widget-conversation");
    expect(sessionOpen()?.body).toEqual({ signed: SIGNED, embeddedAt: HOST });
  });

  it("names the origin that framed it, and stops for good when core refuses that origin", async () => {
    core("anonymous");
    replies[`POST /${SITE_KEY}/sessions`] = {
      status: 403,
      body: { error: { code: "WIDGET_ORIGIN_REFUSED", refusals: [{ code: "WIDGET_ORIGIN_REFUSED", path: "/embeddedAt", detail: "not allowed" }] } },
    };
    renderWithQuery(<WidgetFrame siteKey={SITE_KEY} />);
    await userEvent.click(await screen.findByRole("button", { name: "Start chat" }));
    const note = await screen.findByTestId("widget-refusal");
    expect(sessionOpen()?.body).toEqual({ embeddedAt: HOST });
    expect(note).toHaveAttribute("data-code", "WIDGET_ORIGIN_REFUSED");
    expect(note).toHaveTextContent("This site isn't allowed to use this chat.");
    expect(screen.queryByRole("button", { name: "Start chat" })).toBeNull();
  });

  it("opened on its own, outside any page, names no framing origin", async () => {
    Object.defineProperty(window, "parent", { value: window, configurable: true });
    core("anonymous");
    renderWithQuery(<WidgetFrame siteKey={SITE_KEY} />);
    await userEvent.click(await screen.findByRole("button", { name: "Start chat" }));
    await screen.findByTestId("widget-conversation");
    expect(sessionOpen()?.body).toEqual({});
  });

  it("signed: a signature core refuses reads as a sign-in it could not confirm", async () => {
    core("signed");
    refuse(`POST /${SITE_KEY}/sessions`, 403, "WIDGET_SIGNATURE_INVALID");
    renderWithQuery(<WidgetFrame siteKey={SITE_KEY} />);
    await screen.findByTestId("widget-wait");
    await fromHost({ type: "identify", signed: SIGNED });
    expect(await screen.findByTestId("widget-refusal")).toHaveTextContent("We couldn't confirm your sign-in.");
  });
});

async function openChat() {
  window.localStorage.setItem(`forge-widget:${SITE_KEY}`, JSON.stringify({ visitorId: VISITOR, email: null }));
  core("anonymous");
  renderWithQuery(<WidgetFrame siteKey={SITE_KEY} />);
  await screen.findByTestId("widget-conversation");
  await waitFor(() => expect(streamWrite).not.toBeNull());
}

describe("the widget frame's conversation", () => {
  it("sends the visitor's line with the page's context and shows the assistant's reply from the stream", async () => {
    await openChat();
    await fromHost({ type: "context", context: { url: `${HOST}/cart` } });
    await userEvent.type(screen.getByLabelText("Message"), "It broke{Enter}");
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/session/messages")?.body).toEqual({ text: "It broke", context: { url: `${HOST}/cart` } }));
    await push({ type: "typing", on: true });
    expect(screen.getByText("Assistant is typing…")).toBeInTheDocument();
    await push({ type: "message", message: { id: "a1", role: "assistant", text: "Which page were you on?", at: "2026-10-16T10:00:02.000Z" } });
    const log = screen.getByRole("log");
    expect(within(log).getByText("It broke")).toBeInTheDocument();
    expect(within(log).getByText("Which page were you on?")).toBeInTheDocument();
    expect(screen.queryByText("Assistant is typing…")).toBeNull();
  });

  it("counts a reply that lands while the page has the frame closed, and clears it on open", async () => {
    await openChat();
    await fromHost({ type: "close" });
    await push({ type: "message", message: { id: "a1", role: "assistant", text: "Still there?", at: "2026-10-16T10:00:02.000Z" } });
    await waitFor(() => expect(toHost).toHaveBeenCalledWith({ source: "forge-widget", type: "unread", count: 1 }, HOST));
    await fromHost({ type: "open" });
    await waitFor(() => expect(toHost).toHaveBeenLastCalledWith({ source: "forge-widget", type: "unread", count: 0 }, HOST));
  });

  it("closes through the page on its close button and on Escape", async () => {
    await openChat();
    await userEvent.click(screen.getByRole("button", { name: "Close chat" }));
    expect(toHost).toHaveBeenCalledWith({ source: "forge-widget", type: "close" }, HOST);
    toHost.mockClear();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(toHost).toHaveBeenCalledWith({ source: "forge-widget", type: "close" }, HOST);
  });

  it("draws a draft as a card with what the visitor did, saw and expected, and sends it", async () => {
    await openChat();
    await push({ type: "draft", draft: DRAFT });
    const card = screen.getByTestId("widget-draft");
    expect(card).toHaveAttribute("data-state", "pending");
    for (const text of ["Pay button does nothing", "Pressed Pay on the cart", "Nothing happened", "The payment page", "Bug"])
      expect(within(card).getByText(text)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Send report" }));
    const filed = await screen.findByTestId("widget-filed");
    expect(calls.some((c) => c.method === "POST" && c.path === "/session/drafts/d1/confirm" && c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(within(filed).getByText("Reference FB-31")).toBeInTheDocument();
    const link = within(filed).getByTestId("widget-status-link");
    expect(link).toHaveAttribute("href", `${window.location.origin}${STATUS_URL}`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("shows a sent report's status link again after a reload, from the history", async () => {
    window.localStorage.setItem(`forge-widget:${SITE_KEY}`, JSON.stringify({ visitorId: VISITOR, email: null }));
    core("anonymous");
    replies["GET /session/messages"] = {
      body: { messages: [], drafts: [{ ...DRAFT, state: "filed", filed: { feedbackKey: "FB-31", statusUrl: STATUS_URL } }] },
    };
    renderWithQuery(<WidgetFrame siteKey={SITE_KEY} />);
    const filed = await screen.findByTestId("widget-filed");
    expect(within(filed).getByText("Reference FB-31")).toBeInTheDocument();
    expect(within(filed).getByTestId("widget-status-link")).toHaveAttribute("href", `${window.location.origin}${STATUS_URL}`);
    expect(calls.some((c) => c.path.endsWith("/confirm"))).toBe(false);
  });

  it("reads a filed draft core holds no link for as sent, without one", async () => {
    window.localStorage.setItem(`forge-widget:${SITE_KEY}`, JSON.stringify({ visitorId: VISITOR, email: null }));
    core("anonymous");
    replies["GET /session/messages"] = { body: { messages: [], drafts: [{ ...DRAFT, state: "filed", filed: null }] } };
    renderWithQuery(<WidgetFrame siteKey={SITE_KEY} />);
    const filed = await screen.findByTestId("widget-filed");
    expect(within(filed).getByText("Pay button does nothing")).toBeInTheDocument();
    expect(within(filed).queryByTestId("widget-status-link")).toBeNull();
  });

  it("clears a sent line once core answers it, and fails it loudly when the answer carries no message", async () => {
    await openChat();
    await userEvent.type(screen.getByLabelText("Message"), "It broke{Enter}");
    await waitFor(() => expect(within(screen.getByRole("log")).getByText("It broke")).toBeInTheDocument());
    replies["POST /session/messages"] = { status: 201, body: { id: "v2" } };
    await userEvent.type(screen.getByLabelText("Message"), "Again{Enter}");
    expect(await screen.findByText("Not sent. Try again.")).toBeInTheDocument();
  });

  it("copies the status link, and says so when the browser will not", async () => {
    await openChat();
    await push({ type: "draft", draft: DRAFT });
    await push({ type: "filed", draftId: "d1", feedbackKey: "FB-31", statusUrl: STATUS_URL });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await userEvent.click(within(screen.getByTestId("widget-filed")).getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}${STATUS_URL}`);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });

  it("discards a draft, which folds to one line", async () => {
    await openChat();
    await push({ type: "draft", draft: DRAFT });
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.getByTestId("widget-draft")).toHaveAttribute("data-state", "discarded"));
    expect(calls.some((c) => c.path === "/session/drafts/d1/discard")).toBe(true);
  });

  it("says a draft already sent or discarded is, by its code", async () => {
    await openChat();
    await push({ type: "draft", draft: DRAFT });
    refuse("POST /session/drafts/d1/confirm", 409, "WIDGET_DRAFT_NOT_PENDING");
    await userEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByTestId("widget-refusal")).toHaveTextContent("This report was already sent or discarded.");
  });

  it("stops the line at a limit and says which, in core's words", async () => {
    await openChat();
    await push({ type: "limit", code: "WIDGET_LIMIT_REACHED", detail: "This conversation reached 30 turns." });
    const limit = screen.getByTestId("widget-limit");
    expect(limit).toHaveTextContent("You've reached this chat's limit. Try again later.");
    expect(limit).toHaveTextContent("This conversation reached 30 turns.");
    expect(screen.getByLabelText("Message")).toBeDisabled();
  });

  it("shows, never skips, a stream event it cannot read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await openChat();
    await push({ type: "presence", who: "agent" });
    expect(screen.getByTestId("widget-stream-fault")).toHaveAttribute("title", '"presence" is not a widget stream event type');
    expect(error).toHaveBeenCalled();
  });
});

describe("the widget frame's refusals", () => {
  it("reads a site key that is not one as unknown, asking core nothing", async () => {
    core("anonymous");
    renderWithQuery(<WidgetFrame siteKey="fw_site_nope" />);
    expect(await screen.findByTestId("widget-refusal")).toHaveTextContent("This chat isn't set up for this site.");
    expect(calls).toEqual([]);
  });

  it.each([
    ["WIDGET_SITE_UNKNOWN", 404, "This chat isn't set up for this site."],
    ["WIDGET_ORIGIN_REFUSED", 403, "This site isn't allowed to use this chat."],
    ["SOMETHING_ELSE", 422, "Something went wrong. Try again."],
  ])("reads config refused with %s in plain words, the code beside it", async (code, status, words) => {
    core("anonymous");
    refuse(`GET /${SITE_KEY}/config`, status, code);
    renderWithQuery(<WidgetFrame siteKey={SITE_KEY} />);
    const note = await screen.findByTestId("widget-refusal");
    expect(note).toHaveTextContent(words);
    expect(note).toHaveTextContent(`Code ${code}`);
  });

  it("hands an expired session back to the start, saying so", async () => {
    await openChat();
    refuse("POST /session/messages", 403, "WIDGET_SESSION_INVALID");
    await userEvent.type(screen.getByLabelText("Message"), "Hello?{Enter}");
    expect(await screen.findByText("This chat has expired. Start a new one.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start chat" })).toBeInTheDocument();
  });
});
