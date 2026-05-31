"use client";

// Project-level layout (ISS-307, Concept C). The project sub-nav now lives
// inline in the left NavRail (two-tier rail + searchable flyout), so this layout
// just renders the active sub-route. Each tab is still a distinct route, so
// deep-links work and the app-router restores scroll position on back/forward.
export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-full min-w-0 flex-col">{children}</div>;
}
