export function LandingFooter() {
  return (
    <footer className="bg-surface-container-low border-t border-outline-variant/20">
      <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <span className="font-semibold text-lg text-on-surface">SidCorp</span>
          <span className="ml-3 text-xs text-primary-fixed">&copy; 2026 SidCorp. All rights reserved.</span>
        </div>
        <div className="flex gap-5">
          <a href="#" className="text-xs text-primary-fixed hover:text-on-surface transition-colors">Privacy</a>
          <a href="#" className="text-xs text-primary-fixed hover:text-on-surface transition-colors">Terms</a>
          <a href="#" className="text-xs text-primary-fixed hover:text-on-surface transition-colors">Contact</a>
        </div>
      </div>
    </footer>
  );
}
