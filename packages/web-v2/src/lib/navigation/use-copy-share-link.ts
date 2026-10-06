"use client";

import { useToast } from "@/providers/toast-provider";
import { buildShareLink } from "./deep-link";

/** Copies the shareable link to an in-app path, and toasts whether the copy worked. */
export function useCopyShareLink(): (path: string) => void {
  const { toast } = useToast();
  return (path) => {
    const url = buildShareLink(path);
    navigator.clipboard?.writeText(url).then(
      () => toast({ title: "Link copied", description: url, tone: "success" }),
      () => toast({ title: "Couldn't copy link", tone: "error" }),
    );
  };
}
