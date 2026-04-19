export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative bg-background min-h-screen flex flex-col items-center justify-center p-6 selection:bg-primary selection:text-on-primary">
      {/* Noise overlay for texture */}
      <div
        className="fixed inset-0 pointer-events-none opacity-[0.02] z-[9999]"
        style={{
          backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 256 256\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'noise\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.65\' numOctaves=\'3\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23noise)\'/%3E%3C/svg%3E")',
        }}
      />
      {children}
    </div>
  );
}
