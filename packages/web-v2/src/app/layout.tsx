import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/providers/theme-provider";
import { QueryProvider } from "@/providers/query-provider";
import { AuthProvider } from "@/providers/auth-provider";
import { WsMount } from "@/providers/ws-mount";
import { ToastProvider } from "@/providers/toast-provider";
import { RouteProgress } from "@/design/patterns/route-progress";
import "./globals.css";

const hanken = Hanken_Grotesk({
  variable: "--font-hanken",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
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
    // Font variable classes go on <html> (not <body>): tokens.css declares
    // --font-sans/--font-mono at :root referencing var(--font-hanken)/
    // var(--font-jetbrains), and a var() is substituted using the custom
    // property value in scope at the DECLARING element (:root === <html>).
    // With the vars only on <body>, :root resolved them to empty and the body
    // fell back to system sans. Defining them on <html> makes :root see them,
    // so --font-sans resolves to the real next/font family.
    <html
      lang="en"
      data-theme="light"
      className={`${hanken.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body>
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
