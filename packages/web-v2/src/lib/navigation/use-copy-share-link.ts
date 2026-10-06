"use client";

import { useToast } from "@/providers/toast-provider";
import { buildShareLink } from "./deep-link";

/**
 * Copies the shareable link to an in-app path, and toasts whether the copy worked. A failed copy
 * shows the link, so it can be copied by hand: an insecure origin has no `navigator.clipboard`.
 */
export function useCopyShareLink(): (path: string) => void {
  const { toast } = useToast();
  return (path) => {
    const url = buildShareLink(path);
    const failed = () => toast({ title: "Couldn't copy link", description: url, tone: "error" });
    if (!navigator.clipboard) {
      failed();
      return;
    }
    navigator.clipboard.writeText(url).then(
      () => toast({ title: "Link copied", description: url, tone: "success" }),
      failed,
    );
  };
}
