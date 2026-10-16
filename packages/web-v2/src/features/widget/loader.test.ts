import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The loader a client page embeds (public/widget.js) runs on someone else's page, so it is held to
// three things here: it is ES5 a page of any age can parse, it talks to the frame only at the Forge
// origin and listens only to its own iframe there, and its launcher is a labelled button that Escape
// closes. jsdom loads no iframe, so the frame's side is played by dispatching its messages.

const SOURCE = readFileSync(resolve(__dirname, "../../../public/widget.js"), "utf8");
const FORGE = "https://forge.example";
const SITE_KEY = `fw_site_${"a".repeat(32)}`;

interface Api {
  open(): void;
  close(): void;
  toggle(): void;
  setContext(c: Record<string, unknown>): void;
  identify(w: Record<string, unknown>): void;
  q: { push(call: unknown[]): void };
}
const api = () => (window as unknown as { ForgeWidget: Api }).ForgeWidget;

function load(siteKey: string = SITE_KEY, src = `${FORGE}/widget.js`) {
  const tag = document.createElement("script");
  tag.setAttribute("data-site-key", siteKey);
  tag.setAttribute("src", src);
  tag.type = "text/plain";
  document.head.appendChild(tag);
  // the loader as a page runs it: one classic script, in the page's global scope
  window.eval(SOURCE);
}

const shadow = () => document.querySelector("[data-forge-widget]")?.shadowRoot ?? null;
const launcher = () => shadow()?.querySelector("button") ?? null;
const frame = () => shadow()?.querySelector("iframe") ?? null;

function fromFrame(data: unknown, origin = FORGE, source: Window | null = frame()?.contentWindow ?? null) {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  delete (window as unknown as { ForgeWidget?: unknown }).ForgeWidget;
});
afterEach(() => vi.restoreAllMocks());

/** Every node of the loader's syntax tree that ES5 does not have, by its kind and line. */
function beyondEs5(text: string): string[] {
  const file = ts.createSourceFile("widget.js", text, ts.ScriptTarget.ES5, true, ts.ScriptKind.JS);
  const late = new Set([
    ts.SyntaxKind.ArrowFunction,
    ts.SyntaxKind.ClassDeclaration,
    ts.SyntaxKind.ClassExpression,
    ts.SyntaxKind.TemplateExpression,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.SpreadElement,
    ts.SyntaxKind.SpreadAssignment,
    ts.SyntaxKind.ShorthandPropertyAssignment,
    ts.SyntaxKind.ObjectBindingPattern,
    ts.SyntaxKind.ArrayBindingPattern,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.AwaitExpression,
    ts.SyntaxKind.YieldExpression,
    ts.SyntaxKind.ComputedPropertyName,
  ]);
  const found: string[] = [];
  const at = (node: ts.Node) => `${ts.SyntaxKind[node.kind]} at line ${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const walk = (node: ts.Node) => {
    if (late.has(node.kind)) found.push(at(node));
    if (ts.isVariableDeclarationList(node) && node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) found.push(`let/const ${at(node)}`);
    if (ts.isMethodDeclaration(node)) found.push(at(node));
    if (ts.isParameter(node) && node.initializer) found.push(`default parameter ${at(node)}`);
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.asteriskToken) found.push(`generator ${at(node)}`);
    if ((ts.isFunctionLike(node) || ts.isFunctionDeclaration(node)) && ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Async)
      found.push(`async ${at(node)}`);
    ts.forEachChild(node, walk);
  };
  walk(file);
  if ((file as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length > 0) found.push("a syntax error");
  return found;
}

describe("the widget loader's language", () => {
  it("is ES5 a page of any age parses, with no module syntax", () => {
    expect(beyondEs5(SOURCE)).toEqual([]);
    expect(SOURCE).not.toMatch(/^\s*(import|export)\s/m);
  });

  it("refuses a planted arrow, const, template and spread by kind and line", () => {
    const planted = beyondEs5("var a = () => 1;\nconst b = `x${a}`;\nvar c = [...b];");
    expect(planted).toEqual(
      expect.arrayContaining([
        "ArrowFunction at line 1",
        expect.stringMatching(/^let\/const .* at line 2$/),
        "TemplateExpression at line 2",
        "SpreadElement at line 3",
      ]),
    );
  });
});

describe("the widget loader on a client page", () => {
  it("draws a labelled launcher in a shadow root and no frame until it is opened", () => {
    load();
    expect(launcher()?.getAttribute("aria-label")).toBe("Open feedback chat");
    expect(launcher()?.getAttribute("aria-expanded")).toBe("false");
    expect(frame()).toBeNull();
    expect(document.body.querySelector("button")).toBeNull();
  });

  it("opens the frame at the site key's frame path beside the script, under its base path", () => {
    load(SITE_KEY, `${FORGE}/forge/widget.js?v=1`);
    api().open();
    expect(frame()?.getAttribute("src")).toBe(`${FORGE}/forge/w/${SITE_KEY}`);
    expect(frame()?.getAttribute("referrerpolicy")).toBe("origin");
    expect(frame()?.title).toBe("Feedback chat");
    expect(launcher()?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(document.querySelector("[data-forge-widget]"));
  });

  it("stays off, by name, for a script tag whose site key is not one", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    load("fw_site_short");
    expect(shadow()).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("no valid data-site-key"));
  });

  it("sends context, identity and open to the frame at the Forge origin only, once the frame says ready", () => {
    load();
    document.title = "Blue kettle";
    api().identify({ userId: "u1", ts: 1760000000, sig: "f".repeat(64), email: "a@b.co" });
    api().setContext({ productId: "kettle-blue", extra: { plan: "pro" } });
    api().open();
    const target = frame()?.contentWindow;
    if (!target) throw new Error("no frame window");
    const post = vi.spyOn(target, "postMessage").mockImplementation(() => {});
    fromFrame({ source: "forge-widget", type: "ready" });
    const sent = post.mock.calls.map(([message, origin]) => ({ message: message as { type: string }, origin }));
    expect(sent.map((s) => s.origin)).toEqual([FORGE, FORGE, FORGE]);
    expect(sent.map((s) => s.message.type)).toEqual(["context", "identify", "open"]);
    expect(sent[0]?.message).toMatchObject({
      source: "forge-widget",
      context: { url: window.location.href, title: "Blue kettle", productId: "kettle-blue", extra: { plan: "pro" } },
    });
    expect(sent[1]?.message).toMatchObject({ signed: { userId: "u1", ts: 1760000000, sig: "f".repeat(64), email: "a@b.co" } });
  });

  it("takes no frame message from another origin, another window, or without its source", () => {
    load();
    api().open();
    const target = frame()?.contentWindow;
    if (!target) throw new Error("no frame window");
    const post = vi.spyOn(target, "postMessage").mockImplementation(() => {});
    fromFrame({ source: "forge-widget", type: "ready" }, "https://evil.example");
    fromFrame({ source: "forge-widget", type: "ready" }, FORGE, window);
    fromFrame({ type: "ready" });
    fromFrame({ source: "forge-widget", type: "close" }, "https://evil.example");
    expect(post).not.toHaveBeenCalled();
    expect(launcher()?.getAttribute("aria-expanded")).toBe("true");
    fromFrame({ source: "forge-widget", type: "close" });
    expect(launcher()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("badges the launcher with the frame's unread count while closed, and clears it on open", () => {
    load();
    api().open();
    fromFrame({ source: "forge-widget", type: "close" });
    fromFrame({ source: "forge-widget", type: "unread", count: 3 });
    expect(launcher()?.getAttribute("aria-label")).toBe("Open feedback chat, 3 unread");
    fromFrame({ source: "forge-widget", type: "unread", count: 4 }, "https://evil.example");
    expect(launcher()?.getAttribute("aria-label")).toBe("Open feedback chat, 3 unread");
    api().open();
    expect(launcher()?.getAttribute("aria-label")).toBe("Close feedback chat");
  });

  it("closes on Escape and gives focus back to the launcher", () => {
    load();
    launcher()?.focus();
    launcher()?.click();
    expect(launcher()?.getAttribute("aria-expanded")).toBe("true");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(launcher()?.getAttribute("aria-expanded")).toBe("false");
    expect(shadow()?.activeElement).toBe(launcher());
  });

  it("refuses a context key and a signature the contract does not take, by name", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    load();
    api().setContext({ productId: "p", secret: "x" });
    api().identify({ userId: "u1", ts: 1760000000, sig: "not-hex" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("secret is not a context field"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("identify needs sig as 64 lower-case hex characters"));
  });

  it("runs calls queued before it loaded, and queued after through the same push", () => {
    (window as unknown as { ForgeWidget: unknown }).ForgeWidget = { q: [["open"]] };
    load();
    expect(launcher()?.getAttribute("aria-expanded")).toBe("true");
    api().q.push(["close"]);
    expect(launcher()?.getAttribute("aria-expanded")).toBe("false");
  });
});
