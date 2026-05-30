"use client";

/* template.tsx re-mounts on every navigation, so this enter animation plays
   on each route change (unlike layout.tsx, which persists). */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="forge-rise">{children}</div>;
}
