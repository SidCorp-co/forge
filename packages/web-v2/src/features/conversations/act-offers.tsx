// The offers the assistant makes in a thread: a button that opens a live preview of an idea about a
// requirement or a feedback item (`offer_preview`), pressed by the person as themselves. No offer
// acts on an issue: running, dropping or releasing one is the agent's work (REQ-68 BC-6).

import type { IdeaOffer } from "@forge/contracts/idea-offer";
import { useCallback, useMemo } from "react";
import type { CanonicalBlock } from "@/features/session";
import { IdeaOfferNotice, ideaOffersOf } from "./components/idea-offers";
import type { ConversationMessage, ConversationProgressEntry } from "./types";

export function useActOffers(args: {
  messages: readonly ConversationMessage[];
  progress: ConversationProgressEntry | null | undefined;
}) {
  const byEntry = useMemo(() => {
    const map = new Map<string, IdeaOffer[]>();
    const note = (id: string, blocks: readonly CanonicalBlock[] | null | undefined) => {
      const ideas = ideaOffersOf(blocks);
      if (ideas.length > 0) map.set(id, ideas);
    };
    for (const m of args.messages) note(m.id, m.blocks);
    if (args.progress) note(args.progress.entry.id ?? "live", args.progress.entry.blocks);
    return map;
  }, [args.messages, args.progress]);

  const offersFor = useCallback(
    (entryId: string) => {
      const ideas = byEntry.get(entryId);
      if (!ideas) return null;
      return (
        <div className="mt-2 flex flex-col gap-2">
          {ideas.map((o) => (
            <IdeaOfferNotice key={`${o.about}:${o.brief}`} offer={o} />
          ))}
        </div>
      );
    },
    [byEntry],
  );
  return { offersFor };
}
