"use client";

// Project settings → Members. List (email + role) + invite by email + remove.
// Invite/remove are owner-gated by core; we surface the controls only when the
// caller is the owner (`canEdit`).
import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  ErrorState,
  Field,
  IconButton,
  Input,
  Select,
  Skeleton,
  type SelectOption,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useInviteMember, useMembers, useRemoveMember } from "../hooks";

const ROLE_OPTIONS: SelectOption[] = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];

export function MembersTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const membersQ = useMembers(projectId);
  const invite = useInviteMember(projectId);
  const remove = useRemoveMember(projectId);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");

  function send() {
    const trimmed = email.trim();
    if (!trimmed) return;
    invite.mutate({ email: trimmed, role }, { onSuccess: () => setEmail("") });
  }

  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-4">Members</h2>

        {membersQ.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-3/4 rounded-md" />
          </div>
        ) : membersQ.isError ? (
          <ErrorState message={formatApiError(membersQ.error)} onRetry={() => membersQ.refetch()} />
        ) : (
          <ul className="space-y-1.5">
            {(membersQ.data ?? []).map((m) => (
              <li
                key={m.userId}
                className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2"
              >
                <span className="min-w-0 truncate text-fg">{m.email}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{m.role}</Badge>
                  {canEdit && m.role !== "owner" && (
                    <IconButton
                      icon="trash"
                      aria-label={`Remove ${m.email}`}
                      onClick={() => remove.mutate(m.userId)}
                      disabled={remove.isPending}
                    />
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <div className="mt-4 space-y-3 border-t border-line pt-4">
            <h3 className="fg-label text-fg">Invite a member</h3>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Field label="Email">
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="teammate@example.com"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") send();
                    }}
                  />
                </Field>
              </div>
              <div className="sm:w-40">
                <Field label="Role">
                  <Select
                    options={ROLE_OPTIONS}
                    value={role}
                    onChange={(v) => setRole(v as "admin" | "member")}
                  />
                </Field>
              </div>
              <Button
                variant="primary"
                icon="mail"
                loading={invite.isPending}
                disabled={email.trim() === ""}
                onClick={send}
                className="min-h-11"
              >
                Invite
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
