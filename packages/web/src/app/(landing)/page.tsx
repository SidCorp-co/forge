import { ForceLightTheme } from '@/components/force-light-theme';
import {
  LandingNav,
  LandingHero,
  LandingWhy,
  LandingPipeline,
  LandingArchitecture,
  LandingScope,
  LandingQuickstart,
  LandingCta,
  LandingFooter,
} from './components';

export default function LandingPage() {
  // Section sequence reads as a narrative for a dev visitor:
  // hook → who it's for → how the pipeline works → architecture
  // (the credential boundary moat) → today vs roadmap → quickstart
  // → repeat the CTA → footer.
  // ForceLightTheme drives next-themes to "light" while this page is
  // mounted (restored on unmount) — the landing is light-only by design.
  return (
    <>
      <ForceLightTheme />
      <div data-theme="light" className="fixed inset-0 overflow-y-auto bg-background text-on-surface">
        <LandingNav />
        <LandingHero />
        <LandingWhy />
        <LandingPipeline />
        <LandingArchitecture />
        <LandingScope />
        <LandingQuickstart />
        <LandingCta />
        <LandingFooter />
      </div>
    </>
  );
}
