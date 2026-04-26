import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./index.css";

// Forward client errors + console.error to the Tauri Rust process so they
// land in the same stdout stream the dev runner tails. Lets us debug the
// "white window" class of bugs without right-click → Inspect.
function feLog(prefix: string, parts: unknown[]) {
  try {
    const msg = parts
      .map((p) => {
        if (typeof p === "string") return p;
        if (p instanceof Error) return `${p.name}: ${p.message}\n${p.stack ?? ""}`;
        try {
          return JSON.stringify(p);
        } catch {
          return String(p);
        }
      })
      .join(" ");
    void invoke("fe_log", { msg: `[${prefix}] ${msg}` }).catch(() => {});
  } catch {
    // ignore — never let logging crash the page
  }
}

const origConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  origConsoleError(...args);
  feLog("console.error", args);
};

const origConsoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  origConsoleWarn(...args);
  feLog("console.warn", args);
};

window.addEventListener("error", (e) => {
  feLog("window.error", [e.message, e.error]);
});
window.addEventListener("unhandledrejection", (e) => {
  feLog("unhandledrejection", [e.reason]);
});

feLog("boot", ["main.tsx loaded — webview alive"]);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
