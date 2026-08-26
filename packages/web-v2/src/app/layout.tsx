import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { ThemeProvider } from "@/providers/theme-provider";
import { QueryProvider } from "@/providers/query-provider";
import { AuthProvider } from "@/providers/auth-provider";
import { WsMount } from "@/providers/ws-mount";
import { ToastProvider } from "@/providers/toast-provider";
import { SentryInit } from "@/providers/sentry-init";
import { RouteProgress } from "@/design/patterns/route-progress";
import "./globals.css";

// cm:guard both families are VENDORED (fonts/*.woff2, provenance in fonts/README.md) and must stay that way — `next/font/google` fetches the binaries at build time, and one Coolify app builds core and web-v2 together, so a font host that does not answer fails the BACKEND deploy too (2026-08-13: deploy zs4ocksc8sokkcw0g0g0w4s0 exit 1, a core-only fix merged-but-not-live ~90 min). fonts.test.ts fails if the import comes back.
const hanken = localFont({
  src: "./fonts/hanken-grotesk-latin-variable.woff2",
  variable: "--font-hanken",
  weight: "100 900",
  style: "normal",
  display: "swap",
});

const jetbrainsMono = localFont({
  src: "./fonts/jetbrains-mono-latin-variable.woff2",
  variable: "--font-jetbrains",
  weight: "400 800",
  style: "normal",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Forge",
  description: "A calm, bright control plane for running Claude Code at scale.",
};

// `viewport-fit=cover` lets the UI extend under notches/home indicators so our
// `env(safe-area-inset-*)` padding (mobile drawer / topbar) actually applies.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // cm:guard the two `.variable` classes belong on <html>, NEVER <body> — tokens.css declares `--font-sans: var(--font-hanken), …` at :root, and a var() is substituted with the custom-property value in scope at the DECLARING element (:root === <html>), so vars defined only on a descendant resolve to empty and every screen silently falls back to system sans (ISS-306's decisive root cause; the compiled CSS looks correct either way, so only getComputedStyle on a live page catches it).
    <html
      lang="en"
      data-theme="light"
      className={`${hanken.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <SentryInit />
        <ThemeProvider>
          <QueryProvider>
            <AuthProvider>
              {/* WsMount lives inside Auth + Query so the hook sees both the
                  current user and the QueryClient it invalidates against. */}
              <WsMount />
              <ToastProvider>
                <RouteProgress />
                {children}
              </ToastProvider>
            </AuthProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
