
import { useRouter } from "@/lib/navigation/router";
import { HealthDot, ProjectMark, RowItem, RowList, Stat, TBody, TD, TH, THead, TR, Table, useMediaQuery } from '@/design';
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
  /** Whether the Spend column says anything: not while every cost is $0 (ISS-1069). */
  spend: boolean;
  onTogglePin: (id: string) => void;
}

/** At phone width the table's eight columns wrapped each cell letter by letter: a phone reads the
 *  shared row list, each project led by its name with its counts on one line (ISS-1072). */
export function ProjectList(props: ProjectListProps) {
  const phone = useMediaQuery('(max-width: 639.98px)');
  return phone ? <ProjectRows {...props} /> : <ProjectTable {...props} />;
}

/** A row is one link to its project, so it carries no pin button inside it; the Cards view pins. */
function ProjectRows({ items, spend }: ProjectListProps) {
  const t = useCopy();
  return (
    <RowList testId="projects-rows" label={t('projects.all')}>
      {items.map((p) => {
        const glyph = projectGlyph(p.id);
        return (
          <RowItem
            key={p.id}
            href={`/projects/${p.slug}`}
            lead={<ProjectMark tint={glyph.tint} ink={glyph.ink} initials={projectInitials(p.name)} size={28} radius="var(--r-sm)" />}
            title={p.name}
            facts={[
              ...(p.liveRuns > 0 ? [t('projects.liveRuns', { n: p.liveRuns })] : []),
              t('projects.activeCount', { n: p.openIssues }),
              ...(spend ? [formatSpend(p.spend24hUsd)] : []),
            ]}
            trailing={<HealthDot health={p.health} />}
          />
        );
      })}
    </RowList>
  );
}

function ProjectTable({ items, now, spend, onTogglePin }: ProjectListProps) {
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
          {/* every column drawn has its heading: the spend only while a cost is not $0, the last move always (ISS-1072) */}
          {spend ? <TH className="text-right">{t('projects.col.spend')}</TH> : null}
          <TH className="text-right">{t('projects.col.active')}</TH>
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
              {spend ? <TD className="text-right font-mono text-12 text-subtle">{formatSpend(p.spend24hUsd)}</TD> : null}
              <TD className="whitespace-nowrap text-right font-mono text-12 text-subtle">{formatRelativeTime(p.lastActivityAt, now)}</TD>
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
