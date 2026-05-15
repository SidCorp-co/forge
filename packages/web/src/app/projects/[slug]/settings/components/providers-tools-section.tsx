'use client';

import { Input, Label } from '@/components/ui';
import { useProvidersForm } from '../hooks/use-providers-form';
import { useFocusOnMount } from '../hooks/use-focus-on-mount';
import { SectionSaveBar } from './section-save-bar';

interface Props {
  projectId: string;
  previewMode?: boolean;
}

export function ProvidersToolsSection({ projectId, previewMode = false }: Props) {
  const form = useProvidersForm(previewMode ? undefined : projectId);
  useFocusOnMount();

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
          Chat Provider
        </h2>
        <span className="text-[9px] font-mono text-outline">AGT_PRV</span>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <div>
            <Label>Provider ID</Label>
            <div data-config-health-target="providers.chatProviderId">
              <Input
                type="text"
                value={form.state.chatProviderId}
                onChange={(e) => form.setField('chatProviderId', e.target.value)}
                placeholder="anthropic"
                className="font-mono"
                disabled={previewMode}
              />
            </div>
            <p className="mt-2 text-[10px] text-outline">
              Provider key registered in <code className="font-mono">packages/core</code> chat
              registry. Empty value falls back to platform default.
            </p>
          </div>
          <div>
            <Label>Model ID</Label>
            <div data-config-health-target="providers.chatModel">
              <Input
                type="text"
                value={form.state.chatModel}
                onChange={(e) => form.setField('chatModel', e.target.value)}
                placeholder="claude-opus-4-7"
                className="font-mono"
                disabled={previewMode}
              />
            </div>
            <p className="mt-2 text-[10px] text-outline">
              Model identifier for the selected provider.
            </p>
          </div>
        </div>

        {!previewMode && (
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
