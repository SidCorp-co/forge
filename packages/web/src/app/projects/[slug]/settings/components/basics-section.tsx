'use client';

import { Input, Label, Textarea } from '@/components/ui';
import { useBasicsForm } from '../hooks/use-basics-form';
import { useFocusOnMount } from '../hooks/use-focus-on-mount';
import { SectionSaveBar } from './section-save-bar';

interface Props {
  projectId: string;
}

export function BasicsSection({ projectId }: Props) {
  const form = useBasicsForm(projectId);
  useFocusOnMount();

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
          Basics
        </h2>
        <span className="text-[9px] font-mono text-outline">IDN_BSC</span>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
        <div>
          <Label>Project Name</Label>
          <div data-config-health-target="basics.name">
            <Input
              type="text"
              value={form.state.name}
              onChange={(e) => form.setField('name', e.target.value)}
            />
          </div>
        </div>

        <div>
          <Label>Description</Label>
          <div data-config-health-target="basics.description">
            <Textarea
              value={form.state.description}
              onChange={(e) => form.setField('description', e.target.value)}
              rows={3}
            />
          </div>
        </div>

        <SectionSaveBar
          isDirty={form.isDirty}
          isSubmitting={form.isSubmitting}
          isError={form.isError}
          isSuccess={form.isSuccess}
          onSave={() => void form.save()}
          onDiscard={form.reset}
        />
      </div>
    </section>
  );
}
