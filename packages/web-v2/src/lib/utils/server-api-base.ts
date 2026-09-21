// The core API origin as the web server process sees it, never the browser.
export function resolveServerApiBase(): string {
  const base =
    process.env.NEXT_PUBLIC_API_URL ||
    (process.env.E2E_CORE_PROXY_URL ? `${process.env.E2E_CORE_PROXY_URL}/api` : null) ||
    "http://localhost:8080/api";
  return base.replace(/\/+$/, "");
}
