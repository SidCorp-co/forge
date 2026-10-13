import { Outlet, createFileRoute } from "@tanstack/react-router";
import { OperatorClientGate } from "@/features/operator";
import { AdminError } from "./-error";

/** /admin: core redirects a request that is not an admin's before it serves the page; the browser
 *  asks again, and every /admin API call is refused to anyone else, so the shell grants nothing. */
function AdminLayout() {
  return (
    <OperatorClientGate>
      <Outlet />
    </OperatorClientGate>
  );
}

export const Route = createFileRoute("/admin")({ component: AdminLayout, errorComponent: AdminError });
