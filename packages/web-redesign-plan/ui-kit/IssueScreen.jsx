/* Forge UI Kit — IssueScreen.jsx
   Full issue detail. Two paths:
     • issue.rich → renders RICH_ISSUE: markdown description, acceptance criteria,
       collapsible agent plan, lifecycle comment thread (status badges + image
       attachments), and an activity timeline.
     • otherwise → the simple sample (description + tracker + tabs). */

/* ---------- shared bits ---------- */
function PropRow({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minHeight: 24 }}>
      <span style={{ fontSize: 12.5, color: 'var(--fg-subtle)', width: 82, flex: 'none', paddingTop: 2 }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>{children}</span>
    </div>
  );
}
function DepRow({ dep, kind }) {
  const m = STATUS_META[dep.status] || STATUS_META.queued;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 'var(--r-sm)', background: 'var(--paper-50)', border: '1px solid var(--border-subtle)' }}>
      <Icon name={kind === 'blockedBy' ? 'lock' : kind === 'relates' ? 'link' : 'arrowRight'} size={13} style={{ color: 'var(--fg-subtle)' }} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-subtle)' }}>{dep.id}</span>
      <span style={{ fontSize: 12.5, color: 'var(--fg-default)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{dep.title}</span>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: m.dot, flex: 'none' }} />
    </div>
  );
}

/* ---------- rich: comment thread ---------- */
const COMMENT_KIND = {
  triage:   { label: 'Triage',            icon: 'filter',    color: 'var(--cobalt-700)', bg: 'var(--cobalt-50)' },
  plan:     { label: 'Plan',              icon: 'pipeline',  color: '#176B85',           bg: '#E5F3F6' },
  code:     { label: 'Code',              icon: 'branch',    color: 'var(--flame-700)',  bg: 'var(--flame-50)' },
  changes:  { label: 'Changes requested', icon: 'alert',     color: 'var(--red-600)',    bg: 'var(--red-50)' },
  fix:      { label: 'Fix',               icon: 'rerun',     color: 'var(--amberw-600)', bg: 'var(--amberw-50)' },
  approve:  { label: 'Approved',          icon: 'check',     color: 'var(--green-600)',  bg: 'var(--green-50)' },
  qa:       { label: 'QA · Pass',         icon: 'check',     color: 'var(--green-600)',  bg: 'var(--green-50)' },
  released: { label: 'Released',          icon: 'arrowRight',color: 'var(--green-600)',  bg: 'var(--green-50)' },
};
function RichComment({ c, last }) {
  const k = COMMENT_KIND[c.kind] || COMMENT_KIND.triage;
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 'none' }}>
        <span style={{ width: 30, height: 30, borderRadius: 'var(--r-md)', background: k.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={k.icon} size={16} style={{ color: k.color }} />
        </span>
        {!last && <span style={{ flex: 1, width: 2, background: 'var(--border-subtle)', marginTop: 4, minHeight: 12 }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg-default)' }}>{c.author}</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: k.color, background: k.bg, padding: '2px 8px', borderRadius: 'var(--r-pill)' }}>{k.label}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-subtle)', marginLeft: 'auto' }}>{c.time}</span>
        </div>
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)', padding: '13px 15px' }}>
          <Markdown text={c.body} compact />
        </div>
      </div>
    </div>
  );
}

/* ---------- rich: activity timeline ---------- */
function ActivityFeed({ items }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {items.map((a, i) => {
        let icon = 'dot', node;
        if (a.type === 'status') {
          icon = 'arrowRight';
          node = <span>Pipeline moved <code className="fg-code">{a.from}</code> → <code className="fg-code">{a.to}</code>{a.note ? <span style={{ color: 'var(--fg-subtle)' }}> · {a.note}</span> : null}</span>;
        } else if (a.type === 'attachment') {
          icon = 'monitor';
          node = <span><strong style={{ fontWeight: 600, color: 'var(--fg-default)' }}>Attachment</strong> <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{a.name}</span> · {a.size}</span>;
        } else if (a.type === 'dep') {
          icon = 'link';
          node = <span><strong style={{ fontWeight: 600, color: 'var(--fg-default)' }}>{a.kind}</strong> <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{a.to}</span><span style={{ color: 'var(--fg-subtle)' }}> — {a.reason}</span></span>;
        } else if (a.type === 'created') {
          icon = 'plus';
          node = <span><strong style={{ fontWeight: 600, color: 'var(--fg-default)' }}>{a.who}</strong> created the issue</span>;
        } else {
          icon = 'agent';
          node = <span><strong style={{ fontWeight: 600, color: 'var(--fg-default)' }}>{a.who}</strong> commented</span>;
        }
        return (
          <div key={i} style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 'none' }}>
              <span style={{ width: 24, height: 24, borderRadius: 999, background: 'var(--paper-100)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={icon} size={13} style={{ color: 'var(--fg-subtle)' }} />
              </span>
              {i < items.length - 1 && <span style={{ flex: 1, width: 2, background: 'var(--border-subtle)', marginTop: 3, minHeight: 14 }} />}
            </div>
            <div style={{ flex: 1, paddingBottom: 14, display: 'flex', gap: 10, alignItems: 'baseline' }}>
              <span style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.45, flex: 1, minWidth: 0 }}>{node}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-subtle)', flex: 'none' }}>{a.time}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- rich: collapsible plan ---------- */
function PlanSection({ plan }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      <button onClick={() => setOpen(o => !o)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
        <span style={{ width: 26, height: 26, borderRadius: 'var(--r-sm)', background: '#E5F3F6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="pipeline" size={15} style={{ color: '#176B85' }} /></span>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-default)' }}>Implementation plan</span>
        <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>· Plan agent</span>
        <Icon name="chevronDown" size={17} style={{ marginLeft: 'auto', color: 'var(--fg-subtle)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform var(--dur-base)' }} />
      </button>
      <div style={{ position: 'relative', maxHeight: open ? 'none' : 150, overflow: 'hidden', padding: '0 18px 16px' }}>
        <Markdown text={plan} compact />
        {!open && <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 70, background: 'linear-gradient(transparent, var(--bg-surface))' }} />}
      </div>
      <button onClick={() => setOpen(o => !o)} style={{ width: '100%', padding: '9px', background: 'var(--paper-50)', border: 'none', borderTop: '1px solid var(--border-subtle)', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600, color: 'var(--link)' }}>
        {open ? 'Collapse plan' : 'Show full plan'}
      </button>
    </div>
  );
}

function SectionCard({ title, count, children }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-sm)', padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 13 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-default)' }}>{title}</span>
        {count && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-subtle)' }}>{count}</span>}
      </div>
      {children}
    </div>
  );
}

/* ---------- rich body ---------- */
function RichIssueBody({ d, onOpenSession }) {
  const [tab, setTab] = React.useState('comments');
  const acDone = d.acceptance.filter(a => a.done).length;
  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '24px 28px' }}>
        <div style={{ maxWidth: 780, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
          <Markdown text={d.description} />

          <SectionCard title="Acceptance criteria" count={`${acDone}/${d.acceptance.length}`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {d.acceptance.map((a, i) => (
                <div key={i} style={{ display: 'flex', gap: 10 }}>
                  <span style={{ width: 17, height: 17, marginTop: 1, borderRadius: 5, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: a.done ? 'var(--green-500)' : 'var(--bg-surface)', border: `1.5px solid ${a.done ? 'var(--green-500)' : 'var(--border-strong)'}` }}>{a.done && <Icon name="check" size={11} strokeWidth={3} style={{ color: '#fff' }} />}</span>
                  <span style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--fg-muted)' }}>{mdInline(a.text, 'ac' + i)}</span>
                </div>
              ))}
            </div>
          </SectionCard>

          <PlanSection plan={d.plan} />

          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-sm)', padding: '20px 22px' }}>
            <div className="fg-overline" style={{ marginBottom: 16 }}>Pipeline</div>
            <PipelineTracker stage={d.stage} status="done" variant="full" />
          </div>

          <div>
            <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-default)', marginBottom: 20 }}>
              {[['comments', `Comments · ${d.comments.length}`], ['activity', `Activity · ${d.activity.length}`]].map(([k, l]) => (
                <button key={k} onClick={() => setTab(k)} style={{ padding: '10px 12px', background: 'transparent', border: 'none', borderBottom: `2px solid ${tab === k ? 'var(--accent)' : 'transparent'}`, cursor: 'pointer', marginBottom: -1, fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600, color: tab === k ? 'var(--fg-default)' : 'var(--fg-subtle)' }}>{l}</button>
              ))}
            </div>
            {tab === 'comments' && (
              <div>
                {d.comments.map((c, i) => <RichComment key={i} c={c} last={i === d.comments.length - 1} />)}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, padding: '10px 12px', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-md)' }}>
                  <span style={{ flex: 1, fontSize: 13.5, color: 'var(--fg-disabled)' }}>Add a comment…</span>
                  <Button variant="secondary" size="sm">Comment</Button>
                </div>
              </div>
            )}
            {tab === 'activity' && <ActivityFeed items={d.activity} />}
          </div>
        </div>
      </div>

      {/* Properties rail */}
      <aside style={{ width: 300, flex: 'none', borderLeft: '1px solid var(--border-default)', background: 'var(--bg-surface)', overflowY: 'auto', padding: '20px 20px 24px' }}>
        <div className="fg-overline" style={{ marginBottom: 14 }}>Properties</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          <PropRow label="Status"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--green-600)', background: 'var(--green-50)', padding: '3px 9px', borderRadius: 'var(--r-pill)' }}><Icon name="check" size={12} />Closed</span></PropRow>
          <PropRow label="Priority"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--accent-text)' }}><span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent)' }} />{d.priority}</span></PropRow>
          <PropRow label="Category"><MonoTag>{d.category}</MonoTag></PropRow>
          <PropRow label="Complexity"><MonoTag>{d.complexity}</MonoTag></PropRow>
          <PropRow label="Assignee"><Avatar initials={d.assignee} hue="cobalt" size={20} /><span style={{ fontSize: 13, color: 'var(--fg-default)' }}>Sid Kumar</span></PropRow>
          <PropRow label="Labels">{d.labels.map(l => <MonoTag key={l}>{l}</MonoTag>)}</PropRow>
          <PropRow label="Branch"><MonoTag><Icon name="branch" size={11} style={{ verticalAlign: -1, marginRight: 3 }} />{d.branch}</MonoTag></PropRow>
          <PropRow label="Merge"><MonoTag hue="flame">{d.mergeCommit}</MonoTag></PropRow>
          <PropRow label="Cost"><span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--fg-default)' }}>{d.cost}</span></PropRow>
          <PropRow label="Created"><span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-subtle)' }}>{d.created}</span></PropRow>
          <PropRow label="Reopens"><span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--fg-default)' }}>{d.reopenCount}</span></PropRow>
        </div>
        <div className="fg-overline" style={{ margin: '22px 0 11px' }}>Dependencies</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>Blocked by</span>
          {d.deps.blockedBy.map(x => <DepRow key={x.id} dep={x} kind="blockedBy" />)}
          <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 4 }}>Relates to</span>
          {d.deps.relates.map(x => <DepRow key={x.id} dep={x} kind="relates" />)}
        </div>
        <button onClick={() => onOpenSession(d)} style={{ width: '100%', marginTop: 22, display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', background: 'var(--flame-50)', border: '1px solid var(--flame-100)', borderRadius: 'var(--r-md)', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
          <Icon name="agent" size={16} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent-text)' }}>Open agent session</span>
          <Icon name="chevronRight" size={15} style={{ color: 'var(--accent)', marginLeft: 'auto' }} />
        </button>
      </aside>
    </div>
  );
}

/* ---------- simple body (non-rich) ---------- */
function SimpleIssueBody({ issue, onOpenSession }) {
  const [tab, setTab] = React.useState('activity');
  const labels = issue.labels && issue.labels.length ? issue.labels : ['backend', 'runner'];
  const tabs = [['activity', 'Activity'], ['tasks', `Tasks · ${ISSUE_TASKS.filter(t => t.done).length}/${ISSUE_TASKS.length}`], ['comments', `Comments · ${ISSUE_COMMENTS.length}`]];
  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '24px 28px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 22 }}>
          <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.62, color: 'var(--fg-default)' }}>{renderInlineCode(ISSUE_DESC)}</p>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-sm)', padding: '20px 22px' }}>
            <div className="fg-overline" style={{ marginBottom: 16 }}>Pipeline</div>
            <PipelineTracker stage={issue.stage} status={issue.status} variant="full" />
          </div>
          <div>
            <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-default)', marginBottom: 18 }}>
              {tabs.map(([k, l]) => (
                <button key={k} onClick={() => setTab(k)} style={{ padding: '10px 12px', background: 'transparent', border: 'none', borderBottom: `2px solid ${tab === k ? 'var(--accent)' : 'transparent'}`, cursor: 'pointer', marginBottom: -1, fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600, color: tab === k ? 'var(--fg-default)' : 'var(--fg-subtle)' }}>{l}</button>
              ))}
            </div>
            {tab === 'activity' && <div>{RUN_TIMELINE.map((item, i) => <TimelineRow key={item.stage} item={item} isLast={i === RUN_TIMELINE.length - 1} />)}</div>}
            {tab === 'tasks' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {ISSUE_TASKS.map((t, i) => (
                  <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 13px', background: 'var(--paper-50)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)' }}>
                    <span style={{ width: 18, height: 18, borderRadius: 5, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: t.done ? 'var(--green-500)' : 'var(--bg-surface)', border: `1.5px solid ${t.done ? 'var(--green-500)' : 'var(--border-strong)'}` }}>{t.done && <Icon name="check" size={12} strokeWidth={3} style={{ color: '#fff' }} />}</span>
                    <span style={{ fontSize: 13.5, color: t.done ? 'var(--fg-subtle)' : 'var(--fg-default)', textDecoration: t.done ? 'line-through' : 'none' }}>{t.text}</span>
                  </label>
                ))}
              </div>
            )}
            {tab === 'comments' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {ISSUE_COMMENTS.map((c, i) => (
                  <div key={i} style={{ display: 'flex', gap: 11 }}>
                    {c.agent ? <span style={{ width: 28, height: 28, flex: 'none', borderRadius: 'var(--r-md)', background: 'var(--flame-50)', border: '1px solid var(--flame-100)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="agent" size={15} style={{ color: 'var(--accent)' }} /></span> : <Avatar initials={c.initials} hue={c.hue} size={28} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}><span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-default)' }}>{c.author}</span><span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-subtle)' }}>{c.time}</span></div>
                      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--fg-muted)' }}>{c.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <aside style={{ width: 300, flex: 'none', borderLeft: '1px solid var(--border-default)', background: 'var(--bg-surface)', overflowY: 'auto', padding: '20px 20px 24px' }}>
        <div className="fg-overline" style={{ marginBottom: 14 }}>Properties</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          <PropRow label="Status"><StatusChip status={issue.status} stage={issue.stage} size="sm" /></PropRow>
          <PropRow label="Stage"><MonoTag>{issue.stage}</MonoTag></PropRow>
          <PropRow label="Assignee"><Avatar initials={issue.assignee || 'SK'} hue={issue.cohue || 'cobalt'} size={20} /><span style={{ fontSize: 13, color: 'var(--fg-default)' }}>Sid Kumar</span></PropRow>
          <PropRow label="Priority"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--accent-text)' }}><span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent)' }} />High</span></PropRow>
          <PropRow label="Labels">{labels.map(l => <MonoTag key={l}>{l}</MonoTag>)}</PropRow>
          <PropRow label="Branch"><MonoTag><Icon name="branch" size={11} style={{ verticalAlign: -1, marginRight: 3 }} />feat/runner-sweep</MonoTag></PropRow>
          <PropRow label="Cost"><span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--fg-default)' }}>{issue.cost || '$0.42'}</span></PropRow>
        </div>
        <div className="fg-overline" style={{ margin: '22px 0 11px' }}>Dependencies</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>Blocked by</span>
          {ISSUE_DEPS.blockedBy.map(x => <DepRow key={x.id} dep={x} kind="blockedBy" />)}
          <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 4 }}>Blocks</span>
          {ISSUE_DEPS.blocks.map(x => <DepRow key={x.id} dep={x} kind="blocks" />)}
        </div>
        <button onClick={() => onOpenSession(issue)} style={{ width: '100%', marginTop: 22, display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', background: 'var(--flame-50)', border: '1px solid var(--flame-100)', borderRadius: 'var(--r-md)', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
          <Icon name="agent" size={16} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent-text)' }}>Open agent session</span>
          <Icon name="chevronRight" size={15} style={{ color: 'var(--accent)', marginLeft: 'auto' }} />
        </button>
      </aside>
    </div>
  );
}

function IssueScreen({ issue, onBack, onOpenSession }) {
  const rich = issue.rich ? RICH_ISSUE : null;
  const title = rich ? rich.title : issue.title;
  const id = rich ? rich.id : issue.id;
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-app)' }}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 14, padding: '13px 22px', borderBottom: '1px solid var(--border-default)', background: 'var(--bg-surface)' }}>
        <button onClick={onBack} title="Back" style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)', cursor: 'pointer', color: 'var(--fg-muted)' }}>
          <Icon name="arrowRight" size={17} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--fg-subtle)' }}>{id}</span>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink-900)', letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {rich
          ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--green-600)', background: 'var(--green-50)', padding: '4px 10px', borderRadius: 'var(--r-pill)' }}><Icon name="check" size={12} />Closed</span>
          : <StatusChip status={issue.status} stage={issue.stage} size="sm" />}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {rich
            ? <Button variant="secondary" size="sm" icon="rerun">Reopen</Button>
            : (issue.status === 'running' ? <Button variant="secondary" size="sm" icon="pause">Pause</Button> : <Button variant="primary" size="sm" icon="play">Run pipeline</Button>)}
          <Button variant="secondary" size="sm" icon="agent" onClick={() => onOpenSession(issue)}>Open session</Button>
          <Button variant="ghost" size="sm" icon="more" style={{ padding: '6px 8px' }} />
        </div>
      </div>
      {rich ? <RichIssueBody d={rich} onOpenSession={onOpenSession} /> : <SimpleIssueBody issue={issue} onOpenSession={onOpenSession} />}
    </div>
  );
}

window.IssueScreen = IssueScreen;
