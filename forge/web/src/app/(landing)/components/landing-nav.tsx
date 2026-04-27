import Link from 'next/link';

export function LandingNav() {
  return (
    <nav className="fixed top-0 inset-x-0 z-50 flex items-center justify-between px-6 py-4 backdrop-blur-2xl bg-white/70 border-b border-outline-variant/30">
      <span className="text-xl font-semibold tracking-tight text-on-surface">SidCorp</span>
      <div className="flex items-center gap-6">
        <a href="#showcase" className="text-sm text-primary-fixed hover:text-on-surface transition-colors hidden sm:block">Work</a>
        <a href="#forge" className="text-sm text-primary-fixed hover:text-on-surface transition-colors hidden sm:block">Forge</a>
        <a href="#trust" className="text-sm text-primary-fixed hover:text-on-surface transition-colors hidden sm:block">Team</a>
        <a href="#book" className="text-sm text-primary-fixed hover:text-on-surface transition-colors hidden sm:block">Book a Call</a>
        <Link href="/login" className="text-sm text-primary-fixed hover:text-on-surface transition-colors">Log in</Link>
        <Link href="/register" className="inline-flex items-center gap-1.5 rounded-lg bg-[linear-gradient(135deg,#855300_0%,#f59e0b_100%)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-all shadow-sm">
          Get Started
        </Link>
      </div>
    </nav>
  );
}
