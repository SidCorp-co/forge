import {
  LandingNav,
  LandingHero,
  LandingSpeedProof,
  LandingShowcase,
  LandingTrust,
  LandingScope,
  LandingCta,
  LandingFooter,
} from './components';

export default function LandingPage() {
  return (
    <div data-theme="light" className="fixed inset-0 overflow-y-auto bg-background text-on-surface">
      <LandingNav />
      <LandingHero />
      <LandingSpeedProof />
      <LandingShowcase />
      <LandingTrust />
      <LandingScope />
      <LandingCta />
      <LandingFooter />
    </div>
  );
}
