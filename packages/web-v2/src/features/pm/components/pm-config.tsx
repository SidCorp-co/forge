"use client";

// PM Config tab: enable/disable the PM agent, cadence cron, event triggers,
// custom instructions, model override, and max runs/hour. PUT on save.
import { useEffect, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  Checkbox,
  ErrorState,
  Field,
  Input,
  ProjectLoader,
  Textarea,
  Toggle,
} from "@/design";
import { usePmConfig, useUpdatePmConfig } from "../hooks";
import type { PmEventTriggers } from "../types";

const TRIGGER_LABELS: Record<keyof PmEventTriggers, string> = {
  jobFailed: "Job failed",
  pipelineStalled: "Pipeline stalled",
  needsInfo: "Needs info",
  queuePressure: "Queue pressure",
  graphChanged: "Dependency graph changed",
};

export function PmConfig({ projectId }: { projectId: string }) {
  const q = usePmConfig(projectId);
  const update = useUpdatePmConfig(projectId);

  const [enabled, setEnabled] = useState(false);
  const [cadenceCron, setCadenceCron] = useState("");
  const [triggers, setTriggers] = useState<PmEventTriggers>({
    jobFailed: true,
    pipelineStalled: true,
    needsInfo: true,
    queuePressure: true,
    graphChanged: true,
  });
  const [customInstructions, setCustomInstructions] = useState("");
  const [modelOverride, setModelOverride] = useState("");
  const [maxRunsPerHour, setMaxRunsPerHour] = useState("6");

  // Seed local form state once the config loads.
  useEffect(() => {
    const c = q.data;
    if (!c) return;
    setEnabled(c.enabled);
    setCadenceCron(c.cadenceCron ?? "");
    setTriggers(c.eventTriggers);
    setCustomInstructions(c.customInstructions ?? "");
    setModelOverride(c.modelOverride ?? "");
    setMaxRunsPerHour(String(c.maxRunsPerHour));
  }, [q.data]);

  if (q.isLoading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <ProjectLoader label="loading PM config…" />
      </div>
    );
  }
  if (q.isError) {
    return (
      <ErrorState
        title="Couldn't load PM config"
        message="We couldn't reach the PM service. Retry in a moment."
        onRetry={() => q.refetch()}
      />
    );
  }

  function save() {
    update.mutate({
      enabled,
      cadenceCron: cadenceCron.trim() || null,
      eventTriggers: triggers,
      customInstructions: customInstructions.trim() || null,
      modelOverride: modelOverride.trim() || null,
      maxRunsPerHour: Number(maxRunsPerHour) || 6,
    });
  }

  return (
    <div className="max-w-2xl space-y-5">
      <Card>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="fg-label">PM agent</p>
              <p className="fg-caption mt-1">Autonomously triage, prioritise, and dispatch work.</p>
            </div>
            <Toggle checked={enabled} aria-label="Enable PM agent" onChange={setEnabled} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4">
          <Field label="Cadence (cron)" hint="Blank disables scheduled runs; event triggers still fire.">
            <Input
              value={cadenceCron}
              onChange={(e) => setCadenceCron(e.target.value)}
              placeholder="e.g. 0 */2 * * *"
            />
          </Field>

          <div>
            <p className="fg-caption mb-2">Event triggers</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(Object.keys(TRIGGER_LABELS) as (keyof PmEventTriggers)[]).map((key) => (
                <Checkbox
                  key={key}
                  checked={triggers[key]}
                  onChange={(checked) => setTriggers((t) => ({ ...t, [key]: checked }))}
                  label={TRIGGER_LABELS[key]}
                />
              ))}
            </div>
          </div>

          <Field label="Custom instructions" hint="Extra guidance appended to the PM agent's prompt.">
            <Textarea
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
              rows={4}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Model override" hint="Blank = project default.">
              <Input
                value={modelOverride}
                onChange={(e) => setModelOverride(e.target.value)}
                placeholder="e.g. claude-opus-4-8"
              />
            </Field>
            <Field label="Max runs / hour">
              <Input
                type="number"
                value={maxRunsPerHour}
                onChange={(e) => setMaxRunsPerHour(e.target.value)}
                min={1}
                max={60}
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button variant="primary" loading={update.isPending} onClick={save}>
          Save config
        </Button>
      </div>
    </div>
  );
}
