import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Full-page editor overlay for the UML tab. Simpler than BpmnEditorModal
 * since Mermaid has no canvas library that needs its own DOM portal
 * targets — the editor (toolbar + split code/preview) is passed as
 * `children`, all prop wiring stays in App.jsx.
 */
export default function UmlEditorModal({ open, onClose, dirty, canEdit, headerTitle, headerVersion, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
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
      className="uml-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={headerTitle || 'UML editor'}
      onMouseDown={requestClose}
    >
      <div className="uml-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="uml-modal-header">
          <span className="uml-modal-title">{headerTitle || 'UML Editor'}</span>
          {headerVersion && <span className="uml-chip">{headerVersion}</span>}
          {!canEdit && (
            <span className="uml-chip" style={{ background: '#ebecf0', color: '#6b778c' }}>
              View only
            </span>
          )}
          <button
            className="uml-modal-close"
            onClick={requestClose}
            data-testid="uml-modal-close"
            title="Close (Esc)"
            aria-label="Close editor"
          >
            ×
          </button>
        </div>
        <div className="uml-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
