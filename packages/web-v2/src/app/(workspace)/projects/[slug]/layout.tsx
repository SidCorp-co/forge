"use client";

import { MovedNotice } from "@/features/shell/components/moved-notice";

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full min-w-0 flex-col">
      <MovedNotice />
      {children}
    </div>
  );
}
