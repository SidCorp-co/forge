'use client';

import { Input } from '@/components/ui';
import type { RecoveryByKind } from '../types';

interface Props {
  maxAttempts: number;
  windowHours: number;
  byKind: { transient: number; permanent: number; unknown: number };
  onMaxAttemptsChange: (n: number) => void;
  onWindowHoursChange: (n: number) => void;
  onByKindChange: (kind: keyof RecoveryByKind, n: number) => void;
}

export function RecoveryPolicyCard({
  maxAttempts,
  windowHours,
  byKind,
  onMaxAttemptsChange,
  onWindowHoursChange,
  onByKindChange,
}: Props) {
  return (
    <div className="bg-surface-container-low border border-outline-variant/30 p-6 space-y-5">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-on-surface">Recovery policy</h3>
        <p className="text-xs text-on-surface-variant">
          The pipeline sweeper retries stalled issues using these caps. Permanent failures (auth,
          content filter) bypass the budget and are never retried.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <NumberField
          label="Max retries per window"
          help="Default fallback when no per-kind cap is set"
          value={maxAttempts}
          min={0}
          max={20}
          onChange={onMaxAttemptsChange}
        />
        <NumberField
          label="Recovery window (hours)"
          help="Attempts auto-reset after this elapses"
          value={windowHours}
          min={1}
          max={168}
          onChange={onWindowHoursChange}
        />
      </div>

      <div className="border-t border-outline-variant/20 pt-4 space-y-3">
        <div className="space-y-0.5">
          <h4 className="text-xs font-medium text-on-surface uppercase tracking-wider">
            Per-failure-kind caps
          </h4>
          <p className="text-[11px] text-on-surface-variant">
            Override the max for specific failure kinds. Permanent should usually stay at 0.
          </p>
        </div>
        <div className="grid sm:grid-cols-3 gap-4">
          <NumberField
            label="Transient"
            help="Network/timeout/5xx — generous"
            value={byKind.transient}
            min={0}
            max={20}
            onChange={(n) => onByKindChange('transient', n)}
          />
          <NumberField
            label="Unknown"
            help="Unclassified — cautious"
            value={byKind.unknown}
            min={0}
            max={20}
            onChange={(n) => onByKindChange('unknown', n)}
          />
          <NumberField
            label="Permanent"
            help="Auth/content-filter — escalate"
            value={byKind.permanent}
            min={0}
            max={20}
            onChange={(n) => onByKindChange('permanent', n)}
          />
        </div>
      </div>
    </div>
  );
}

function NumberField({
  label,
  help,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  help: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="space-y-1 block">
      <span className="text-xs font-medium text-on-surface block">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isNaN(n)) return;
          onChange(Math.max(min, Math.min(max, n)));
        }}
        className="h-9"
      />
      <span className="text-[10px] text-on-surface-variant block">{help}</span>
    </label>
  );
}
