"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/design";
import { type AboutKind, chatAbout } from "../ask-about";

export function AskAboutThis({ slug, kind, refId }: { slug: string; kind: AboutKind; refId: string }) {
  const router = useRouter();
  return (
    <Button variant="secondary" size="sm" icon="chat" onClick={() => router.push(chatAbout(slug, kind, refId))}>
      Ask about this
    </Button>
  );
}
