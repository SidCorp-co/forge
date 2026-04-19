'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { ALL_STATUSES, ALL_PRIORITIES, ALL_CATEGORIES } from '@/lib/constants';
import type { Issue } from '@/features/issue/types';

interface BulkActionBarProps {
    count: number;
    onApply: (data: Partial<Issue>) => void;
    onClear: () => void;
}

export function BulkActionBar({ count, onApply, onClear }: BulkActionBarProps) {
    const [status, setStatus] = useState('');
    const [priority, setPriority] = useState('');
    const [category, setCategory] = useState('');
    const [manualHold, setManualHold] = useState(''); // '' | 'true' | 'false'

    function handleApply() {
        const fields: { key: keyof Issue; value: string; list: { value: string; label: string }[]; label: string }[] = [
            { key: 'status', value: status, list: ALL_STATUSES, label: 'Status' },
            { key: 'priority', value: priority, list: ALL_PRIORITIES, label: 'Priority' },
            { key: 'category', value: category, list: ALL_CATEGORIES, label: 'Category' },
        ];

        const active = fields.filter((f) => f.value);
        const holdChanged = manualHold !== '';
        if (active.length === 0 && !holdChanged) return;

        const changes: Partial<Issue> = {};
        const parts: string[] = [];
        for (const f of active) {
            (changes as Record<string, string>)[f.key] = f.value;
            parts.push(`${f.label} → ${f.list.find((o) => o.value === f.value)?.label}`);
        }
        if (holdChanged) {
            changes.manualHold = manualHold === 'true';
            parts.push(`Hold → ${manualHold === 'true' ? 'On hold' : 'Released'}`);
        }

        if (!window.confirm(`Update ${count} issue${count !== 1 ? 's' : ''}?\n\n${parts.join('\n')}`)) return;

        onApply(changes);
        setStatus('');
        setPriority('');
        setCategory('');
        setManualHold('');
    }

    return (
        <div className="sticky bottom-4 z-10 mx-auto mt-3 flex w-fit items-center gap-2 rounded-sm border border-outline-variant/30 bg-surface-container-low px-4 py-2.5 shadow-[0_10px_30px_rgba(13,14,15,0.5)] backdrop-blur-sm">
            <span className="text-sm font-medium text-primary">{count} selected</span>
            <div className="mx-1 h-5 w-px bg-outline-variant" />

            <Select value={status} onChange={(e) => setStatus(e.currentTarget.value)} className="py-1.5 text-xs">
                <option value="">Status...</option>
                {ALL_STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                ))}
            </Select>

            <Select value={priority} onChange={(e) => setPriority(e.currentTarget.value)} className="py-1.5 text-xs">
                <option value="">Priority...</option>
                {ALL_PRIORITIES.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                ))}
            </Select>

            <Select value={category} onChange={(e) => setCategory(e.currentTarget.value)} className="py-1.5 text-xs">
                <option value="">Category...</option>
                {ALL_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                ))}
            </Select>

            <Select value={manualHold} onChange={(e) => setManualHold(e.currentTarget.value)} className="py-1.5 text-xs">
                <option value="">Hold...</option>
                <option value="true">🔴 Set on hold</option>
                <option value="false">✅ Release hold</option>
            </Select>

            <button
                onClick={handleApply}
                disabled={!status && !priority && !category && !manualHold}
                className="rounded-sm bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:bg-tertiary disabled:opacity-30 transition-colors"
            >
                Apply
            </button>

            <button onClick={onClear} className="rounded-sm p-1.5 text-outline hover:bg-surface-container-high hover:text-on-surface transition-colors">
                <X className="h-3.5 w-3.5" />
            </button>
        </div>
    );
}
