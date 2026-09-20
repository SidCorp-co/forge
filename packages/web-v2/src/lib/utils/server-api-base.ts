/** The core API origin as seen from the web server process (never the browser).
 *
 *  `NEXT_PUBLIC_API_URL` is the deployed value and already carries the `/api`
 *  suffix; `E2E_CORE_PROXY_URL` is the e2e harness's core, which does not.
 *  Shared by the operator gate and the public guide pages so both resolve one
 *  origin — a second copy of this fallback chain is a second thing to keep in
 *  step with the deployment. */
export function resolveServerApiBase(): string {
  const base =
    process.env.NEXT_PUBLIC_API_URL ||
    (process.env.E2E_CORE_PROXY_URL ? `${process.env.E2E_CORE_PROXY_URL}/api` : null) ||
    "http://localhost:8080/api";
  return base.replace(/\/+$/, "");
}
