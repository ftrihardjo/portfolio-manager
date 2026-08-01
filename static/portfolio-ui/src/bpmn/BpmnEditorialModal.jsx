import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Full-page editor overlay. The actual editor (toolbar + canvas + sub-tabs)
 * is passed as `children` so all of its prop wiring stays in App.jsx; this
 * component only supplies the modal chrome and, critically, the two DOM
 * slots that bpmn-js portals its properties panel + navigator into. Those
 * slots live HERE (not in the sidebar) so there is exactly one element with
 * each id in the document while the editor is mounted.
 */
export default function BpmnEditorModal({
  open,
  onClose,
  dirty,
  canEdit,
  headerTitle,
  headerVersion,
  children,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const requestClose = () => {
    if (dirty && typeof window !== 'undefined' &&
        !window.confirm('You have unsaved changes. Close the editor anyway?')) {
      return;
    }
    onClose();
  };

  return createPortal(
    <div
      className="bpmn-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={headerTitle || 'BPMN editor'}
      onMouseDown={requestClose}
    >
      {/* stopPropagation so clicks inside the dialog don't reach the backdrop */}
      <div className="bpmn-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="bpmn-modal-header">
          <span className="bpmn-modal-title">{headerTitle || 'BPMN Editor'}</span>
          {headerVersion && <span className="bpmn-chip">{headerVersion}</span>}
          {!canEdit && (
            <span className="bpmn-chip" style={{ background: 'var(--ads-neutral, #ebecf0)', color: 'var(--ads-text-sub, #6b778c)' }}>
              View only
            </span>
          )}
          <button
            className="bpmn-modal-close"
            onClick={requestClose}
            data-testid="bpmn-modal-close"
            title="Close (Esc)"
            aria-label="Close editor"
          >
            ×
          </button>
        </div>

        <div className="bpmn-modal-body">
          {/* Side column = the portal targets bpmn-js writes into. */}
          <div className="bpmn-modal-side">
            {canEdit && (
              <div id="js-properties-panel" data-testid="bpmn-properties-panel" className="bpmn-panel" />
            )}
            <div id="bpmn-linked-panels-nav-slot" />
          </div>

          {/* Canvas column = the editor itself (toolbar + canvas + sub-tabs). */}
          <div className="bpmn-modal-canvas-col">{children}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}