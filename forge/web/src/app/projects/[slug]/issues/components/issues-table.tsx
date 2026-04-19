'use client';

import { Play, Loader2, Eye, PauseCircle } from 'lucide-react';
import { Checkbox, AgentRunningDot } from '@/components/ui';
import { InlineStatusSelect } from '@/components/issue/inline-status-select';
import { InlinePrioritySelect } from '@/components/issue/inline-priority-select';
import { InlineComplexitySelect } from '@/components/issue/inline-complexity-select';
import { LabelBadge } from '@/components/issue/label-badge';
import { PokemonSprite } from '@/components/ui/pokemon-sprite';
import { getPokemonSprite, getPokemonChain, getPokemonName } from '@/lib/constants/pipeline-pokemon';
import { cn } from '@/lib/utils/cn';
import { relativeTime } from '@/lib/utils/relative-time';
import { IssuesPagination } from './issues-pagination';
import { useIssueCost } from '@/features/issue/hooks/use-issue-cost';
import type { Issue } from '@/features/issue/types';

function CostCell({ documentId }: { documentId: string }) {
    const { data } = useIssueCost(documentId);
    if (!data || data.sessionCount === 0) return <span className="text-surface-variant">-</span>;
    return <span className="font-mono">${data.totalCost.toFixed(2)}</span>;
}

interface IssuesTableProps {
    paginated: Issue[];
    total: number;
    checked: Set<string>;
    pageCount: number;
    safePage: number;
    slug: string;
    desktopConnected: boolean;
    isBuildingPrompt: boolean;
    onToggleCheck: (docId: string) => void;
    onSelectAll: () => void;
    onSelectIssue: (id: string) => void;
    onPreviewIssue: (id: string) => void;
    onUpdate: (id: string, data: Partial<Issue>) => void;
    onStartSingle: (docId: string) => void;
    setParam: (key: string, value: string) => void;
}

export function IssuesTable({
    paginated,
    total,
    checked,
    pageCount,
    safePage,
    desktopConnected,
    isBuildingPrompt,
    onToggleCheck,
    onSelectAll,
    onSelectIssue,
    onPreviewIssue,
    onUpdate,
    onStartSingle,
    setParam,
}: IssuesTableProps) {
    const allChecked = paginated.length > 0 && paginated.every((i) => checked.has(i.documentId));

    return (
        <div className="overflow-x-auto rounded-sm border border-outline-variant/20 bg-surface">
            <table className="w-full text-sm">
                <thead>
                    <tr className="border-b border-surface-container-high text-left text-[10px] font-medium uppercase tracking-widest text-primary-fixed">
                        <th className="px-3 py-3 w-10">
                            <Checkbox
                                aria-label="Select all issues on this page"
                                checked={allChecked}
                                onChange={onSelectAll}
                                className="h-3.5 w-3.5"
                            />
                        </th>
                        <th className="hidden px-3 py-3 w-20 sm:table-cell">ID</th>
                        <th className="px-3 py-3 sm:px-4">Title</th>
                        <th className="hidden px-3 py-3 w-36 sm:table-cell sm:px-4">Status</th>
                        <th className="hidden px-4 py-3 w-28 md:table-cell">Complexity</th>
                        <th className="hidden px-4 py-3 w-32 md:table-cell">Priority</th>
                        <th className="hidden px-4 py-3 w-28 lg:table-cell">Category</th>
                        <th className="hidden px-4 py-3 w-20 xl:table-cell">Cost</th>
                        <th className="hidden px-4 py-3 w-16 lg:table-cell">Hold</th>
                        <th className="hidden px-4 py-3 w-28 lg:table-cell">Updated</th>
                        <th className="px-3 py-3 w-16 sm:w-20 sm:px-4"></th>
                    </tr>
                </thead>
                <tbody>
                    {paginated.map((issue) => (
                        <tr
                            key={issue.id}
                            className={cn(
                                'cursor-pointer border-b border-surface-container-low transition-colors hover:bg-surface-container-low',
                                checked.has(issue.documentId) && 'bg-on-surface/[0.03]'
                            )}
                            tabIndex={0}
                            onClick={() => onSelectIssue(issue.documentId)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    onSelectIssue(issue.documentId);
                                }
                            }}
                        >
                            <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                                <Checkbox
                                    aria-label={`Select issue ISS-${issue.id}`}
                                    checked={checked.has(issue.documentId)}
                                    onChange={() => onToggleCheck(issue.documentId)}
                                    className="h-3.5 w-3.5"
                                />
                            </td>
                            <td className="hidden px-3 py-3 sm:table-cell">
                                <span className="font-mono text-xs text-primary-fixed">ISS-{issue.id}</span>
                            </td>
                            <td className="px-3 py-3 sm:px-4">
                                <div className="font-medium text-on-surface line-clamp-2 sm:line-clamp-1">
                                    <span className="mr-1.5 font-mono text-xs text-primary-fixed sm:hidden">ISS-{issue.id}</span>
                                    {issue.title}
                                </div>
                                {issue.labels && issue.labels.length > 0 && (
                                    <span className="ml-1 inline-flex gap-1">
                                        {issue.labels.map((l) => (
                                            <LabelBadge key={l.id} name={l.name} color={l.color} size="sm" />
                                        ))}
                                    </span>
                                )}
                                {(() => {
                                    const activeSession = issue.agentSessions?.find(s => s.status === 'running')
                                        || issue.agentSessions?.find(s => s.status === 'queued');
                                    if (!activeSession && (!issue.agentStatus || issue.agentStatus === 'idle')) return null;
                                    const sessionStatus = (activeSession?.status || issue.agentStatus) as 'queued' | 'running' | 'completed' | 'failed' | 'idle';
                                    const step = activeSession?.metadata?.skill
                                        || (activeSession?.title?.includes(':') ? activeSession.title.split(':')[0].trim() : null);
                                    const sprite = step ? getPokemonSprite(step) : null;
                                    const chain = step ? getPokemonChain(step) : null;
                                    const pokeName = step ? getPokemonName(step) : null;
                                    return (
                                        <span className="inline-flex items-center gap-1 text-[10px] text-secondary-dim">
                                            {sprite && chain && pokeName && step ? (
                                                <PokemonSprite
                                                    status={sessionStatus}
                                                    sprite={sprite}
                                                    chain={chain}
                                                    name={pokeName}
                                                    skill={step}
                                                    className="h-5 w-5"
                                                />
                                            ) : (
                                                sessionStatus === 'running' && <AgentRunningDot size="sm" />
                                            )}
                                            <span>{sessionStatus}</span>
                                            {step && <span className="opacity-75 tracking-wider italic">({step})</span>}
                                        </span>
                                    );
                                })()}
                                <div className="mt-1 flex flex-wrap items-center gap-1.5 sm:hidden">
                                    <InlineStatusSelect issue={issue} onUpdate={onUpdate} />
                                    <InlineComplexitySelect issue={issue} onUpdate={onUpdate} />
                                    <InlinePrioritySelect issue={issue} onUpdate={onUpdate} />
                                </div>
                            </td>
                            <td className="hidden px-3 py-3 sm:table-cell sm:px-4">
                                <InlineStatusSelect issue={issue} onUpdate={onUpdate} />
                            </td>
                            <td className="hidden px-4 py-3 md:table-cell">
                                <InlineComplexitySelect issue={issue} onUpdate={onUpdate} />
                            </td>
                            <td className="hidden px-4 py-3 md:table-cell">
                                <InlinePrioritySelect issue={issue} onUpdate={onUpdate} />
                            </td>
                            <td className="hidden px-4 py-3 text-xs text-outline lg:table-cell">
                                {issue.category || <span className="text-surface-variant">-</span>}
                            </td>
                            <td className="hidden px-4 py-3 text-xs text-on-surface xl:table-cell">
                                <CostCell documentId={issue.documentId} />
                            </td>
                            <td className="hidden px-4 py-3 lg:table-cell" onClick={(e) => e.stopPropagation()}>
                                <button
                                    title={issue.manualHold ? 'Release hold' : 'Set manual hold'}
                                    onClick={() => onUpdate(issue.documentId, { manualHold: !issue.manualHold })}
                                    className={cn(
                                        'rounded-sm p-1 transition-colors',
                                        issue.manualHold
                                            ? 'text-amber-500 hover:text-amber-600 hover:bg-amber-500/10'
                                            : 'text-surface-variant hover:text-outline hover:bg-surface-container-high'
                                    )}
                                >
                                    <PauseCircle className="h-3.5 w-3.5" />
                                </button>
                            </td>
                            <td className="hidden px-4 py-3 text-xs text-primary-fixed lg:table-cell">
                                {relativeTime(issue.updatedAt)}
                            </td>
                            <td className="px-4 py-3">
                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onPreviewIssue(issue.documentId); }}
                                        className="rounded-sm p-1 text-primary-fixed hover:bg-surface-container-high hover:text-on-surface transition-colors"
                                        title="Quick preview"
                                    >
                                        <Eye className="h-3.5 w-3.5" />
                                    </button>
                                    {desktopConnected && issue.status !== 'released' && issue.status !== 'closed' ? (
                                        <button
                                            onClick={(e) => { e.stopPropagation(); onStartSingle(issue.documentId); }}
                                            disabled={isBuildingPrompt}
                                            className="flex items-center gap-1 rounded-sm bg-primary px-2 py-1 text-xs font-medium text-on-primary hover:bg-tertiary disabled:opacity-50 transition-colors"
                                        >
                                            {isBuildingPrompt ? (
                                                <Loader2 className="h-3 w-3 animate-spin" />
                                            ) : (
                                                <Play className="h-3 w-3" />
                                            )}
                                            Start
                                        </button>
                                    ) : null}
                                </div>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <IssuesPagination
                total={total}
                pageCount={pageCount}
                safePage={safePage}
                setParam={setParam}
            />
        </div>
    );
}
