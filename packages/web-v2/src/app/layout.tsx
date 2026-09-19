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
