"use client";

import { MovedRedirect } from "@/features/shell/components/moved-redirect";

// REQ-33: the project Memory page was removed; an old link lands where its record is read now.
export default function MovedMemoryPage() {
  return <MovedRedirect page="memory" />;
}
