import { useMemo, useState } from 'react';

// ── tiny deterministic helpers (no deps, no images, no external fonts) ──
function shortHash(diagramId, version, savedAt) {
  const s = `${diagramId || ''}|${version}|${savedAt || ''}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}
function authorHue(id) {
  let h = 0; const s = String(id || '?');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
function initials(name) {
  const p = String(name || '?').trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
}
function rel(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const m = Math.round(Math.max(0, Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}
function abs(iso) {
  const d = new Date(iso || 0);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

// Tolerates legacy records that pre-date the named `versions` array.
function buildCommits(rec) {
  if (!rec) return [];
  let list = [];
  if (Array.isArray(rec.versions) && rec.versions.length) {
    list = rec.versions.map((v) => ({
      version: v.version,
      name: v.name || `v${v.version}`,
      savedAt: v.savedAt || rec.updatedAt,
      savedBy: v.savedBy || rec.lastEditedBy || null,
      savedByDisplay: v.savedByDisplay || v.savedBy || rec.lastEditedByDisplay || null,
      kind: v.kind || 'save',
      message: v.message || '',
      revertedFromVersion: v.revertedFromVersion ?? null,
    }));
  } else if (typeof rec.version === 'number') {
    list = [{
      version: rec.version,
      name: rec.latestVersionName || `v${rec.version}`,
      savedAt: rec.updatedAt,
      savedBy: rec.lastEditedBy || null,
      savedByDisplay: rec.lastEditedByDisplay || rec.lastEditedBy || null,
      kind: 'save', message: '', revertedFromVersion: null,
    }];
  }
  // newest-first, like `git log`
  return list
    .map((c) => ({ ...c, hash: shortHash(rec.id, c.version, c.savedAt) }))
    .sort((a, b) => b.version - a.version);
}

export default function BpmnCommitHistory({ record, canEdit, onPickVersion, onRevert, onBack, compareBase, onCompare }) {
  const [query, setQuery] = useState('');
  const [authorFilter, setAuthorFilter] = useState('');
  const [revertsOnly, setRevertsOnly] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(null); // version awaiting confirm

  const commits = useMemo(() => buildCommits(record), [record]);
  const headVersion = record?.version ?? null;

  const authors = useMemo(() => {
    const m = new Map();
    commits.forEach((c) => {
      if (c.savedBy && !m.has(c.savedBy)) m.set(c.savedBy, c.savedByDisplay || c.savedBy);
    });
    return [...m.entries()].map(([id, name]) => ({ id, name }));
  }, [commits]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return commits.filter((c) => {
      if (revertsOnly && c.kind !== 'revert') return false;
      if (authorFilter && c.savedBy !== authorFilter) return false;
      if (q) {
        const hay = `${c.hash} ${c.name} ${c.message} ${c.savedByDisplay || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [commits, query, authorFilter, revertsOnly]);

  const lastActive = commits.length ? commits[0].savedAt : null;

  const doRevert = (version) => {
    setConfirmRevert(null);
    onRevert && onRevert(version);
  };

  return (
    <div className="commit-ledger" data-testid="bpmn-version-list">
      {/* header — mono kicker + heavy display title = the type contrast */}
      <div className="cl-head">
        <button className="cl-back" onClick={onBack} data-testid="bpmn-version-list-back">← Library</button>
        <div className="cl-titles">
          <span className="cl-kicker">commit ledger · append-only</span>
          <h3 className="cl-title">{record?.name || 'Diagram'}</h3>
        </div>
        <div className="cl-stats" aria-label="Commit statistics">
          <div className="cl-stat"><span className="cl-stat-num">{commits.length}</span><span className="cl-stat-lbl">commits</span></div>
          <div className="cl-stat"><span className="cl-stat-num">{authors.length}</span><span className="cl-stat-lbl">authors</span></div>
          <div className="cl-stat"><span className="cl-stat-num cl-stat-time">{lastActive ? rel(lastActive) : '—'}</span><span className="cl-stat-lbl">last active</span></div>
        </div>
      </div>

      {/* filters */}
      <div className="cl-filters">
        <input
          type="text" className="cl-search"
          placeholder="Search hash, message, author…"
          value={query} onChange={(e) => setQuery(e.target.value)}
          data-testid="bpmn-version-search" aria-label="Search commits"
        />
        <select
          className="cl-author-select" value={authorFilter}
          onChange={(e) => setAuthorFilter(e.target.value)} aria-label="Filter by author"
        >
          <option value="">All authors</option>
          {authors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label className="cl-toggle">
          <input type="checkbox" checked={revertsOnly} onChange={(e) => setRevertsOnly(e.target.checked)} />
          <span>Reverts only</span>
        </label>
      </div>

      {/* the ledger rail */}
      {filtered.length === 0 ? (
        <div className="cl-empty">{commits.length === 0 ? 'No commits yet — the first save starts the ledger.' : 'No commits match these filters.'}</div>
      ) : (
        <ul className="cl-rail" data-testid="bpmn-version-list-rows">
          {filtered.map((c, idx) => {
            const isHead = c.version === headVersion;
            const isRevert = c.kind === 'revert';
            const hue = authorHue(c.savedBy);
            const openEditor = () => onPickVersion && onPickVersion(c.version);
            return (
              <li
                key={c.version}
                className="cl-row"
                style={{ animationDelay: `${Math.min(idx, 12) * 38}ms` }}
              >
                {/* node on the rail */}
                <span className={`cl-node ${isHead ? 'head' : ''} ${isRevert ? 'revert' : ''}`} aria-hidden="true">
                  {isRevert ? '↺' : isHead ? '●' : '·'}
                </span>

                {/* the card — primary click opens this version in the editor */}
                <div
                  className={`cl-card ${isHead ? 'is-head' : ''}`}
                  role="button" tabIndex={0}
                  data-testid={`bpmn-version-row-${c.version}`}
                  title={`Open ${c.name} in the editor`}
                  onClick={openEditor}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(); } }}
                >
                  <div className="cl-card-top">
                    <code className="cl-hash">{c.hash}</code>
                    <span className={`cl-badge ${isRevert ? 'revert' : 'save'}`}>
                      {isRevert ? `revert ↺ from v${c.revertedFromVersion ?? '?'}` : 'save'}
                    </span>
                    {isHead && <span className="cl-badge head">HEAD</span>}
                    <time className="cl-time" dateTime={c.savedAt || ''} title={abs(c.savedAt)}>{rel(c.savedAt)}</time>
                  </div>

                  <div className="cl-card-mid">
                    <span className="cl-avatar" style={{ background: `hsl(${hue} 52% 42%)` }} aria-hidden="true">
                      {initials(c.savedByDisplay)}
                    </span>
                    <span className="cl-author">{c.savedByDisplay || c.savedBy || 'unknown'}</span>
                    <span className="cl-vname">{c.name}</span>
                  </div>

                  {(c.message || isRevert) && (
                    <p className="cl-msg">{c.message || (isRevert ? `Reverted to v${c.revertedFromVersion ?? '?'}` : '')}</p>
                  )}

                  {/* actions — stopPropagation so they don't trigger the open */}
                  <div className="cl-actions">
                    <button className="cl-act" onClick={(e) => { e.stopPropagation(); openEditor(); }} data-testid={`open-commit-${c.version}`}>
                      Open in editor
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); if (onCompare) onCompare(c.version); }}
                      data-testid={`compare-commit-${c.version}`}
                      title={compareBase && compareBase !== c.version ? `Diff v${compareBase} → v${c.version}` : 'Pin as comparison baseline'}
                      style={{ fontSize: 11, marginLeft: 6 }}
                    >
                      {compareBase === c.version ? 'Baseline ✓' : 'Compare'}
                    </button>
                    {canEdit && !isHead && confirmRevert !== c.version && (
                      <button
                        className="cl-act revert"
                        onClick={(e) => { e.stopPropagation(); setConfirmRevert(c.version); }}
                        data-testid={`revert-commit-${c.version}`}
                        title="Create a new commit that restores this version (nothing is deleted)"
                      >
                        Revert to this
                      </button>
                    )}
                    {canEdit && isHead && (
                      <span className="cl-act-note">current HEAD — nothing to revert</span>
                    )}
                  </div>

                  {/* inline confirm — no jarring window.confirm */}
                  {confirmRevert === c.version && (
                    <div className="cl-confirm" role="alertdialog" aria-label="Confirm revert">
                      <span>
                        Revert to <strong>{c.name}</strong>? This creates a new commit on top —
                        the existing history is kept intact.
                      </span>
                      <span className="cl-confirm-btns">
                        <button className="cl-act revert" onClick={(e) => { e.stopPropagation(); doRevert(c.version); }}>Confirm revert</button>
                        <button className="cl-act" onClick={(e) => { e.stopPropagation(); setConfirmRevert(null); }}>Cancel</button>
                      </span>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}