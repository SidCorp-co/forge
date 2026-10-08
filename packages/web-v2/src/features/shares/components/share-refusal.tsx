"use client";

import { Icon } from "@/design";
import { ApiError } from "@/lib/api/client";

/** A refusal as core gave it: its code by name, then core's own sentence. Nothing is reworded. */
export function refusalOf(error: unknown): { code: string | null; message: string } {
  if (error instanceof ApiError) return { code: error.code ?? null, message: error.message };
  return { code: null, message: error instanceof Error ? error.message : String(error) };
}

export function ShareRefusal({ error, lead }: { error: unknown; lead: string }) {
  const { code, message } = refusalOf(error);
  return (
    <div role="alert" className="flex items-start gap-2 py-2" data-testid="share-refusal" data-code={code ?? undefined}>
      <Icon name="alert" size={14} className="mt-0.5 flex-none text-[color:var(--red-600)]" />
      <p className="fg-body-sm text-fg">
        {lead}
        {code && (
          <>
            {" "}
            <span className="font-mono" translate="no">
              {code}
            </span>
          </>
        )}
        : {message}
      </p>
    </div>
  );
}
