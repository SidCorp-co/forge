"use client";

import { useAuth } from "@/providers/auth-provider";
import { SharedAnswer } from "./shared-answer";

export function SharedAnswerPage({ token }: { token: string }) {
  const { user, isLoading } = useAuth();
  return (
    <div className="min-h-dvh bg-app">
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <SharedAnswer token={token} signedIn={isLoading ? null : user !== null} />
      </main>
    </div>
  );
}
