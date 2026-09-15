"use client";

// The self an org admin writes for one agent: who it is (soul, greeting,
// glyph), what it always does (standing instructions), and when it speaks
// (presence). Stored in the database, rendered into every turn the agent takes.
import { useEffect, useState } from "react";
import type { AgentSelf, AgentSelfPatch, AnswerInGroupMode } from "@forge/contracts";
import { Button, Field, Input, Select, type SelectOption, Skeleton, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { useAgentSelf, useUpdateAgentSelf } from "../hooks";

const ANSWER_IN_GROUP: SelectOption[] = [
  { value: "window", label: "Every settled window — answer whatever is said" },
  { value: "mention", label: "Only when named — @handle in the window" },
];
const ON_OFF: SelectOption[] = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
];
const MINUTE = 60_000;

interface Draft {
  soul: string;
  instructions: string;
  greeting: string;
  emoji: string;
  answerInGroup: AnswerInGroupMode;
  heartbeat: boolean;
  heartbeatMinutes: string;
  backoffAfter: string;
  dormantHours: string;
}

function draftOf(self: AgentSelf): Draft {
  const p = self.presence;
  return {
    soul: self.soul ?? "",
    instructions: self.instructions ?? "",
    greeting: self.greeting ?? "",
    emoji: self.emoji ?? "",
    answerInGroup: p.answerInGroup ?? "window",
    heartbeat: p.heartbeat?.enabled ?? false,
    heartbeatMinutes: p.heartbeat?.intervalMs ? String(p.heartbeat.intervalMs / MINUTE) : "",
    backoffAfter: p.backoffAfter !== undefined ? String(p.backoffAfter) : "",
    dormantHours: p.dormantMs !== undefined ? String(p.dormantMs / (60 * MINUTE)) : "",
  };
}

const text = (v: string): string | null => (v.trim() === "" ? null : v);
const num = (v: string, scale = 1): number | null =>
  v.trim() === "" ? null : Number(v) * scale;

/**
 * The patch a draft sends: text fields whole, presence keys one by one — an
 * emptied number is sent as `null`, which UNSETS the key so the default folds back.
 */
// cm:guard every presence key the form shows is SENT, set or null, and none it does not show is touched: `writeAgentSelf` merges presence key by key, so a key left out stays as it was and a key sent null goes back to its default — the affordance a wholesale replace would deny (ISS-1034 criterion 51).
export function patchOf(draft: Draft): AgentSelfPatch {
  return {
    soul: text(draft.soul),
    instructions: text(draft.instructions),
    greeting: text(draft.greeting),
    emoji: text(draft.emoji),
    presence: {
      answerInGroup: draft.answerInGroup,
      heartbeat: {
        enabled: draft.heartbeat,
        intervalMs: num(draft.heartbeatMinutes, MINUTE),
      },
      backoffAfter: num(draft.backoffAfter),
      dormantMs: num(draft.dormantHours, 60 * MINUTE),
    },
  };
}

export function AgentSelfEditor({
  orgId,
  agentUserId,
  handle,
}: {
  orgId: string | null;
  agentUserId: string;
  handle: string;
}) {
  const selfQ = useAgentSelf(orgId, agentUserId);
  const save = useUpdateAgentSelf(orgId);
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (selfQ.data) setDraft(draftOf(selfQ.data));
  }, [selfQ.data]);

  // cm:guard the error branch comes BEFORE the no-draft branch: a first read that fails leaves no draft, and a skeleton returned first would spin for ever over a refusal the admin could act on (codex F6).
  if (selfQ.isError) {
    return (
      <div className="flex items-center gap-3" data-testid={`agent-self-error-${agentUserId}`}>
        <p className="fg-body-sm text-danger">{formatApiError(selfQ.error)}</p>
        <Button variant="secondary" onClick={() => void selfQ.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (selfQ.isLoading || !draft) return <Skeleton className="h-40 w-full rounded-md" />;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  async function onSave() {
    if (!draft) return;
    try {
      await save.mutateAsync({ agentUserId, patch: patchOf(draft) });
      toast({ title: `Saved @${handle}'s self`, tone: "success" });
    } catch (err) {
      toast({ title: "Could not save", description: formatApiError(err), tone: "error" });
    }
  }

  return (
    <div className="space-y-4" data-testid={`agent-self-${agentUserId}`}>
      <Field label="Soul" hint="Who this agent is, in its own voice. Rendered at the top of every turn.">
        <Textarea value={draft.soul} rows={5} maxLength={8000} onChange={(e) => set("soul", e.target.value)} />
      </Field>
      <Field label="Standing instructions" hint="What it always does, whatever the room.">
        <Textarea
          value={draft.instructions}
          rows={4}
          maxLength={8000}
          onChange={(e) => set("instructions", e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Greeting" hint="How it opens a first reply.">
          <Input value={draft.greeting} maxLength={500} onChange={(e) => set("greeting", e.target.value)} />
        </Field>
        <Field label="Glyph" hint="An emoji it signs with.">
          <Input value={draft.emoji} maxLength={16} onChange={(e) => set("emoji", e.target.value)} />
        </Field>
      </div>
      <h4 className="fg-label mt-2">When it speaks</h4>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="In a group room">
          <Select
            options={ANSWER_IN_GROUP}
            value={draft.answerInGroup}
            onChange={(v) => set("answerInGroup", v as AnswerInGroupMode)}
          />
        </Field>
        <Field label="Back off after quiet windows" hint="Empty = default (3). 1–20.">
          <Input
            inputMode="numeric"
            value={draft.backoffAfter}
            onChange={(e) => set("backoffAfter", e.target.value)}
          />
        </Field>
        <Field label="Heartbeat">
          <Select
            options={ON_OFF}
            value={draft.heartbeat ? "on" : "off"}
            onChange={(v) => set("heartbeat", v === "on")}
          />
        </Field>
        <Field label="Heartbeat interval (minutes)" hint="Empty = default (60). 5–10080.">
          <Input
            inputMode="numeric"
            value={draft.heartbeatMinutes}
            onChange={(e) => set("heartbeatMinutes", e.target.value)}
          />
        </Field>
        <Field label="Dormant after (hours)" hint="Empty = default (24).">
          <Input
            inputMode="numeric"
            value={draft.dormantHours}
            onChange={(e) => set("dormantHours", e.target.value)}
          />
        </Field>
      </div>
      <div>
        <Button variant="primary" loading={save.isPending} onClick={onSave} className="min-h-11">
          Save self
        </Button>
      </div>
    </div>
  );
}
