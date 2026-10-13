import { useRouterState } from "@tanstack/react-router";

/** The 2px bar along the top while the router loads a route, in the accent. */
export function RouteProgress() {
  const loading = useRouterState({ select: (state) => state.status === "pending" });
  return (
    <div
      aria-hidden
      className={`pointer-events-none fixed inset-x-0 top-0 z-[80] h-0.5 origin-left bg-accent transition-[transform,opacity] duration-300 ${
        loading ? "scale-x-75 opacity-100" : "scale-x-100 opacity-0"
      }`}
    />
  );
}
