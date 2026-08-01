import { useMemo, useState } from 'react';

function formatRelative(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatAbsolute(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

// Tolerates legacy records that pre-date the named `versions` array.
function buildVersions(rec) {
  if (!rec) return [];
  if (Array.isArray(rec.versions) && rec.versions.length) {
    return rec.versions.map((v) => ({
      version: v.version,
      name: v.name || `v${v.version}`,
      savedAt: v.savedAt || rec.updatedAt,
      savedBy: v.savedByDisplay || v.savedBy || null,
      lastAccessedAt: v.lastAccessedAt || null,
    }));
  }
  if (typeof rec.version === 'number') {
    return [{
      version: rec.version,
      name: rec.latestVersionName || `v${rec.version}`,
      savedAt: rec.updatedAt,
      savedBy: rec.lastEditedByDisplay || rec.lastEditedBy || null,
      lastAccessedAt: rec.lastAccessedAt || null,
    }];
  }
  return [];
}

export default function BpmnVersionList({ record, onPickVersion, onBack }) {
  const [query, setQuery] = useState('');
  const versions = useMemo(() => buildVersions(record), [record]);

  // ★ Descending by most-recent ACCESS date (falls back to save date for
  //   versions nobody has opened since the field was introduced).
  const sorted = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = !q
      ? versions
      : versions.filter((v) =>
          String(v.version).includes(q) ||
          (v.name || '').toLowerCase().includes(q) ||
          (v.savedBy || '').toLowerCase().includes(q) ||
          formatAbsolute(v.lastAccessedAt || v.savedAt).toLowerCase().includes(q),
        );
    return [...filtered].sort(
      (a, b) =>
        new Date(b.lastAccessedAt || b.savedAt || 0).getTime() -
        new Date(a.lastAccessedAt || a.savedAt || 0).getTime(),
    );
  }, [versions, query]);

  const headVersion = record?.version ?? null;

  return (
    <div className="bpmn-version-list" data-testid="bpmn-version-list">
      <div className="bpmn-vl-header">
        <button onClick={onBack} data-testid="bpmn-version-list-back" style={{ fontSize: 12 }}>
          ← Library
        </button>
        <h3 className="bpmn-vl-title">
          {record?.name || 'Diagram'} · {versions.length} version{versions.length === 1 ? '' : 's'}
        </h3>
        <input
          type="text"
          className="bpmn-vl-search"
          placeholder="Search versions by name, editor, or date…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="bpmn-version-search"
          aria-label="Search versions"
        />
      </div>

      {sorted.length === 0 ? (
        <div style={{ padding: '24px 16px', color: '#6b778c', fontSize: 13, textAlign: 'center' }}>
          {versions.length === 0 ? 'No saved versions yet.' : 'No versions match your search.'}
        </div>
      ) : (
        <ul className="bpmn-vl-list" data-testid="bpmn-version-list-rows">
          {sorted.map((v) => (
            <li key={v.version}>
              <button
                className="bpmn-vl-row"
                onClick={() => onPickVersion(v.version)}
                data-testid={`bpmn-version-row-${v.version}`}
                title={`Open ${v.name} in the editor`}
              >
                <div className="bpmn-vl-row-main">
                  <span className="bpmn-vl-row-name">{v.name}</span>
                  <span className="bpmn-vl-row-meta">
                    {v.savedBy ? `by ${v.savedBy} · ` : ''}saved {formatRelative(v.savedAt)}
                    {v.lastAccessedAt ? ` · opened ${formatRelative(v.lastAccessedAt)}` : ''}
                  </span>
                </div>
                {v.version === headVersion && <span className="bpmn-vl-badge">latest</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}