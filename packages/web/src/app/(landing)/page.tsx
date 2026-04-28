import { ForceLightTheme } from '@/components/force-light-theme';
import {
  LandingNav,
  LandingHero,
  LandingPulse,
  LandingSpeedProof,
  LandingShowcase,
  LandingForge,
  LandingTrust,
  LandingScope,
  LandingCta,
  LandingFooter,
} from './components';

export default function LandingPage() {
  // Section sequence reads as a narrative: hook → live proof → numbers →
  // past work → product behind it all → who we are → scope → CTA → footer.
  // Pulse comes right after the hero so the visitor sees motion before any
  // static content; otherwise the page risks feeling brochure-y.
  // ForceLightTheme drives next-themes to "light" while this page is mounted
  // (restored on unmount) — the SidCorp landing is light-only by design.
  return (
    <>
      <ForceLightTheme />
      <div data-theme="light" className="fixed inset-0 overflow-y-auto bg-background text-on-surface">
        <LandingNav />
        <LandingHero />
        <LandingPulse />
        <LandingSpeedProof />
        <LandingShowcase />
        <LandingForge />
        <LandingTrust />
        <LandingScope />
        <LandingCta />
        <LandingFooter />
      </div>
    </>
  );
}
