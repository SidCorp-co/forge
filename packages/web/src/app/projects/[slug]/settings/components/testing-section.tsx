'use client';

import { useState } from 'react';
import { Button, Input, Label } from '@/components/ui';
import { useTestingForm } from '../hooks/use-testing-form';
import { SectionSaveBar } from './section-save-bar';

interface Props {
  projectId: string;
  isOwner: boolean;
}

export function TestingSection({ projectId, isOwner }: Props) {
  const form = useTestingForm(projectId);
  const [revealedPasswords, setRevealedPasswords] = useState<Set<number>>(new Set());

  const togglePassword = (i: number) => {
    setRevealedPasswords((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const disabled = !isOwner;

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
          Testing
        </h2>
        <span className="text-[9px] font-mono text-outline">PLC_TST</span>
      </div>

      {!isOwner && (
        <div className="rounded-sm border border-outline-variant/30 bg-surface-container-low p-3 text-[10px] text-on-surface-variant">
          Only the project owner can edit testing config. Values shown read-only.
        </div>
      )}

      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-10">
        <p className="text-[10px] text-outline">
          URLs and credentials surfaced to QA flows (forge-test). Stored on the project — visible to
          all members; treat as low-secrecy test accounts only.
        </p>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>Testing URLs</Label>
            <span className="text-[9px] text-outline font-mono">
              {form.state.testingUrls.length} / 50
            </span>
          </div>
          <div className="space-y-2">
            {form.state.testingUrls.length === 0 && (
              <p className="text-[10px] text-outline italic">No URLs configured.</p>
            )}
            {form.state.testingUrls.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  type="text"
                  value={row.label}
                  onChange={(e) => form.updateUrl(i, 'label', e.target.value)}
                  placeholder="Label (e.g. Staging, Preview)"
                  className="w-1/3"
                  disabled={disabled}
                />
                <Input
                  type="url"
                  value={row.url}
                  onChange={(e) => form.updateUrl(i, 'url', e.target.value)}
                  placeholder="https://staging.example.com"
                  className="flex-1 font-mono"
                  disabled={disabled}
                />
                {row.url && (
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] uppercase tracking-[0.15em] text-primary hover:underline shrink-0"
                  >
                    Open
                  </a>
                )}
                {!disabled && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => form.removeUrl(i)}
                    className="text-danger hover:bg-danger-surface"
                  >
                    Remove
                  </Button>
                )}
              </div>
            ))}
            {!disabled && form.state.testingUrls.length < 50 && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={form.addUrl}
                className="border-dashed"
              >
                + Add URL
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>Test Credentials</Label>
            <span className="text-[9px] text-outline font-mono">
              {form.state.testCredentials.length} / 50
            </span>
          </div>
          <div className="space-y-2">
            {form.state.testCredentials.length === 0 && (
              <p className="text-[10px] text-outline italic">No credentials configured.</p>
            )}
            {form.state.testCredentials.map((row, i) => {
              const revealed = revealedPasswords.has(i);
              return (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    type="text"
                    value={row.label}
                    onChange={(e) => form.updateCredential(i, 'label', e.target.value)}
                    placeholder="Label (e.g. Admin, Customer)"
                    className="w-1/4"
                    disabled={disabled}
                  />
                  <Input
                    type="text"
                    value={row.username}
                    onChange={(e) => form.updateCredential(i, 'username', e.target.value)}
                    placeholder="username or email"
                    className="flex-1 font-mono"
                    autoComplete="off"
                    disabled={disabled}
                  />
                  <Input
                    type={revealed ? 'text' : 'password'}
                    value={row.password}
                    onChange={(e) => form.updateCredential(i, 'password', e.target.value)}
                    placeholder="password"
                    className="flex-1 font-mono"
                    autoComplete="off"
                    disabled={disabled}
                  />
                  <button
                    type="button"
                    onClick={() => togglePassword(i)}
                    className="text-[10px] uppercase tracking-[0.15em] text-on-surface-variant hover:text-on-surface shrink-0"
                  >
                    {revealed ? 'Hide' : 'Show'}
                  </button>
                  {!disabled && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => form.removeCredential(i)}
                      className="text-danger hover:bg-danger-surface"
                    >
                      Remove
                    </Button>
                  )}
                </div>
              );
            })}
            {!disabled && form.state.testCredentials.length < 50 && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={form.addCredential}
                className="border-dashed"
              >
                + Add Credential
              </Button>
            )}
          </div>
        </div>

        {!disabled && (
          <SectionSaveBar
            isDirty={form.isDirty}
            isSubmitting={form.isSubmitting}
            isError={form.isError}
            isSuccess={form.isSuccess}
            onSave={() => void form.save()}
            onDiscard={form.reset}
          />
        )}
      </div>
    </section>
  );
}
