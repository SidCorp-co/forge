'use client';

import { useProjectHealth } from '../hooks/use-project-health';
import { CrossProjectHealth } from './cross-project-health';
import { AlertTriangle, Crown, TrendingUp } from 'lucide-react';

export function CeoBriefing() {
  const { data: projects } = useProjectHealth();

  const totalBlockers = projects?.reduce((sum, p) => sum + p.blockers.length, 0) ?? 0;
  const totalEscalations = projects?.reduce((sum, p) => sum + p.pendingEscalations, 0) ?? 0;
  const totalThroughput = projects?.reduce((sum, p) => sum + p.throughput, 0) ?? 0;

  return (
    <div className="space-y-6">
      {/* CEO summary header */}
      <div className="flex items-center gap-3">
        <Crown className="h-5 w-5 text-amber-500" />
        <h2 className="text-lg font-semibold text-on-surface">CEO Briefing</h2>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-outline-variant bg-surface p-3 text-center">
          <div className="flex items-center justify-center gap-1 text-xs text-on-surface-variant">
            <TrendingUp className="h-3 w-3" />
            <span>Org Throughput</span>
          </div>
          <div className="text-xl font-bold text-on-surface">{totalThroughput}/wk</div>
        </div>
        <div className="rounded-lg border border-outline-variant bg-surface p-3 text-center">
          <div className="text-xs text-on-surface-variant">Blockers</div>
          <div className={`text-xl font-bold ${totalBlockers > 0 ? 'text-red-500' : 'text-on-surface'}`}>
            {totalBlockers}
          </div>
        </div>
        <div className="rounded-lg border border-outline-variant bg-surface p-3 text-center">
          <div className="text-xs text-on-surface-variant">Escalations</div>
          <div className={`text-xl font-bold ${totalEscalations > 0 ? 'text-yellow-600' : 'text-on-surface'}`}>
            {totalEscalations}
          </div>
        </div>
      </div>

      {totalBlockers > 0 && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 flex items-center gap-2 text-sm text-red-500">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          {totalBlockers} blocker{totalBlockers > 1 ? 's' : ''} across projects need attention
        </div>
      )}

      {/* Detailed health */}
      <CrossProjectHealth />
    </div>
  );
}
