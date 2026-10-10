
import { useRouter } from "@/lib/navigation/router";
import { HealthDot, ProjectMark, Stat, TBody, TD, TH, THead, TR, Table } from '@/design';
import { useCopy } from '@/lib/i18n/interface-language';
import { formatRelativeTime, formatSpend } from '../derive';
import { projectGlyph, projectInitials } from '../glyph';
import type { ProjectConsoleItem } from '../types';
import { LiveCount } from './live-count';
import { MemberStack } from './member-stack';
import { PinStar } from './project-card';

interface ProjectListProps {
  items: ProjectConsoleItem[];
  now: number;
  onTogglePin: (id: string) => void;
}

export function ProjectList({ items, now, onTogglePin }: ProjectListProps) {
  const router = useRouter();
  const t = useCopy();
  return (
    <Table>
      <THead>
        <TR className="hover:bg-transparent">
          <TH className="w-px" />
          <TH>{t('projects.col.project')}</TH>
          <TH>{t('projects.col.health')}</TH>
          <TH>{t('projects.col.runs')}</TH>
          <TH>{t('projects.col.issues')}</TH>
          <TH>{t('projects.col.runners')}</TH>
          <TH className="text-right">{t('projects.col.spend')}</TH>
          <TH className="text-right">{t('projects.col.team')}</TH>
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
                  <span className="truncate font-mono text-13-5 font-semibold text-fg">{p.name}</span>
                  <PinStar pinned={p.pinned} size={12} onToggle={() => onTogglePin(p.id)} />
                </span>
              </TD>
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
              <TD className="text-right font-mono text-12 text-subtle">
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
