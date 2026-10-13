import { HeadContent, Outlet, createRootRoute, useRouterState } from "@tanstack/react-router";
import { TooltipProvider } from "@/design";
import { RouteProgress } from "@/design/patterns/route-progress";
import { productCopy } from "@/lib/i18n/product-copy";
import { AuthProvider } from "@/providers/auth-provider";
import { QueryProvider } from "@/providers/query-provider";
import { SentryInit } from "@/providers/sentry-init";
import { ThemeProvider, ThemeSync } from "@/providers/theme-provider";
import { ToastProvider } from "@/providers/toast-provider";
import { WsMount } from "@/providers/ws-mount";
import { RootError } from "./-root-global-error";
import { RootNotFound } from "./-root-not-found";

const en = productCopy();

/** The screen under the root rises in once per top-level area, not on every move inside one. */
function Rise() {
  const area = useRouterState({ select: (state) => state.matches[1]?.routeId ?? "" });
  return (
    <div key={area} className="forge-rise">
      <Outlet />
    </div>
  );
}

function RootLayout() {
  return (
    <>
      <HeadContent />
      <SentryInit />
      <ThemeProvider>
        <QueryProvider>
          <AuthProvider>
            {/* WsMount lives inside Auth + Query so the hook sees both the
                current user and the QueryClient it invalidates against. */}
            <WsMount />
            <ThemeSync />
            <ToastProvider>
              <TooltipProvider delay={0}>
                <RouteProgress />
                <Rise />
              </TooltipProvider>
            </ToastProvider>
          </AuthProvider>
        </QueryProvider>
      </ThemeProvider>
    </>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [{ title: en("common.meta.title") }, { name: "description", content: en("common.meta.description") }],
  }),
  component: RootLayout,
  notFoundComponent: RootNotFound,
  errorComponent: RootError,
});
