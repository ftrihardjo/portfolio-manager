import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import BpmnModeler from 'bpmn-js/lib/Modeler';
import BpmnViewer from 'bpmn-js/lib/NavigatedViewer';
import { BpmnPropertiesPanelModule } from 'bpmn-js-properties-panel';
import TokenSimulationModule from 'bpmn-js-token-simulation';
import 'bpmn-js-token-simulation/assets/css/bpmn-js-token-simulation.css';
import 'bpmn-font/dist/css/bpmn.css';
import 'bpmn-js/dist/assets/diagram-js.css';
import './miro-theme.css';
import JiraPropertiesProvider, {
  ReadOnlyLinkedResourcesGroup,
  getLinkedResources,
} from './JiraPropertiesProvider';
import jiraResourcesModdle from './moddle/jira-resources.json';
import AutomationRuleBuilder from './AutomationRuleBuilder';

const EMPTY_BPMN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false"><bpmn:startEvent id="StartEvent_1" /></bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1"><bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
    <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1"><dc:Bounds x="152" y="102" width="36" height="36" /></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

const MODDLE_EXTENSIONS = { jira: jiraResourcesModdle };
const READER_EXTENSIONS = { jira: jiraResourcesModdle };

function readIssueKey(element) {
  const bo = element && element.businessObject;
  if (!bo || typeof bo.get !== 'function') return '';
  const ext = bo.get('extensionElements');
  const values = ext && typeof ext.get === 'function' ? (ext.get('values') || []) : [];
  const linked = values.find((v) => v.$type === 'jira:LinkedResources');
  return (linked && linked.issueKey) || '';
}

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

// bpmn-js's palette floats *over* the canvas (absolutely positioned), so
// `canvas.zoom('fit-viewport')` — which has no concept of the palette —
// happily fits diagram content right up against the left edge, tucking
// start events / first tasks underneath it. Nudge the fitted viewbox left
// by the palette's approximate on-screen footprint so nothing important
// renders behind it. Only relevant when the palette exists (edit mode).
const PALETTE_CLEARANCE_PX = 72;
function fitViewportClearOfPalette(canvas, canEdit) {
  try {
    canvas.zoom('fit-viewport');
    if (!canEdit) return;
    const vb = canvas.viewbox();
    if (!vb || !vb.scale) return;
    const pad = PALETTE_CLEARANCE_PX / vb.scale;
    canvas.viewbox({ x: vb.x - pad, y: vb.y, width: vb.width + pad, height: vb.height });
  } catch (e) { /* ignore */ }
}

function ViewerPropertiesPanel({ instance }) {
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    if (!instance) return undefined;
    const eventBus = instance.get('eventBus');
    const onSel = (e) => setSelected(e.newSelection?.[0] || null);
    eventBus.on('selection.changed', onSel);
  }, [instance]);
  return (
    <aside data-testid="bpmn-properties-panel" className="bpmn-panel">
      {!selected
        ? <div className="bpmn-panel-empty">Select an element to see its linked Jira issues and documentation.</div>
        : <ReadOnlyLinkedResourcesGroup element={selected} />}
    </aside>
  );
}

function LinkedResourcesNavigator({ instance, onNavigate }) {
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!instance) return undefined;
    const collect = () => {
      const registry = instance.get('elementRegistry');
      const found = [];
      registry.getAll().forEach((el) => {
        if (!el || !el.businessObject) return;
        if (el.type === 'label' || el.type === 'root') return;
        const ext = getLinkedResources(el.businessObject);
        if (!ext) return;
        found.push({
          id: el.id,
          name: el.businessObject.name || el.id,
          type: el.type,
          issueKey: ext.issueKey || '',
          confluencePage: ext.confluencePage || '',
          documentation: ext.documentation || '',
        });
      });
      found.sort((a, b) => a.id.localeCompare(b.id));
      setItems(found);
    };
    collect();
    instance.on('import.done', collect);
    instance.on('commandStack.changed', collect);
    return () => {
      instance.off('import.done', collect);
      instance.off('commandStack.changed', collect);
    };
  }, [instance]);

  const q = query.trim().toLowerCase();
  const filtered = !q
    ? items
    : items.filter((it) =>
        (it.name || '').toLowerCase().includes(q) ||
        (it.issueKey || '').toLowerCase().includes(q) ||
        it.type.toLowerCase().includes(q)
      );

  return (
    <div className="bpmn-navigator" data-testid="bpmn-linked-resources-navigator">
      <div className="bpmn-nav-header">
        <h3 className="bpmn-nav-title">Linked Resources</h3>
        <span className="bpmn-nav-count" data-testid="bpmn-nav-count">{items.length}</span>
      </div>
      <input
        type="text" className="bpmn-nav-search" placeholder="Filter by name or key…"
        value={query} onChange={(e) => setQuery(e.target.value)}
        data-testid="bpmn-nav-search"
        aria-label="Filter linked resources by name, type, or issue key"
      />
      <ul className="bpmn-nav-list" data-testid="bpmn-nav-list">
        {filtered.length === 0 && (
          <li className="bpmn-nav-empty">
            {items.length === 0
              ? 'No elements have linked Jira resources yet.'
              : 'No matches for that filter.'}
          </li>
        )}
        {filtered.map((item) => (
          <li key={item.id} className="bpmn-nav-item">
            <button
              type="button" className="bpmn-nav-item-btn"
              onClick={() => onNavigate(item.id)}
              data-testid={`bpmn-nav-item-${item.id}`}
              title={`Jump to ${item.name} (${item.type})`}
            >
              <div className="bpmn-nav-item-row">
                <span className="bpmn-nav-item-name">{item.name || item.id}</span>
                <span className="bpmn-nav-item-type">{item.type}</span>
              </div>
              {item.issueKey && (
                <div className="bpmn-nav-item-key">
                  <span className="bpmn-nav-item-key-pill">{item.issueKey}</span>
                </div>
              )}
              {item.confluencePage && (
                <div className="bpmn-nav-item-meta" title="Has Confluence page">📄 Confluence linked</div>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function BpmnDiagramView({
  diagramXml, canEdit, onSave, onDirtyChange, saveDisabled,
  modelName, modelVersion, modelVersionName,
  modelLastEditedBy, modelLastEditedByDisplay, modelLastEditedAt,
  currentAccountId,
  showNavigator: showNavigatorProp, onToggleNavigator,
  versions, viewingVersion, onSelectVersion, versionName, onVersionNameChange,
  diagramId, projectKey, realtimeEvent,
  onOpenVersionList,   // ★ NEW — closes the modal and shows the version list
}) {
  const canvasRef = useRef(null);
  const instanceRef = useRef(null);
  const [instance, setInstance] = useState(null);
  const [tokenSimEnabled, setTokenSimEnabled] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const [issueKeyQuery, setIssueKeyQuery] = useState('');
  const [findStatus, setFindStatus] = useState('');
  const findMatchesRef = useRef(null);
  const findCursorRef = useRef(-1);
  const lastQueryRef = useRef('');
  const [localNav, setLocalNav] = useState(true);
  const controlledNav = typeof onToggleNavigator === 'function';
  const showNavigator = controlledNav ? !!showNavigatorProp : localNav;
  const toggleNavigator = () => (controlledNav ? onToggleNavigator() : setLocalNav((v) => !v));
  const [panelSlot, setPanelSlot] = useState(null);
  const preserveXmlRef = useRef(null);

  // ★ Sub-tab: 'diagram' | 'automation'
  const [subTab, setSubTab] = useState('diagram');
  const [compareBase, setCompareBase] = useState(null);   // version number pinned for comparison
  const [diff, setDiff] = useState(null);

  const toggleCompare = async (versionNumber) => {
    if (compareBase === versionNumber) { setCompareBase(null); setDiff(null); return; }
    const base = compareBase ?? viewingVersion;           // first click pins the baseline
    if (base == null || base === versionNumber) return;
    try {
      const d = await invoke('diffBpmnVersions', { diagramId, baseVersion: base, targetVersion: versionNumber });
      setCompareBase(base);
      setDiff(d);
    } catch (e) { setError?.(e.message); }
  };

  useEffect(() => {
    if (!canvasRef.current || subTab !== 'diagram') return undefined;
    const Ctor = canEdit ? BpmnModeler : BpmnViewer;
    const additionalModules = [];
    if (canEdit) additionalModules.push(BpmnPropertiesPanelModule);
    if (canEdit && tokenSimEnabled) additionalModules.push(TokenSimulationModule);
    const inst = new Ctor({
      container: canvasRef.current,
      ...(additionalModules.length > 0 ? { additionalModules } : {}),
      moddleExtensions: canEdit ? MODDLE_EXTENSIONS : READER_EXTENSIONS,
      ...(canEdit ? { propertiesPanel: { parent: '#js-properties-panel' } } : {}),
    });
    instanceRef.current = inst;
    setInstance(inst);
    setPanelSlot(document.getElementById('bpmn-linked-panels-nav-slot'));
    if (canEdit) {
      try { new JiraPropertiesProvider(inst.get('propertiesPanel')); } catch (e) { /* ignore */ }
    }
    const commandStack = canEdit ? inst.get('commandStack') : null;
    const canvas = inst.get('canvas');
    const syncUndo = () => {
      if (!commandStack) return;
      setCanUndo(!!commandStack.canUndo());
      setCanRedo(!!commandStack.canRedo());
    };
    const syncZoom = () => {
      try { setZoomPct(Math.round((canvas.viewbox().scale || 1) * 100)); } catch (e) { /* ignore */ }
    };
    if (canEdit) {
      inst.on('commandStack.changed', () => { onDirtyChange?.(true); syncUndo(); });
    }
    inst.on('canvas.viewbox.changed', syncZoom);
    inst.on('import.done', syncZoom);
    const xmlToImport = preserveXmlRef.current || diagramXml || EMPTY_BPMN_XML;
    preserveXmlRef.current = null;
    inst.importXML(xmlToImport)
      .then(() => {
        fitViewportClearOfPalette(canvas, canEdit);
        syncZoom();
        syncUndo();
    });
    return () => {
      inst.destroy();
      instanceRef.current = null;
      setInstance(null);
      setPanelSlot(null);
    };
  }, [diagramXml, canEdit, tokenSimEnabled, subTab]);

  const handleSave = async () => {
    if (!instanceRef.current || saveDisabled) return;
    const { xml } = await instanceRef.current.saveXML({ format: true });
    await onSave(xml);
    onDirtyChange?.(false);
  };

  const onToggleTokenSim = async (checked) => {
    const inst = instanceRef.current;
    if (inst) {
      try {
        const { xml } = await inst.saveXML({ format: true });
        preserveXmlRef.current = xml;
      } catch (e) { /* fall back */ }
    }
    setTokenSimEnabled(checked);
  };

  const undo = () => { try { instanceRef.current?.get('commandStack').undo(); } catch (e) { /* */ } };
  const redo = () => { try { instanceRef.current?.get('commandStack').redo(); } catch (e) { /* */ } };
  const zoomBy = (factor) => {
    const c = instanceRef.current?.get('canvas');
    if (!c) return;
    try {
      const vb = c.viewbox();
      const next = Math.min(4, Math.max(0.2, vb.scale * factor));
      c.zoom(next, { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 });
    } catch (e) { /* */ }
  };
  const zoomFit = () => {
    const c = instanceRef.current?.get('canvas');
    if (c) fitViewportClearOfPalette(c, canEdit);
  };

  const runFind = () => {
    const inst = instanceRef.current;
    if (!inst) return;
    const q = issueKeyQuery.trim().toUpperCase();
    if (!q) { setFindStatus(''); findMatchesRef.current = null; findCursorRef.current = -1; lastQueryRef.current = ''; return; }
    if (q !== lastQueryRef.current) { lastQueryRef.current = q; findCursorRef.current = -1; findMatchesRef.current = null; }
    let matches = findMatchesRef.current;
    if (!matches) {
      matches = inst.get('elementRegistry').getAll().filter((el) => readIssueKey(el).toUpperCase().includes(q));
      findMatchesRef.current = matches;
    }
    if (matches.length === 0) { setFindStatus('No matches'); return; }
    findCursorRef.current = (findCursorRef.current + 1) % matches.length;
    const el = matches[findCursorRef.current];
    navigateToElement(el);
    setFindStatus(`${findCursorRef.current + 1} of ${matches.length}`);
  };

  const navigateToElement = (el) => {
    const inst = instanceRef.current;
    if (!inst || !el) return;
    try { inst.get('selection').select(el); } catch (e) { /* */ }
    try {
      const pad = 80;
      const x = el.x ?? 0, y = el.y ?? 0, w = el.width || 120, hgt = el.height || 80;
      inst.get('canvas').viewbox({ x: x - pad, y: y - pad, width: w + pad * 2, height: hgt + pad * 2 });
    } catch (e) { /* */ }
  };

  const onFindInputChange = (e) => {
    const v = e.target.value;
    setIssueKeyQuery(v);
    if (!v.trim()) { setFindStatus(''); findMatchesRef.current = null; findCursorRef.current = -1; lastQueryRef.current = ''; }
  };

  // ★ Resolve display name for "last edited by"
  const editorDisplay = modelLastEditedByDisplay || modelLastEditedBy || '';
  const editedByYou = modelLastEditedBy && currentAccountId && modelLastEditedBy === currentAccountId;

  return (
    <div className="bpmn-editor-shell">
      {/* Model header — ★ now shows editor display name */}
      <div className="bpmn-modelbar">
        <span className="bpmn-modelbar-title">{modelName || 'Untitled diagram'}</span>
        {typeof modelVersion === 'number' && (
          <span
            className="bpmn-chip"
            title={modelVersionName ? `Version "${modelVersionName}" (revision ${modelVersion})` : `Revision ${modelVersion}`}
          >
            {modelVersionName || `v${modelVersion}`}
          </span>
        )}
        <span className="bpmn-modelbar-meta">
          {modelLastEditedAt && (
            <>
              Last edited {formatRelative(modelLastEditedAt)}
              {/* ★ Show resolved display name instead of raw accountId */}
              {editorDisplay && ` by ${editedByYou ? 'you' : editorDisplay}`}
            </>
          )}
          {!canEdit && (
            <span className="bpmn-chip" style={{ background: 'var(--ads-neutral)', color: 'var(--ads-text-sub)' }}>
              View only
            </span>
          )}
        </span>
      </div>

      {/* ★ Realtime notification banner */}
      {realtimeEvent && realtimeEvent.type === 'diagram:saved' && (
        <div className="bpmn-realtime-banner" data-testid="realtime-save-banner">
          <span className="bpmn-realtime-dot" />
          <span>
            {realtimeEvent.savedByDisplay || 'Someone'} saved {realtimeEvent.versionName || `v${realtimeEvent.version}`}
            {' '}{formatRelative(realtimeEvent.savedAt)}
          </span>
        </div>
      )}

      {/* ★ Sub-tabs: Diagram | Automation */}
      <div className="bpmn-subtabs" role="tablist" aria-label="BPMN sub-views">
        <button
          role="tab"
          className={`bpmn-subtab ${subTab === 'diagram' ? 'active' : ''}`}
          aria-selected={subTab === 'diagram'}
          onClick={() => setSubTab('diagram')}
          data-testid="subtab-diagram"
        >
          📐 Diagram
        </button>
        <button
          role="tab"
          className={`bpmn-subtab ${subTab === 'automation' ? 'active' : ''}`}
          aria-selected={subTab === 'automation'}
          onClick={() => setSubTab('automation')}
          data-testid="subtab-automation"
        >
          ⚡ Automation
        </button>
      </div>

      {subTab === 'diagram' && (
        <>
          {/* Toolbar — one tidy row: grouped icon buttons + separators */}
          <div className="bpmn-toolbar" role="toolbar" aria-label="Diagram tools">
            {canEdit && (
              <div className="bpmn-tb-group">
                <button className="bpmn-tb-btn primary" onClick={handleSave} disabled={saveDisabled}
                  data-testid="save-bpmn" title="Save diagram">💾 Save</button>
                <label className="bpmn-tb-label bpmn-tb-version-name" htmlFor="bpmn-version-name"
                  title="Name the version you are about to save">
                  <span className="bpmn-tb-label-text">Save as</span>
                  <input id="bpmn-version-name" type="text" data-testid="bpmn-version-name"
                    placeholder="version name (e.g. release-1.0)"
                    value={versionName || ''}
                    onChange={(e) => onVersionNameChange && onVersionNameChange(e.target.value)} />
                </label>
              </div>
            )}

            {canEdit && (
              <div className="bpmn-tb-group">
                <button className="bpmn-tb-btn icon" onClick={undo} disabled={!canUndo}
                  title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
                <button className="bpmn-tb-btn icon" onClick={redo} disabled={!canRedo}
                  title="Redo (Ctrl+Y)" aria-label="Redo">↷</button>
              </div>
            )}

            <div className="bpmn-tb-group">
              {canEdit && (
                <label className="bpmn-toggle" title="Animate tokens through the process">
                  <input type="checkbox" data-testid="toggle-token-simulation"
                    checked={tokenSimEnabled} onChange={(e) => onToggleTokenSim(e.target.checked)} />
                  <span>Token sim</span>
                </label>
              )}
              <button className="bpmn-tb-btn" onClick={() => onOpenVersionList && onOpenVersionList()}
                data-testid="open-version-list" title="Browse and switch versions">
                🕘 Versions{typeof viewingVersion === 'number' ? ` · v${viewingVersion}` : ''}
              </button>
              <button className={`bpmn-tb-btn icon ${showNavigator ? 'active' : ''}`}
                onClick={toggleNavigator} data-testid="toggle-navigator"
                title={showNavigator ? 'Hide navigator' : 'Show navigator'} aria-pressed={showNavigator}>
                {showNavigator ? '◧' : '◨'}
              </button>
            </div>

            <div className="bpmn-tb-group">
              <button className="bpmn-tb-btn icon" onClick={() => zoomBy(1 / 1.2)}
                title="Zoom out" aria-label="Zoom out">−</button>
              <button className="bpmn-tb-btn icon" onClick={zoomFit} title="Fit to screen"
                aria-label="Fit to screen" style={{ minWidth: 52 }}>{zoomPct}%</button>
              <button className="bpmn-tb-btn icon" onClick={() => zoomBy(1.2)}
                title="Zoom in" aria-label="Zoom in">+</button>
            </div>

            <div className="bpmn-tb-spacer" />

            <div className="bpmn-find">
              <input type="text" data-testid="bpmn-find-issue-key"
                placeholder="Find by issue key (e.g. PROJ-123)"
                value={issueKeyQuery} onChange={onFindInputChange}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runFind(); } }} />
              <button className="bpmn-tb-btn" onClick={runFind} data-testid="bpmn-find-button">Find</button>
              {findStatus && <span className="bpmn-find-status">{findStatus}</span>}
            </div>
          </div>

          {/* Canvas + panels */}
          <div className="bpmn-canvas-col">
            {diff && (
              <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}>
                {/* halo outlines on changed shapes */}
                <style>{`
                  ${diff.added.map(e => `[data-element-id="${e.id}"] .djs-outline`).join(',')}
                    { stroke: #36B37E !important; stroke-width: 3px !important; opacity: 1 !important; }
                  ${diff.removed.map(e => `[data-element-id="${e.id}"] .djs-outline`).join(',')}
                    { stroke: #DE350B !important; stroke-width: 3px !important; opacity: 1 !important; }
                  ${diff.modified.map(e => `[data-element-id="${e.id}"] .djs-outline`).join(',')}
                    { stroke: #FFAB00 !important; stroke-width: 3px !important; opacity: 1 !important; }
                `}</style>
              </div>
            )}
            {diff && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, padding: '6px 0', flexWrap: 'wrap' }}>
                <strong>v{diff.base.version} → v{diff.target.version}:</strong>
                <span style={{ color: '#36B37E' }}>+{diff.added.length} added</span>
                <span style={{ color: '#DE350B' }}>−{diff.removed.length} removed</span>
                <span style={{ color: '#974f0c' }}>~{diff.modified.length} changed</span>
                <span style={{ color: '#666' }}>{diff.unchangedCount} unchanged</span>
                <button onClick={() => { setDiff(null); setCompareBase(null); }} style={{ fontSize: 11 }}>Exit compare</button>
              </div>
            )}
            {panelSlot && createPortal(
              <>
                {!canEdit && <ViewerPropertiesPanel instance={instance} />}
                {showNavigator && (
                  <LinkedResourcesNavigator
                    instance={instance}
                    onNavigate={(elementId) => {
                      const el = instanceRef.current?.get('elementRegistry').get(elementId);
                      if (el) navigateToElement(el);
                    }}
                  />
                )}
              </>,
              panelSlot,
            )}
            <div ref={canvasRef} data-testid="bpmn-canvas" className="bpmn-canvas" />
          </div>
        </>
      )}

      {/* ★ Automation sub-tab */}
      {subTab === 'automation' && (
        <AutomationRuleBuilder
          diagramId={diagramId}
          projectKey={projectKey}
          canEdit={canEdit}
        />
      )}
    </div>
  );
}