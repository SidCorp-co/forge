// One headless Chrome per test file, launched once and spoken to over the DevTools protocol, so no
// case carries a launch: a layout case opens a tab in the running browser and closes it again.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROMES = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

/** What a first launch may take, and what the first stylesheet compile may take, each on its own clock. */
export const WARM_LAUNCH_MS = 60_000;
export const WARM_STYLESHEET_MS = 60_000;
/** A `beforeAll` hook's timeout: it holds both steps, so it outlasts them and each names itself first. */
export const WARM_HOOK_MS = WARM_LAUNCH_MS + WARM_STYLESHEET_MS + 30_000;

export function chromeBinary(): string {
  const named = process.env.CHROME_BIN;
  if (named && !existsSync(named)) {
    throw new Error(`CHROME_BIN names ${named}, which is not a file: a layout test that cannot run is not a pass. Point it at a Chrome or Chromium binary.`);
  }
  const found = named || CHROMES.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `No Chrome to lay the page out in: looked for ${CHROMES.join(", ")} and CHROME_BIN. Set CHROME_BIN to a Chrome or Chromium binary; a layout test that cannot run is not a pass.`,
    );
  }
  return found;
}

/** Fails with what it was waiting for, not with a test that timed out. */
export function within<T>(what: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export interface LaunchOptions {
  chrome?: string;
  launchMs?: number;
}

export interface ChromeSession {
  chrome: string;
  /** Opens `url` in a tab, returns what `expression` evaluates to once it is non-empty ("" at `waitMs`), and closes the tab. */
  evaluateWhenReady(url: string, expression: string, waitMs: number): Promise<string>;
  close(): Promise<void>;
}

type Send = (method: string, params?: object, sessionId?: string) => Promise<Record<string, unknown>>;

function connect(url: string): Promise<Send> {
  return new Promise((done, fail) => {
    const ws = new WebSocket(url);
    let next = 0;
    const pending = new Map<number, { ok: (v: Record<string, unknown>) => void; no: (e: Error) => void }>();
    ws.addEventListener("error", () => fail(new Error(`DevTools socket ${url} failed to open`)));
    ws.addEventListener("message", (event) => {
      const reply = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
      const waiting = reply.id === undefined ? undefined : pending.get(reply.id);
      if (!waiting || reply.id === undefined) return;
      pending.delete(reply.id);
      if (reply.error) waiting.no(new Error(reply.error.message));
      else waiting.ok(reply.result ?? {});
    });
    ws.addEventListener("close", () => {
      for (const waiting of pending.values()) waiting.no(new Error("Chrome closed the DevTools socket"));
      pending.clear();
    });
    ws.addEventListener("open", () =>
      done(
        (method, params = {}, sessionId) =>
          new Promise((ok, no) => {
            next += 1;
            pending.set(next, { ok, no });
            ws.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
          }),
      ),
    );
  });
}

/** Starts Chrome and waits, on its own clock, for it to say where it listens. */
export async function launchChrome({ chrome = chromeBinary(), launchMs = WARM_LAUNCH_MS }: LaunchOptions = {}): Promise<ChromeSession> {
  const profile = mkdtempSync(join(tmpdir(), "forge-chrome-profile-"));
  const child: ChildProcess = spawn(
    chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      `--user-data-dir=${profile}`,
      "--window-size=1000,1300",
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  const gone = new Promise<void>((done) => child.once("exit", () => done()));
  // Chrome's helper processes live in its group and keep writing to the profile until they are killed too.
  const kill = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const stop = () => {
    kill();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  process.once("exit", kill);
  const listening = new Promise<string>((found, fail) => {
    let heard = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      heard += chunk.toString();
      const at = /DevTools listening on (ws:\/\/\S+)/.exec(heard);
      if (at?.[1]) found(at[1]);
    });
    child.once("error", (error) => fail(new Error(`Chrome at ${chrome} could not be launched: ${error.message}. A layout test that cannot run is not a pass.`)));
    child.once("exit", (code) => fail(new Error(`Chrome at ${chrome} exited with ${code} before it was listening: ${heard.trim().slice(-300)}`)));
  });
  try {
    const url = await within(`Chrome at ${chrome} first launch`, launchMs, listening);
    const send = await within(`Chrome at ${chrome} opening its DevTools socket`, launchMs, connect(url));
    return {
      chrome,
      async evaluateWhenReady(pageUrl, expression, waitMs) {
        const { targetId } = (await send("Target.createTarget", { url: pageUrl })) as { targetId: string };
        try {
          const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
          const until = Date.now() + waitMs;
          for (;;) {
            const { result } = (await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)) as { result: { value?: string } };
            if (result.value) return result.value;
            if (Date.now() > until) return "";
            await new Promise((later) => setTimeout(later, 25));
          }
        } finally {
          await send("Target.closeTarget", { targetId }).catch(() => undefined);
        }
      },
      async close() {
        process.off("exit", kill);
        kill();
        await gone;
        stop();
      },
    };
  } catch (error) {
    process.off("exit", kill);
    stop();
    throw error;
  }
}
