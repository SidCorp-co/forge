"use client";

import { Banner, Button, Field, Input } from "@/design";
import { formatApiError } from "@/lib/api/error";
import type { AgentPathKind } from "@forge/contracts/integrations";
import { type ReactNode, useState } from "react";
import {
  AGENT_ACCESS_CLOSED,
  AgentAccessChoice,
  agentAccessBody,
  mayWriteAgentAccess,
} from "../components/agent-access-control";
import { ConnectionOwnerField } from "../components/connection-owner-field";
import { useCreateProviderIntegration, useIsOrgAdmin } from "../hooks";
import type { AgentAccess } from "../types";

const LABEL_REGEX = /^[a-z0-9][a-z0-9-]*$/;

/** A kebab-case label, or the reason it is not one. */
export function labelError(label: string, message: string): string | null {
  return label && !LABEL_REGEX.test(label) ? message : null;
}

type CreateBody = Parameters<ReturnType<typeof useCreateProviderIntegration>["mutateAsync"]>[0];

/** A connect form's shared state: the owner org, the agent grant, and the create call's error. */
export function useAddBinding(projectId: string, pathKind: AgentPathKind) {
  const create = useCreateProviderIntegration(projectId);
  const isOrgAdmin = useIsOrgAdmin(projectId);
  const [ownerOrgId, setOwnerOrgId] = useState<string | undefined>(undefined);
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(AGENT_ACCESS_CLOSED);
  const [error, setError] = useState<string | null>(null);

  async function submit(body: Omit<CreateBody, "agentAccess" | "orgId">, onDone?: () => void) {
    setError(null);
    try {
      await create.mutateAsync({
        ...body,
        ...agentAccessBody(pathKind, agentAccess),
        ...(ownerOrgId ? { orgId: ownerOrgId } : {}),
      });
      onDone?.();
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  return {
    projectId,
    pathKind,
    isOrgAdmin,
    ownerOrgId,
    setOwnerOrgId,
    agentAccess,
    setAgentAccess,
    error,
    setError,
    submit,
    pending: create.isPending,
  };
}

/** A connect form's frame: title, owner org, the provider's fields, the agent grant, then submit. */
export function AddBindingForm({
  add,
  title,
  intro,
  submitLabel,
  canSubmit,
  onSubmit,
  onCancel,
  children,
}: {
  add: ReturnType<typeof useAddBinding>;
  title: string;
  intro?: ReactNode;
  submitLabel: string;
  canSubmit: boolean;
  onSubmit: () => void;
  onCancel?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <span className="fg-label font-semibold">{title}</span>
      {intro}
      <ConnectionOwnerField projectId={add.projectId} value={add.ownerOrgId} onChange={add.setOwnerOrgId} />
      {children}
      <AgentAccessChoice
        value={add.agentAccess}
        onChange={add.setAgentAccess}
        pathKind={add.pathKind}
        canEdit={mayWriteAgentAccess(add.pathKind, { canEditProject: true, isOrgAdmin: add.isOrgAdmin })}
      />
      {add.error && <Banner tone="danger">{add.error}</Banner>}
      <div className="flex gap-2">
        <Button variant="primary" onClick={onSubmit} loading={add.pending} disabled={!canSubmit}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

/** The kebab-case label an extra binding of a provider needs. */
export function LabelField({
  hint,
  placeholder,
  value,
  onChange,
  error,
}: {
  hint: string;
  placeholder: string;
  value: string;
  onChange: (label: string) => void;
  error: string | null;
}) {
  return (
    <Field label="Label" hint={hint} required>
      <Input placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value.toLowerCase())} />
      {error && <p className="fg-body-sm text-danger">{error}</p>}
    </Field>
  );
}
