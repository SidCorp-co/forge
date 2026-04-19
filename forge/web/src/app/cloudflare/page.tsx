'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/layout/shell';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { useAuth } from '@/providers/auth-provider';
import { projectApi } from '@/features/project/api/project-api';
import type { CloudflareAccount, CloudflareZone, CloudflareDnsRecord } from '@/features/project/types';
import { Loader2, Plus, Trash2, Cloud, CheckCircle2, XCircle, RefreshCw, Pencil, X, Globe, ChevronRight, ChevronDown, ArrowLeft, Shield, Zap } from 'lucide-react';

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-success/20 text-success border-success/30',
    inactive: 'bg-outline/20 text-outline border-outline/30',
    error: 'bg-danger/20 text-danger border-danger/30',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider border rounded-sm ${colors[status] || colors.inactive}`}>
      {status}
    </span>
  );
}

// ── DNS Record Management ──────────────────────────────────────

function DnsPanel({ accountDocId, zone, onBack }: { accountDocId: string; zone: CloudflareZone; onBack: () => void }) {
  const [records, setRecords] = useState<CloudflareDnsRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);
  const [purgeResult, setPurgeResult] = useState<string | null>(null);

  // Add record form
  const [showAdd, setShowAdd] = useState(false);
  const [newType, setNewType] = useState('A');
  const [newName, setNewName] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newProxied, setNewProxied] = useState(false);
  const [newTtl, setNewTtl] = useState('1');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const fetchRecords = useCallback(async () => {
    setError(null);
    try {
      const res = await projectApi.getCloudflareDns(accountDocId, zone.id);
      setRecords(res.data || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load DNS records');
      setRecords([]);
    }
    setLoading(false);
  }, [accountDocId, zone.id]);

  useEffect(() => { fetchRecords(); }, [fetchRecords]);

  const handleAdd = async () => {
    if (!newName.trim() || !newContent.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      await projectApi.createCloudflareDns(accountDocId, zone.id, {
        type: newType,
        name: newName.trim(),
        content: newContent.trim(),
        proxied: newProxied,
        ttl: parseInt(newTtl) || 1,
      });
      setNewName('');
      setNewContent('');
      setShowAdd(false);
      await fetchRecords();
    } catch (err: any) {
      setAddError(err.message || 'Failed to create record');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (recordId: string) => {
    if (!window.confirm('Delete this DNS record?')) return;
    try {
      await projectApi.deleteCloudflareDns(accountDocId, zone.id, recordId);
      await fetchRecords();
    } catch { /* ignore */ }
  };

  const handlePurge = async () => {
    if (!window.confirm('Purge all cached content for this zone?')) return;
    setPurging(true);
    setPurgeResult(null);
    try {
      await projectApi.purgeCloudflareCache(accountDocId, zone.id);
      setPurgeResult('Cache purged successfully');
      setTimeout(() => setPurgeResult(null), 3000);
    } catch (err: any) {
      setPurgeResult(`Failed: ${err.message}`);
    } finally {
      setPurging(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="p-1.5 hover:bg-surface-container rounded-sm transition-colors">
          <ArrowLeft className="h-4 w-4 text-on-surface-variant" />
        </button>
        <Globe className="h-5 w-5 text-primary" />
        <div className="flex-1">
          <div className="text-sm font-bold text-on-surface">{zone.name}</div>
          <div className="text-[10px] text-on-surface-variant">
            {zone.status} &middot; {zone.plan || 'Free'} &middot; NS: {zone.name_servers?.join(', ')}
          </div>
        </div>
        <button
          onClick={handlePurge}
          disabled={purging}
          className="flex items-center gap-1 px-2 py-1 text-[9px] font-bold uppercase tracking-wider border border-outline-variant/30 hover:bg-surface-container rounded-sm transition-colors disabled:opacity-50"
        >
          {purging ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
          Purge Cache
        </button>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1 px-2 py-1 text-[9px] font-bold uppercase tracking-wider bg-primary text-on-primary rounded-sm hover:opacity-90 transition-opacity"
        >
          <Plus className="h-3 w-3" /> Add Record
        </button>
      </div>

      {purgeResult && (
        <div className={`text-[10px] px-3 py-2 rounded-sm border ${purgeResult.startsWith('Failed') ? 'bg-danger/10 text-danger border-danger/30' : 'bg-success/10 text-success border-success/30'}`}>
          {purgeResult}
        </div>
      )}

      {/* Add Record Form */}
      {showAdd && (
        <div className="border border-outline-variant/30 bg-surface-container-low p-4 space-y-3">
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">New DNS Record</h4>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              className="bg-surface-container border border-outline-variant/30 px-2 py-1.5 text-sm text-on-surface rounded-sm"
            >
              {['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name (e.g. @, www)"
              className="bg-surface-container border border-outline-variant/30 px-2 py-1.5 text-sm text-on-surface rounded-sm"
            />
            <input
              type="text"
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="Content (IP / value)"
              className="bg-surface-container border border-outline-variant/30 px-2 py-1.5 text-sm text-on-surface rounded-sm sm:col-span-2"
            />
            <input
              type="text"
              value={newTtl}
              onChange={(e) => setNewTtl(e.target.value)}
              placeholder="TTL (1=auto)"
              className="bg-surface-container border border-outline-variant/30 px-2 py-1.5 text-sm text-on-surface rounded-sm"
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[10px] text-on-surface-variant">
              <input type="checkbox" checked={newProxied} onChange={(e) => setNewProxied(e.target.checked)} className="rounded" />
              Proxied
            </label>
            {addError && <span className="text-[10px] text-danger">{addError}</span>}
            <div className="ml-auto flex gap-2">
              <button onClick={() => setShowAdd(false)} className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-on-surface-variant hover:bg-surface-container rounded-sm">Cancel</button>
              <button
                onClick={handleAdd}
                disabled={adding || !newName.trim() || !newContent.trim()}
                className="flex items-center gap-1 px-2 py-1 text-[9px] font-bold uppercase tracking-wider bg-primary text-on-primary rounded-sm hover:opacity-90 disabled:opacity-50"
              >
                {adding && <Loader2 className="h-3 w-3 animate-spin" />} Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DNS Records Table */}
      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
      ) : error ? (
        <div className="text-[10px] text-danger px-3 py-2 border border-danger/30 bg-danger/10 rounded-sm">{error}</div>
      ) : records.length === 0 ? (
        <div className="text-center py-8 text-on-surface-variant text-[11px]">No DNS records found</div>
      ) : (
        <div className="border border-outline-variant/30 rounded-sm overflow-hidden">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-surface-container text-on-surface-variant text-left">
                <th className="px-3 py-2 font-bold uppercase tracking-wider text-[9px]">Type</th>
                <th className="px-3 py-2 font-bold uppercase tracking-wider text-[9px]">Name</th>
                <th className="px-3 py-2 font-bold uppercase tracking-wider text-[9px]">Content</th>
                <th className="px-3 py-2 font-bold uppercase tracking-wider text-[9px]">Proxy</th>
                <th className="px-3 py-2 font-bold uppercase tracking-wider text-[9px]">TTL</th>
                <th className="px-3 py-2 font-bold uppercase tracking-wider text-[9px] w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/10">
              {records.map((r) => (
                <tr key={r.id} className="hover:bg-surface-container-low/50">
                  <td className="px-3 py-2 font-mono font-bold text-primary">{r.type}</td>
                  <td className="px-3 py-2 text-on-surface font-mono truncate max-w-[200px]">{r.name}</td>
                  <td className="px-3 py-2 text-on-surface-variant font-mono truncate max-w-[250px]">{r.content}</td>
                  <td className="px-3 py-2">
                    {r.proxied ? <Shield className="h-3.5 w-3.5 text-warning" /> : <span className="text-outline">—</span>}
                  </td>
                  <td className="px-3 py-2 text-on-surface-variant">{r.ttl === 1 ? 'Auto' : `${r.ttl}s`}</td>
                  <td className="px-3 py-2">
                    <button onClick={() => handleDelete(r.id)} className="p-1 text-danger/60 hover:text-danger hover:bg-danger/10 rounded-sm transition-colors">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Account Card ──────────────────────────────────────────────

function AccountCard({
  account,
  onDelete,
  onValidate,
  onUpdate,
  onSelectZone,
}: {
  account: CloudflareAccount;
  onDelete: (id: string) => void;
  onValidate: (id: string) => void;
  onUpdate: (id: string, data: Partial<{ name: string; accountId: string; apiToken: string }>) => void;
  onSelectZone: (account: CloudflareAccount) => void;
}) {
  const [validating, setValidating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(account.name);
  const [editAccountId, setEditAccountId] = useState(account.accountId);
  const [editToken, setEditToken] = useState('');
  const [saving, setSaving] = useState(false);

  const handleValidate = async () => {
    setValidating(true);
    try { await onValidate(account.documentId); } finally { setValidating(false); }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const data: Partial<{ name: string; accountId: string; apiToken: string }> = {};
      if (editName !== account.name) data.name = editName;
      if (editAccountId !== account.accountId) data.accountId = editAccountId;
      if (editToken) data.apiToken = editToken;
      if (Object.keys(data).length > 0) await onUpdate(account.documentId, data);
      setEditing(false);
      setEditToken('');
    } finally { setSaving(false); }
  };

  return (
    <div className="border border-outline-variant/30 bg-surface-container-low p-5 space-y-3">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <Cloud className="h-5 w-5 text-primary shrink-0" />
          <div className="min-w-0 flex-1">
            {editing ? (
              <div className="space-y-2">
                <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} className="block w-full bg-surface-container border border-outline-variant/30 px-2 py-1 text-sm text-on-surface rounded-sm" placeholder="Account name" />
                <input type="text" value={editAccountId} onChange={(e) => setEditAccountId(e.target.value)} className="block w-full bg-surface-container border border-outline-variant/30 px-2 py-1 text-sm text-on-surface rounded-sm" placeholder="Cloudflare Account ID" />
                <input type="password" value={editToken} onChange={(e) => setEditToken(e.target.value)} className="block w-full bg-surface-container border border-outline-variant/30 px-2 py-1 text-sm text-on-surface rounded-sm" placeholder="New API token (leave empty to keep current)" />
              </div>
            ) : (
              <>
                <div className="text-sm font-bold text-on-surface">{account.name}</div>
                <div className="text-[10px] text-on-surface-variant font-mono">{account.accountId}</div>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={account.status} />
          {editing ? (
            <>
              <button onClick={handleSave} disabled={saving} className="p-1.5 text-success hover:bg-success/10 rounded-sm transition-colors" title="Save">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              </button>
              <button onClick={() => { setEditing(false); setEditName(account.name); setEditAccountId(account.accountId); setEditToken(''); }} className="p-1.5 text-on-surface-variant hover:bg-surface-container rounded-sm transition-colors" title="Cancel">
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <>
              <button onClick={() => onSelectZone(account)} className="p-1.5 text-primary hover:bg-primary/10 rounded-sm transition-colors" title="Browse Zones">
                <Globe className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => setEditing(true)} className="p-1.5 text-on-surface-variant hover:bg-surface-container rounded-sm transition-colors" title="Edit">
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => onDelete(account.documentId)} className="p-1.5 text-danger hover:bg-danger/10 rounded-sm transition-colors" title="Delete">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4 text-[10px] text-on-surface-variant">
        <span>Validated: {timeAgo(account.lastValidated)}</span>
        {account.validationError && (
          <span className="text-danger flex items-center gap-1"><XCircle className="h-3 w-3" />{account.validationError}</span>
        )}
        <button onClick={handleValidate} disabled={validating} className="ml-auto flex items-center gap-1 px-2 py-1 text-[9px] font-bold uppercase tracking-wider border border-outline-variant/30 hover:bg-surface-container rounded-sm transition-colors disabled:opacity-50">
          {validating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Validate
        </button>
      </div>
    </div>
  );
}

// ── Zone Picker ───────────────────────────────────────────────

function ZonePicker({ account, onSelectZone, onBack }: { account: CloudflareAccount; onSelectZone: (zone: CloudflareZone) => void; onBack: () => void }) {
  const [zones, setZones] = useState<CloudflareZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await projectApi.getCloudflareZones(account.documentId);
        setZones(res.data || []);
      } catch (err: any) {
        setError(err.message || 'Failed to load zones');
      }
      setLoading(false);
    })();
  }, [account.documentId]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="p-1.5 hover:bg-surface-container rounded-sm transition-colors">
          <ArrowLeft className="h-4 w-4 text-on-surface-variant" />
        </button>
        <Cloud className="h-5 w-5 text-primary" />
        <div>
          <div className="text-sm font-bold text-on-surface">{account.name}</div>
          <div className="text-[10px] text-on-surface-variant">Select a zone to manage DNS records</div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
      ) : error ? (
        <div className="text-[10px] text-danger px-3 py-2 border border-danger/30 bg-danger/10 rounded-sm">{error}</div>
      ) : zones.length === 0 ? (
        <div className="text-center py-8 text-on-surface-variant text-[11px]">No zones found for this account</div>
      ) : (
        <div className="space-y-2">
          {zones.map((zone) => (
            <button
              key={zone.id}
              onClick={() => onSelectZone(zone)}
              className="w-full flex items-center gap-3 border border-outline-variant/30 bg-surface-container-low p-4 hover:bg-surface-container transition-colors text-left rounded-sm"
            >
              <Globe className="h-4 w-4 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-on-surface">{zone.name}</div>
                <div className="text-[10px] text-on-surface-variant">
                  {zone.status} &middot; {zone.plan || 'Free'} &middot; {zone.name_servers?.length || 0} nameservers
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-on-surface-variant shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────

type ViewState =
  | { view: 'accounts' }
  | { view: 'zones'; account: CloudflareAccount }
  | { view: 'dns'; account: CloudflareAccount; zone: CloudflareZone };

export default function CloudflarePage() {
  useSetPageTitle('Cloudflare');
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!authLoading && !user?.isCEO) {
      router.replace('/dashboard');
    }
  }, [authLoading, user, router]);

  const [accounts, setAccounts] = useState<CloudflareAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState<ViewState>({ view: 'accounts' });

  // Add account form
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAccountId, setNewAccountId] = useState('');
  const [newApiToken, setNewApiToken] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await projectApi.getCloudflareAccounts();
      setAccounts(res.data || []);
    } catch {
      setAccounts([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchAccounts(); }, [fetchAccounts]);

  const handleAdd = async () => {
    if (!newName.trim() || !newAccountId.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      await projectApi.createCloudflareAccount({ name: newName.trim(), accountId: newAccountId.trim(), apiToken: newApiToken.trim() });
      setNewName(''); setNewAccountId(''); setNewApiToken('');
      setShowAdd(false);
      await fetchAccounts();
    } catch (err: any) {
      setAddError(err.message || 'Failed to add account');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this Cloudflare account?')) return;
    try { await projectApi.deleteCloudflareAccount(id); await fetchAccounts(); } catch { /* ignore */ }
  };

  const handleValidate = async (id: string) => {
    try { await projectApi.validateCloudflareAccount(id); await fetchAccounts(); } catch { /* ignore */ }
  };

  const handleUpdate = async (id: string, data: Partial<{ name: string; accountId: string; apiToken: string }>) => {
    try { await projectApi.updateCloudflareAccount(id, data); await fetchAccounts(); } catch { /* ignore */ }
  };

  if (authLoading || !user?.isCEO) return null;

  return (
    <Shell>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-4 py-8 sm:px-8">
          {/* Header — always visible */}
          <div className="flex items-center justify-between mb-8 border-b border-outline-variant/30 pb-4">
            <div>
              <h1 className="mb-1 text-xl font-bold sm:text-2xl text-primary tracking-tight">Cloudflare</h1>
              <p className="text-[11px] text-on-surface-variant">Manage Cloudflare accounts, DNS records, and cache</p>
            </div>
            {viewState.view === 'accounts' && (
              <button
                onClick={() => setShowAdd(!showAdd)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-primary text-on-primary rounded-sm hover:opacity-90 transition-opacity"
              >
                <Plus className="h-3.5 w-3.5" /> Add Account
              </button>
            )}
          </div>

          {/* View: Accounts List */}
          {viewState.view === 'accounts' && (
            <>
              {showAdd && (
                <div className="mb-6 border border-outline-variant/30 bg-surface-container-low p-5 space-y-3">
                  <h3 className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">New Cloudflare Account</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Display name (e.g. Production)" className="bg-surface-container border border-outline-variant/30 px-3 py-2 text-sm text-on-surface rounded-sm" />
                    <input type="text" value={newAccountId} onChange={(e) => setNewAccountId(e.target.value)} placeholder="Cloudflare Account ID" className="bg-surface-container border border-outline-variant/30 px-3 py-2 text-sm text-on-surface rounded-sm" />
                    <input type="password" value={newApiToken} onChange={(e) => setNewApiToken(e.target.value)} placeholder="API Token" className="bg-surface-container border border-outline-variant/30 px-3 py-2 text-sm text-on-surface rounded-sm" />
                  </div>
                  {addError && <p className="text-[10px] text-danger">{addError}</p>}
                  <div className="flex items-center gap-2">
                    <button onClick={handleAdd} disabled={adding || !newName.trim() || !newAccountId.trim()} className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-primary text-on-primary rounded-sm hover:opacity-90 transition-opacity disabled:opacity-50">
                      {adding && <Loader2 className="h-3 w-3 animate-spin" />} Create
                    </button>
                    <button onClick={() => { setShowAdd(false); setAddError(null); }} className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant hover:bg-surface-container rounded-sm transition-colors">Cancel</button>
                  </div>
                </div>
              )}

              {loading ? (
                <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
              ) : accounts.length === 0 ? (
                <div className="text-center py-16 text-on-surface-variant">
                  <Cloud className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No Cloudflare accounts configured</p>
                  <p className="text-[10px] mt-1">Add an account to manage DNS records and domains</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {accounts.map((account) => (
                    <AccountCard
                      key={account.documentId}
                      account={account}
                      onDelete={handleDelete}
                      onValidate={handleValidate}
                      onUpdate={handleUpdate}
                      onSelectZone={(a) => setViewState({ view: 'zones', account: a })}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {/* View: Zone Picker */}
          {viewState.view === 'zones' && (
            <ZonePicker
              account={viewState.account}
              onSelectZone={(zone) => setViewState({ view: 'dns', account: viewState.account, zone })}
              onBack={() => setViewState({ view: 'accounts' })}
            />
          )}

          {/* View: DNS Records */}
          {viewState.view === 'dns' && (
            <DnsPanel
              accountDocId={viewState.account.documentId}
              zone={viewState.zone}
              onBack={() => setViewState({ view: 'zones', account: viewState.account })}
            />
          )}
        </div>
      </div>
    </Shell>
  );
}
