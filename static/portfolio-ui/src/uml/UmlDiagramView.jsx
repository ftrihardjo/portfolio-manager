import { useEffect, useRef, useState } from 'react';
import MermaidDiagram from '../components/MermaidDiagram';
import './uml-theme.css';

export const EMPTY_UML_CODE = `classDiagram
    class Diagram {
      +String name
      +render()
    }`;

function formatRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Text-based counterpart to BpmnDiagramView. Mermaid diagrams are plain
 * text, so there is no canvas/palette/properties-panel machinery here —
 * just a code editor with a live preview, wired into the same
 * save/version/revert/realtime contract the BPMN tab uses.
 */
export default function UmlDiagramView({
  code,
  canEdit,
  onSave,
  onDirtyChange,
  saveDisabled,
  modelName,
  modelVersion,
  modelVersionName,
  modelLastEditedByDisplay,
  modelLastEditedAt,
  versionName,
  onVersionNameChange,
  commitMessage,
  onCommitMessageChange,
  realtimeEvent,
  onOpenVersionList,
  viewingVersion,
}) {
  const [localCode, setLocalCode] = useState(code || EMPTY_UML_CODE);
  const [renderError, setRenderError] = useState(null);
  const [zoom, setZoom] = useState(1);
  const savedCodeRef = useRef(code || EMPTY_UML_CODE);

  useEffect(() => {
    setLocalCode(code || EMPTY_UML_CODE);
    savedCodeRef.current = code || EMPTY_UML_CODE;
  }, [code]);

  const dirty = localCode !== savedCodeRef.current;
  useEffect(() => { onDirtyChange && onDirtyChange(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = () => {
    savedCodeRef.current = localCode;
    onSave && onSave(localCode);
  };

  const zoomPct = Math.round(zoom * 100);
  const zoomBy = (factor) => setZoom((z) => Math.min(3, Math.max(0.25, z * factor)));
  const zoomFit = () => setZoom(1);

  return (
    <div className="uml-view" data-testid="uml-diagram-view">
      {realtimeEvent && realtimeEvent.type === 'diagram:saved' && (
        <div className="uml-realtime-banner" data-testid="uml-realtime-save-banner">
          <span className="uml-realtime-dot" />
          <span>
            {realtimeEvent.savedByDisplay || 'Someone'} saved {realtimeEvent.versionName || `v${realtimeEvent.version}`}
            {' '}{formatRelative(realtimeEvent.savedAt)}
          </span>
        </div>
      )}

      <div className="uml-toolbar" role="toolbar" aria-label="UML diagram tools">
        {canEdit && (
          <div className="uml-tb-group">
            <button className="uml-tb-btn primary" onClick={handleSave}
              disabled={saveDisabled || !dirty} data-testid="save-uml" title="Save diagram">
              💾 Save
            </button>
            <label className="uml-tb-label" htmlFor="uml-version-name" title="Name the version you are about to save">
              <span className="uml-tb-label-text">Save as</span>
              <input id="uml-version-name" type="text" data-testid="uml-version-name"
                placeholder="version name (e.g. v1-draft)"
                value={versionName || ''}
                onChange={(e) => onVersionNameChange && onVersionNameChange(e.target.value)} />
            </label>
            <label className="uml-tb-label" htmlFor="uml-commit-message"
              title="Optional: describe what changed in this save, like a git commit message">
              <span className="uml-tb-label-text">Message</span>
              <input id="uml-commit-message" type="text" data-testid="uml-commit-message"
                placeholder="what changed (optional)"
                value={commitMessage || ''}
                onChange={(e) => onCommitMessageChange && onCommitMessageChange(e.target.value)} />
            </label>
          </div>
        )}

        <div className="uml-tb-group">
          <button className="uml-tb-btn" onClick={() => onOpenVersionList && onOpenVersionList()}
            data-testid="open-uml-version-list" title="Browse and switch versions">
            🕘 Versions{typeof viewingVersion === 'number' ? ` · v${viewingVersion}` : ''}
          </button>
        </div>

        <div className="uml-tb-group">
          <button className="uml-tb-btn icon" onClick={() => zoomBy(1 / 1.2)} title="Zoom out" aria-label="Zoom out">−</button>
          <button className="uml-tb-btn icon" onClick={zoomFit} title="Reset zoom" aria-label="Reset zoom" style={{ minWidth: 52 }}>{zoomPct}%</button>
          <button className="uml-tb-btn icon" onClick={() => zoomBy(1.2)} title="Zoom in" aria-label="Zoom in">+</button>
        </div>

        <div className="uml-tb-spacer" />

        {modelName && (
          <div className="uml-tb-meta" title={modelLastEditedAt ? `Last edited ${new Date(modelLastEditedAt).toLocaleString()}` : ''}>
            <span className="uml-tb-meta-name">{modelName}</span>
            {modelVersionName && <span className="uml-tb-meta-version">{modelVersionName}</span>}
            {modelLastEditedByDisplay && <span className="uml-tb-meta-editor">by {modelLastEditedByDisplay}</span>}
          </div>
        )}
      </div>

      {!canEdit && (
        <p className="uml-readonly-note">View only — this diagram is read-only for you.</p>
      )}

      <div className="uml-split">
        <div className="uml-editor-col">
          <h3 className="uml-col-title">Mermaid Code</h3>
          <textarea
            className="uml-editor-textarea"
            data-testid="uml-code-editor"
            value={localCode}
            readOnly={!canEdit}
            onChange={(e) => setLocalCode(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="uml-preview-col">
          <h3 className="uml-col-title">Live Preview</h3>
          <div className="uml-preview-canvas" data-testid="uml-preview-canvas">
            <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top left', display: 'inline-block' }}>
              <MermaidDiagram chart={localCode} onError={setRenderError} />
            </div>
          </div>
          {renderError && (
            <div className="uml-render-error" data-testid="uml-render-error" role="alert">
              {renderError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
