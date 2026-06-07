import { notFound } from "next/navigation";

/**
 * `/kit` is the internal design-system gallery + Suspense sandbox — a dev-only
 * surface. web-v2 serves at the host root since ISS-397, so without this gate
 * the gallery would be publicly reachable in the canonical prod UI. Render it
 * only outside production; in prod the segment 404s like any unknown route.
 */
export default function KitLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === "production") notFound();
  return <>{children}</>;
}
