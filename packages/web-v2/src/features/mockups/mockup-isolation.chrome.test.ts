// @vitest-environment node
// REQ-49 BC-1, in a real browser: an HTML mockup's scripts run, and reach nothing of Forge's. The
// frame is the one `MockupFrame` renders, on a page of a Forge origin that holds a session cookie
// and answers an API call with that cookie's secret. The mockup's script tries to read the
// cookie, call the API from inside the frame, and call it through the parent; it reports what each
// got by `postMessage`, the one channel it is given. jsdom has no origins, so only Chrome can say
// this: with `allow-same-origin` planted beside `allow-scripts` the script reads the cookie and the
// API answers it, and this goes red. Chrome is `WITNESS_CHROME`, else `google-chrome`; a box
// without it fails here by name rather than skipping. Chrome is a program the whole-tree guard
// cannot read inside, so it counts it as listing the root; it reads only its own fresh profile.
// @gate-input whole-tree

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockupFrame } from "./components/mockup-preview";

const SECRET = "forge-session-secret";

/** The mockup: everything it tries, each answered as what it got or the error that stopped it. */
const MOCKUP = `<!doctype html><html><body><p id="ran">0</p><script>
(async () => {
  const out = {};
  const tryTo = async (label, act) => {
    try { out[label] = String(await act()); } catch (e) { out[label] = "refused: " + e.name; }
  };
  document.getElementById("ran").textContent = "1";
  await tryTo("parentCookie", () => parent.document.cookie);
  await tryTo("ownCookie", () => document.cookie);
  await tryTo("fetch", async () => (await fetch("ORIGIN/api/me", { credentials: "include" })).text());
  await tryTo("parentFetch", async () => (await parent.fetch("/api/me")).text());
  await tryTo("storage", () => parent.localStorage.getItem("forge"));
  parent.postMessage({ ran: document.getElementById("ran").textContent, ...out }, "*");
})();
</script><img src="ORIGIN/api/pixel"></body></html>`;

let server: Server;
let origin = "";
const apiCalls: string[] = [];

function parentPage() {
  const frame = renderToStaticMarkup(createElement(MockupFrame, { html: MOCKUP.replaceAll("ORIGIN", origin), title: "Mockup" }));
  return `<!doctype html><html><body>
<script>
  document.cookie = "forge_session=${SECRET}; path=/";
  localStorage.setItem("forge", "${SECRET}");
  addEventListener("message", (e) => { window.__result = JSON.stringify(e.data); });
</script>
${frame}
</body></html>`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/api/")) {
      apiCalls.push(req.url);
      const signedIn = (req.headers.cookie ?? "").includes(SECRET);
      res.writeHead(signedIn ? 200 : 401, { "content-type": "text/plain" });
      res.end(signedIn ? SECRET : "signed out");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(parentPage());
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chrome headless on a fresh profile, and the DevTools socket of its one page. */
async function chrome(): Promise<{ proc: ChildProcess; page: string; profile: string }> {
  const bin = process.env.WITNESS_CHROME ?? "google-chrome";
  const profile = mkdtempSync(join(tmpdir(), "mockup-isolation-"));
  const proc = spawn(bin, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${profile}`, "about:blank"], {
    stdio: "ignore",
  });
  const start: { failed?: Error } = {};
  proc.on("error", (e) => (start.failed = new Error(`${bin} could not start (${e.message}): this test needs Chrome; set WITNESS_CHROME to its binary`)));
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 150 && !existsSync(portFile); i++) {
    if (start.failed) throw start.failed;
    await pause(100);
  }
  if (!existsSync(portFile)) throw new Error(`${bin} wrote no DevToolsActivePort in 15s`);
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  for (let i = 0; i < 50; i++) {
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === "page");
    if (page) return { proc, page: page.webSocketDebuggerUrl, profile };
    await pause(100);
  }
  throw new Error(`${bin} opened no page to drive`);
}

/** Loads the parent page and answers what the mockup's script reported, once it has. */
async function whatTheMockupGot(): Promise<Record<string, string>> {
  const { proc, page, profile } = await chrome();
  try {
    const ws = new WebSocket(page);
    await new Promise((ok, fail) => {
      ws.onopen = ok;
      ws.onerror = () => fail(new Error(`could not open ${page}`));
    });
    let id = 0;
    const waiting = new Map<number, (v: unknown) => void>();
    // what the page said on its way, so a script that never reports is named by what stopped it
    const said: string[] = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown; method?: string; params?: { entry?: { text: string }; exceptionDetails?: { text: string; exception?: { description?: string } } } };
      if (msg.id !== undefined) waiting.get(msg.id)?.(msg.result);
      if (msg.method === "Log.entryAdded" && msg.params?.entry) said.push(msg.params.entry.text);
      const thrown = msg.method === "Runtime.exceptionThrown" ? msg.params?.exceptionDetails : undefined;
      if (thrown) said.push(thrown.exception?.description ?? thrown.text);
    };
    const send = (method: string, params: object) =>
      new Promise<unknown>((ok) => {
        waiting.set(++id, ok);
        ws.send(JSON.stringify({ id, method, params }));
      });
    await send("Log.enable", {});
    await send("Runtime.enable", {});
    await send("Page.navigate", { url: `${origin}/` });
    for (let i = 0; i < 100; i++) {
      const r = (await send("Runtime.evaluate", { expression: "window.__result ?? null", returnByValue: true })) as { result: { value: string | null } };
      if (r.result.value) {
        ws.close();
        return JSON.parse(r.result.value) as Record<string, string>;
      }
      await pause(100);
    }
    throw new Error(`the mockup's script reported nothing in 10s: it did not run. The page said: ${said.join(" | ") || "nothing"}`);
  } finally {
    proc.kill();
    await new Promise((ok) => (proc.exitCode === null ? proc.once("exit", ok) : ok(null)));
    // a helper process can still be writing the profile after the browser exits (ENOTEMPTY on CI)
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe("an HTML mockup in Chrome", () => {
  it("runs its scripts, and reads no cookie, storage or API of the page it sits on", async () => {
    const got = await whatTheMockupGot();
    expect(got).toEqual({
      ran: "1",
      parentCookie: "refused: SecurityError",
      ownCookie: "refused: SecurityError",
      fetch: "refused: TypeError",
      parentFetch: "refused: SecurityError",
      storage: "refused: SecurityError",
    });
    // nothing it tried — a call, through the parent or not, nor an image — reached the server
    expect(apiCalls).toEqual([]);
  }, 30_000);
});
