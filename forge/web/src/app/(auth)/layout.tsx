import { Suspense } from 'react';
import { ForceLightTheme } from '@/components/force-light-theme';
import { BrandPanel } from './components/brand-panel';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-theme="light"
      className="fixed inset-0 overflow-y-auto bg-background text-on-surface selection:bg-warning/30"
    >
      {/* Drive next-themes to "light" while these public auth pages are
          mounted — same pattern landing/download use so a visitor with dark
          theme saved still sees the intended marketing surface. */}
      <ForceLightTheme />
      {/* Subtle dot grid — same vocabulary as /download hero. Cheap, calm,
          gives the surface tactile depth without a noise overlay. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 opacity-[0.5]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, rgba(0,0,0,0.05) 1px, transparent 0)',
          backgroundSize: '28px 28px',
        }}
      />

      <main className="relative mx-auto grid min-h-full max-w-6xl grid-cols-1 gap-x-12 px-6 py-10 sm:px-10 lg:grid-cols-5 lg:gap-x-20 lg:py-16">
        <section className="flex items-center justify-center lg:col-span-3 lg:justify-end">
          {children}
        </section>
        <div className="lg:col-span-2">
          {/* Suspense so a slow GitHub API call inside BrandPanel doesn't
              hold up the form render. The fallback is `null` since the panel
              is decorative on lg-only viewports. */}
          <Suspense fallback={null}>
            <BrandPanel />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
