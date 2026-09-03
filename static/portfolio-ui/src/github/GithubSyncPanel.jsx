import { useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';

// Lets a project owner connect their Jira project to a GitHub repo the
// GitHub App is already installed on. Once connected, every BPMN/DMN save
// on that project is mirrored there as a commit (see saveBpmnDiagram's
// GitOps push on the backend).
//
// Self-contained like AutomationRuleBuilder: it fetches/saves its own
// config via invoke() rather than being fed props from App.jsx, so it can
// be dropped into any tab without extra plumbing.
export default function GithubSyncPanel({ projectKey, canEdit }) {
  const [config, setConfig] = useState(null); // stored config, or null if never set
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  // Draft form fields — only meaningful once loaded, seeded from `config`.
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [pathTemplate, setPathTemplate] = useState('workflows/{id}.bpmn');
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!projectKey) return undefined;
    setLoading(true);
    setError(null);
    invoke('getGithubConfig', { projectKey })
      .then((cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        if (cfg) {
          setOwner(cfg.owner || '');
          setRepo(cfg.repo || '');
          setBranch(cfg.branch || 'main');
          setPathTemplate(cfg.pathTemplate || 'workflows/{id}.bpmn');
          setEnabled(cfg.enabled !== false);
        }
      })
      .catch((e) => { if (!cancelled) setError(e?.message || 'Failed to load GitHub sync settings.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectKey]);

  const ownerTrimmed = owner.trim();
  const repoTrimmed = repo.trim();
  const branchTrimmed = branch.trim() || 'main';
  const pathTrimmed = pathTemplate.trim() || 'workflows/{id}.bpmn';
  const saveDisabled = saving || !ownerTrimmed || !repoTrimmed;

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const saved = await invoke('saveGithubConfig', {
        projectKey, owner: ownerTrimmed, repo: repoTrimmed,
        branch: branchTrimmed, pathTemplate: pathTrimmed, enabled,
      });
      setConfig(saved);
      setSavedAt(new Date());
    } catch (e) {
      setError(e?.message || 'Failed to save GitHub sync settings.');
    } finally {
      setSaving(false);
    }
  }

  if (!projectKey) {
    return <p style={{ color: '#666' }}>Select a project to configure GitHub sync.</p>;
  }
  if (loading) {
    return <p style={{ color: '#666' }}>Loading GitHub sync settings…</p>;
  }

  const fieldStyle = { width: '100%', boxSizing: 'border-box', padding: '6px 8px' };
  const labelStyle = { display: 'block', fontSize: '12px', fontWeight: 'bold', marginBottom: '4px' };

  return (
    <div style={{ maxWidth: '480px' }} data-testid="github-sync-panel">
      <p style={{ fontSize: '13px', color: '#666', marginTop: 0 }}>
        When connected, every saved BPMN/DMN diagram in <strong>{projectKey}</strong> is
        also committed to the repo below — so development teams can review
        workflow changes side-by-side with code, using ordinary Git branches and PRs.
      </p>

      {config?.installed === false && (
        <div role="alert" style={{
          background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 4,
          padding: '8px 12px', marginBottom: 12, fontSize: 12,
        }}>
          The GitHub App isn't installed on <strong>{config.owner}/{config.repo}</strong> (anymore).
          Install it on that repository to resume syncing.
        </div>
      )}

      {!canEdit && (
        <p style={{ fontSize: '12px', color: '#666' }}>
          View only — you need edit permission on this project to change its GitHub sync settings.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', gap: '10px' }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle} htmlFor="gh-owner">Owner / org</label>
            <input
              id="gh-owner" type="text" placeholder="e.g. ftrihardjo"
              value={owner} onChange={(e) => setOwner(e.target.value)}
              disabled={!canEdit || saving} style={fieldStyle} data-testid="github-owner-input"
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle} htmlFor="gh-repo">Repository</label>
            <input
              id="gh-repo" type="text" placeholder="e.g. portfolio-manager"
              value={repo} onChange={(e) => setRepo(e.target.value)}
              disabled={!canEdit || saving} style={fieldStyle} data-testid="github-repo-input"
            />
          </div>
        </div>

        <div>
          <label style={labelStyle} htmlFor="gh-branch">Branch</label>
          <input
            id="gh-branch" type="text" value={branch} onChange={(e) => setBranch(e.target.value)}
            disabled={!canEdit || saving} style={fieldStyle} data-testid="github-branch-input"
          />
        </div>

        <div>
          <label style={labelStyle} htmlFor="gh-path">
            File path template
          </label>
          <input
            id="gh-path" type="text" value={pathTemplate} onChange={(e) => setPathTemplate(e.target.value)}
            disabled={!canEdit || saving} style={fieldStyle} data-testid="github-path-input"
          />
          <p style={{ fontSize: '11px', color: '#666', margin: '4px 0 0' }}>
            Use <code>{'{id}'}</code> and/or <code>{'{name}'}</code> — e.g. <code>workflows/{'{name}'}.bpmn</code>.
          </p>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
          <input
            type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)}
            disabled={!canEdit || saving} data-testid="github-enabled-toggle"
          />
          Sync BPMN/DMN saves to this repo
        </label>
      </div>

      {error && (
        <p role="alert" style={{ color: '#bf2600', fontSize: '12px', marginTop: '10px' }}>{error}</p>
      )}
      {savedAt && !error && (
        <p style={{ color: '#006644', fontSize: '12px', marginTop: '10px' }}>
          Saved at {savedAt.toLocaleTimeString()}.
        </p>
      )}

      {canEdit && (
        <button
          onClick={handleSave} disabled={saveDisabled} data-testid="github-save-config"
          style={{ marginTop: '14px' }}
        >
          {saving ? 'Saving…' : (config ? 'Save changes' : 'Connect repository')}
        </button>
      )}

      <p style={{ fontSize: '11px', color: '#999', marginTop: '16px' }}>
        The repository must already have the Portfolio Manager GitHub App installed on it.
      </p>
    </div>
  );
}
