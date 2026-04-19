'use client';

import { Button, Input, Label } from '@/components/ui';

interface CoolifySectionProps {
  coolifyResources: { name: string; uuid: string }[];
  updateResource: (index: number, field: 'name' | 'uuid', value: string) => void;
  removeResource: (index: number) => void;
  addResource: () => void;
}

export function CoolifySection({
  coolifyResources,
  updateResource,
  removeResource,
  addResource,
}: CoolifySectionProps) {
  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">07. Coolify Resources</h2>
        <span className="text-[9px] font-mono text-outline">CLF_EXT_07</span>
      </div>
      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
      <p className="text-[10px] text-outline">
        URL and API key are configured via environment variables (COOLIFY_URL, COOLIFY_API_KEY).
      </p>
      <div className="space-y-4">
        <div>
          <Label>Resources</Label>
          <div className="space-y-2">
            {coolifyResources.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  type="text"
                  value={r.name}
                  onChange={(e) => updateResource(i, 'name', e.target.value)}
                  placeholder="Name (e.g. web, api)"
                  className="w-1/3"
                />
                <Input
                  type="text"
                  value={r.uuid}
                  onChange={(e) => updateResource(i, 'uuid', e.target.value)}
                  placeholder="UUID"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => removeResource(i)}
                  className="text-danger hover:bg-danger-surface"
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={addResource}
              className="border-dashed"
            >
              + Add Resource
            </Button>
          </div>
        </div>
      </div>
      </div>
    </section>
  );
}
