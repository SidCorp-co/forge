'use client';

// List view — kit Table primitives. Rows navigate into the project; the pin
// star is an inline button that doesn't trigger navigation.
import { useRouter } from 'next/navigation';
import { HealthDot, Icon, ProjectMark, Stat, TBody, TD, TH, THead, TR, Table } from '@/design';
import { formatRelativeTime, formatSpend } from '../derive';
import { projectGlyph, projectInitials } from '../glyph';
import type { ProjectConsoleItem } from '../types';
import { LiveCount } from './live-count';
import { MemberStack } from './member-stack';

export interface ProjectListProps {
  items: ProjectConsoleItem[];
  now: number;
  onTogglePin: (id: string) => void;
}

export function ProjectList({ items, now, onTogglePin }: ProjectListProps) {
  const router = useRouter();
  return (
    <Table>
      <THead>
        <TR className="hover:bg-transparent">
          <TH className="w-px" />
          <TH>Project</TH>
          <TH>Description</TH>
          <TH>Health</TH>
          <TH>Runs</TH>
          <TH>Issues</TH>
          <TH>Runners</TH>
          <TH className="text-right">Spend</TH>
          <TH className="text-right">Team</TH>
        </TR>
      </THead>
      <TBody>
        {items.map((p) => {
          const glyph = projectGlyph(p.id);
          return (
            <TR
              key={p.id}
              className="cursor-pointer"
              onClick={() => router.push(`/projects/${p.slug}`)}
            >
              <TD>
                <ProjectMark tint={glyph.tint} ink={glyph.ink} initials={projectInitials(p.name)} size={28} radius="var(--r-sm)" />
              </TD>
              <TD>
                <span className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-[13.5px] font-semibold text-fg">{p.name}</span>
                  <button
                    type="button"
                    aria-label={p.pinned ? 'Unpin project' : 'Pin project'}
                    aria-pressed={p.pinned}
                    className="flex-none rounded-sm p-0.5 text-subtle hover:text-amber"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePin(p.id);
                    }}
                  >
                    <Icon
                      name="star"
                      size={12}
                      className={p.pinned ? 'text-amber' : ''}
                      style={p.pinned ? { fill: 'currentColor' } : undefined}
                    />
                  </button>
                </span>
              </TD>
              <TD className="max-w-[1px] truncate text-muted">{p.description ?? '—'}</TD>
              <TD>
                <HealthDot health={p.health} />
              </TD>
              <TD>
                <LiveCount n={p.liveRuns} />
              </TD>
              <TD>
                <Stat icon="inbox">{p.openIssues}</Stat>
              </TD>
              <TD>
                <Stat icon="server">{p.runnerCount}</Stat>
              </TD>
              <TD className="text-right font-mono text-[12px] text-subtle">
                {formatSpend(p.spend24hUsd)}
                <span className="ml-1.5 text-disabled">{formatRelativeTime(p.lastActivityAt, now)}</span>
              </TD>
              <TD>
                <span className="flex justify-end">
                  <MemberStack members={p.members} total={p.memberCount} size={22} />
                </span>
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
