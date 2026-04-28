import Link from 'next/link';

export function LandingNav() {
  return (
    <nav className="fixed top-0 inset-x-0 z-50 flex items-center justify-between px-6 py-4 backdrop-blur-2xl bg-white/70 border-b border-outline-variant/30">
      <span className="text-xl font-semibold tracking-tight text-on-surface">SidCorp</span>
      <div className="flex items-center gap-6">
        <a href="#showcase" className="text-sm text-primary-fixed hover:text-on-surface transition-colors hidden sm:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 focus-visible:ring-offset-2 rounded-sm">Work</a>
        <a href="#forge" className="text-sm text-primary-fixed hover:text-on-surface transition-colors hidden sm:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 focus-visible:ring-offset-2 rounded-sm">Forge</a>
        <a href="#trust" className="text-sm text-primary-fixed hover:text-on-surface transition-colors hidden sm:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 focus-visible:ring-offset-2 rounded-sm">Team</a>
        <a href="#book" className="text-sm text-primary-fixed hover:text-on-surface transition-colors hidden sm:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 focus-visible:ring-offset-2 rounded-sm">Book a Call</a>
        <Link href="/login" className="text-sm text-primary-fixed hover:text-on-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 focus-visible:ring-offset-2 rounded-sm">Log in</Link>
        <Link href="/register" className="inline-flex items-center gap-1.5 rounded-lg bg-[linear-gradient(135deg,#855300_0%,#f59e0b_100%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity shadow-sm">
          Get Started
        </Link>
      </div>
    </nav>
  );
}
