import React, { useState, useCallback } from 'react';
import { invoke } from '@forge/bridge';
import { PLG, Events } from '../analytics';

const draftKey = (id) => `automation:draft:${id}`;

// ─── Constants ──────────────────────────────────────────────────────
const TRIGGER_TYPES = [
  { value: 'issue_created', label: 'Issue Created' },
  { value: 'issue_updated', label: 'Issue Updated' },
  { value: 'issue_transitioned', label: 'Issue Transitioned' },
  { value: 'priority_changed', label: 'Priority Changed' },
  { value: 'issue_assigned', label: 'Issue Assigned' },
  { value: 'comment_added', label: 'Comment Added' },
  { value: 'due_date_reached', label: 'Due Date Reached' },
  { value: 'sprint_started', label: 'Sprint Started' },
  { value: 'sprint_completed', label: 'Sprint Completed' },
];

const CONDITION_FIELDS = [
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'issueType', label: 'Issue Type' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'labels', label: 'Labels' },
  { value: 'components', label: 'Components' },
  { value: 'customField', label: 'Custom Field' },
];

const CONDITION_OPERATORS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
  { value: 'greater_than', label: 'greater than' },
  { value: 'less_than', label: 'less than' },
];

const ACTION_TYPES = [
  { value: 'set_field', label: 'Set Field Value' },
  { value: 'transition', label: 'Transition Issue' },
  { value: 'add_comment', label: 'Add Comment' },
  { value: 'assign_to', label: 'Assign To' },
  { value: 'add_label', label: 'Add Label' },
  { value: 'remove_label', label: 'Remove Label' },
  { value: 'create_issue', label: 'Create Linked Issue' },
  { value: 'send_notification', label: 'Send Notification' },
  { value: 'webhook', label: 'Call Webhook' },
];

const HIT_POLICIES = [
  { value: 'UNIQUE', label: 'Unique (U) — exactly one rule matches' },
  { value: 'FIRST', label: 'First (F) — first matching rule wins' },
  { value: 'COLLECT', label: 'Collect (C) — all matching rules apply' },
  { value: 'ANY', label: 'Any (A) — all matching rules must agree' },
];

let ruleIdCounter = 0;
const newRuleId = () => `rule-${Date.now()}-${++ruleIdCounter}`;

function emptyCondition() {
  return { id: `cond-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, field: 'status', operator: 'equals', value: '' };
}
function emptyAction() {
  return { id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type: 'set_field', config: {} };
}
function emptyDecisionRow(inputs, outputs) {
  const row = { id: `row-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` };
  inputs.forEach((inp) => { row[inp.id] = ''; });
  outputs.forEach((out) => { row[out.id] = ''; });
  return row;
}

// ─── Decision Table (DMN-inspired) ─────────────────────────────────
function DecisionTableEditor({ table, onChange }) {
  const inputs = table.inputs || [];
  const outputs = table.outputs || [];
  const rows = table.rows || [];

  const addInput = () => {
    const col = { id: `in-${Date.now()}`, label: `Input ${inputs.length + 1}`, type: 'string' };
    onChange({ ...table, inputs: [...inputs, col] });
  };
  const addOutput = () => {
    const col = { id: `out-${Date.now()}`, label: `Output ${outputs.length + 1}`, type: 'string' };
    onChange({ ...table, outputs: [...outputs, col] });
  };
  const addRow = () => {
    onChange({ ...table, rows: [...rows, emptyDecisionRow(inputs, outputs)] });
    trackEvent('dmn_row_added', { row_count: rows.length + 1 });
  };

  // Index-based so rows loaded from older saves (no `id`) still delete correctly.
  const removeRow = (idx) => {
    onChange({ ...table, rows: rows.filter((_, i) => i !== idx) });
  };

  // Deleting a column also strips its cells from every row, so stored
  // rules and the execution engine never see dangling column ids.
  const dropColumn = (colId, kind) => {
    const key = kind === 'input' ? 'inputs' : 'outputs';
    onChange({
      ...table,
      [key]: table[key].filter((c) => c.id !== colId),
      rows: rows.map((r) => {
        if (!(colId in r)) return r;
        const { [colId]: _omit, ...rest } = r;
        return rest;
      }),
    });
  };

  const updateCell = (rowIdx, colId, value) => {
    onChange({
      ...table,
      rows: rows.map((r, i) => (i === rowIdx ? { ...r, [colId]: value } : r)),
    });
  };

  const updateColLabel = (colId, label, kind) => {
    const key = kind === 'input' ? 'inputs' : 'outputs';
    onChange({ ...table, [key]: table[key].map((c) => (c.id === colId ? { ...c, label } : c)) });
  };

  const colDelBtn = (colId, kind, label) => (
    <button
      onClick={() => dropColumn(colId, kind)}
      style={{ background: 'none', border: 'none', color: '#DE350B', cursor: 'pointer', fontSize: 12, padding: 0, flex: '0 0 auto' }}
      title={`Remove ${kind} column "${label}"`}
      aria-label={`Remove ${kind} column ${label}`}
    >
      ✕
    </button>
  );

  return (
    <div className="decision-table-wrapper" data-testid="decision-table">
      <table className="decision-table">
        <thead>
          <tr>
            <th className="row-num">#</th>
            {inputs.map((col) => (
              <th key={col.id} className="input-col">
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="text"
                    value={col.label}
                    onChange={(e) => updateColLabel(col.id, e.target.value, 'input')}
                    style={{ fontWeight: 600, textTransform: 'uppercase', fontSize: 11, flex: 1, minWidth: 0 }}
                    aria-label={`Input column: ${col.label}`}
                  />
                  {colDelBtn(col.id, 'input', col.label)}
                </div>
              </th>
            ))}
            {outputs.map((col) => (
              <th key={col.id} className="output-col">
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="text"
                    value={col.label}
                    onChange={(e) => updateColLabel(col.id, e.target.value, 'output')}
                    style={{ fontWeight: 600, textTransform: 'uppercase', fontSize: 11, flex: 1, minWidth: 0 }}
                    aria-label={`Output column: ${col.label}`}
                  />
                  {colDelBtn(col.id, 'output', col.label)}
                </div>
              </th>
            ))}
            <th style={{ width: 36 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={row.id || `row-${idx}`}>
              <td className="row-num">{idx + 1}</td>
              {inputs.map((col) => (
                <td key={col.id}>
                  <input
                    type="text"
                    value={row[col.id] || ''}
                    onChange={(e) => updateCell(idx, col.id, e.target.value)}
                    placeholder="e.g. High, Bug"
                    aria-label={`${col.label} for row ${idx + 1}`}
                  />
                </td>
              ))}
              {outputs.map((col) => (
                <td key={col.id}>
                  <input
                    type="text"
                    value={row[col.id] || ''}
                    onChange={(e) => updateCell(idx, col.id, e.target.value)}
                    placeholder="e.g. P1, Assign"
                    aria-label={`${col.label} for row ${idx + 1}`}
                  />
                </td>
              ))}
              <td style={{ textAlign: 'center' }}>
                <button
                  onClick={() => removeRow(idx)}
                  style={{ background: 'none', border: 'none', color: '#DE350B', cursor: 'pointer', fontSize: 14 }}
                  title={`Remove row ${idx + 1}`}
                  aria-label={`Remove row ${idx + 1}`}
                  data-testid={`remove-row-${idx}`}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={inputs.length + outputs.length + 2} style={{ textAlign: 'center', padding: 10, color: 'var(--ads-text-muted, #6b778c)' }}>
                No rows yet — use “+ Add Row”.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div style={{ display: 'flex', gap: 8, padding: '8px 10px', borderTop: '1px solid var(--ads-border)' }}>
        <button onClick={addRow} style={{ fontSize: 12 }} data-testid="add-row">+ Add Row</button>
        <button onClick={addInput} style={{ fontSize: 12 }} data-testid="add-input">+ Add Input</button>
        <button onClick={addOutput} style={{ fontSize: 12 }} data-testid="add-output">+ Add Output</button>
      </div>
    </div>
  );
}

// ─── Single Rule Card ───────────────────────────────────────────────
function RuleCard({ rule, index, onChange, onRemove }) {
  const [expanded, setExpanded] = useState(index === 0);

  const update = (patch) => onChange({ ...rule, ...patch });

  const addCondition = () => update({ conditions: [...rule.conditions, emptyCondition()] });
  const removeCondition = (id) => update({ conditions: rule.conditions.filter((c) => c.id !== id) });
  const updateCondition = (id, patch) =>
    update({ conditions: rule.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)) });

  const addAction = () => update({ actions: [...rule.actions, emptyAction()] });
  const removeAction = (id) => update({ actions: rule.actions.filter((a) => a.id !== id) });
  const updateAction = (id, patch) =>
    update({ actions: rule.actions.map((a) => (a.id === id ? { ...a, ...patch } : a)) });

  return (
    <div className="rule-card" data-testid={`rule-card-${rule.id}`}>
      <div className="rule-card-header" onClick={() => setExpanded((v) => !v)}>
        <h4>
          <span style={{ color: 'var(--ads-text-muted)', fontSize: 11 }}>#{index + 1}</span>
          {rule.name || 'Untitled Rule'}
          <span
            style={{
              fontSize: 10, padding: '2px 6px', borderRadius: 999,
              background: rule.enabled ? 'var(--ads-success-bg)' : 'var(--ads-neutral)',
              color: rule.enabled ? 'var(--ads-success)' : 'var(--ads-text-muted)',
            }}
          >
            {rule.enabled ? 'Active' : 'Disabled'}
          </span>
        </h4>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              update({ enabled: !rule.enabled });
              trackEvent(rule.enabled ? 'rule_disabled' : 'rule_enabled', { trigger_type: rule.trigger });
            }}
            style={{ fontSize: 11, height: 26 }}
          >
            {rule.enabled ? 'Disable' : 'Enable'}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(rule.id); }}
            style={{ fontSize: 11, height: 26, color: '#DE350B' }}
          >
            Delete
          </button>
          <span style={{ fontSize: 14, color: 'var(--ads-text-muted)' }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div className="rule-card-body">
          {/* Rule name */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Rule Name</label>
            <input
              type="text"
              value={rule.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="e.g. Auto-escalate P1 bugs"
              data-testid={`rule-name-${rule.id}`}
            />
          </div>

          {/* ── TRIGGER ── */}
          <div className="rule-block">
            <div className="rule-block-label trigger">⚡ When (Trigger)</div>
            <select
              value={rule.trigger}
              onChange={(e) => {
                update({ trigger: e.target.value });
                trackEvent('trigger_type_selected', { trigger_type: e.target.value });
              }}
              data-testid={`rule-trigger-${rule.id}`}
            >
              {TRIGGER_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            {rule.trigger === 'issue_transitioned' && (
              <input
                type="text"
                value={rule.triggerConfig?.toStatus || ''}
                onChange={(e) => update({ triggerConfig: { ...rule.triggerConfig, toStatus: e.target.value } })}
                placeholder="To status (e.g. Done)"
              />
            )}
          </div>

          {/* ── CONDITIONS ── */}
          <div className="rule-block">
            <div className="rule-block-label condition">🔍 If (Conditions)</div>
            {rule.conditions.map((cond) => (
              <div key={cond.id} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <select
                  value={cond.field}
                  onChange={(e) => updateCondition(cond.id, { field: e.target.value })}
                  style={{ flex: 1 }}
                >
                  {CONDITION_FIELDS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
                <select
                  value={cond.operator}
                  onChange={(e) => updateCondition(cond.id, { operator: e.target.value })}
                  style={{ flex: 1 }}
                >
                  {CONDITION_OPERATORS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                {!['is_empty', 'is_not_empty'].includes(cond.operator) && (
                  <input
                    type="text"
                    value={cond.value}
                    onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                    placeholder="value"
                    style={{ flex: 1 }}
                  />
                )}
                <button
                  onClick={() => removeCondition(cond.id)}
                  style={{ background: 'none', border: 'none', color: '#DE350B', cursor: 'pointer' }}
                  aria-label="Remove condition"
                >
                  ✕
                </button>
              </div>
            ))}
            <button onClick={addCondition} style={{ fontSize: 12 }}>+ Add Condition</button>
          </div>

          {/* ── DECISION TABLE (DMN) ── */}
          <div className="rule-block">
            <div className="rule-block-label condition">📊 Decision Table (DMN)</div>
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 11, color: 'var(--ads-text-sub)', marginRight: 8 }}>Hit Policy:</label>
              <select
                value={rule.decisionTable?.hitPolicy || 'FIRST'}
                onChange={(e) => update({
                  decisionTable: { ...rule.decisionTable, hitPolicy: e.target.value },
                })}
                style={{ fontSize: 12, height: 28 }}
              >
                {HIT_POLICIES.map((hp) => (
                  <option key={hp.value} value={hp.value}>{hp.label}</option>
                ))}
              </select>
            </div>
            <DecisionTableEditor
              table={rule.decisionTable || { inputs: [], outputs: [], rows: [], hitPolicy: 'FIRST' }}
              onChange={(dt) => update({ decisionTable: dt })}
            />
          </div>

          {/* ── ACTIONS ── */}
          <div className="rule-block">
            <div className="rule-block-label action">✅ Then (Actions)</div>
            {rule.actions.map((act) => (
              <div key={act.id} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <select
                  value={act.type}
                  onChange={(e) => {
                    updateAction(act.id, { type: e.target.value });
                    trackEvent('action_type_used', { action_type: e.target.value });
                  }}
                  style={{ flex: 1 }}
                >
                  {ACTION_TYPES.map((a) => (
                    <option key={a.value} value={a.value}>{a.label}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={act.config?.value || ''}
                  onChange={(e) => updateAction(act.id, { config: { ...act.config, value: e.target.value } })}
                  placeholder="value / target"
                  style={{ flex: 2 }}
                />
                <button
                  onClick={() => removeAction(act.id)}
                  style={{ background: 'none', border: 'none', color: '#DE350B', cursor: 'pointer' }}
                  aria-label="Remove action"
                >
                  ✕
                </button>
              </div>
            ))}
            <button onClick={addAction} style={{ fontSize: 12 }}>+ Add Action</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Builder ───────────────────────────────────────────────────
export default function AutomationRuleBuilder({ diagramId, projectKey, canEdit }) {
  const [rules, setRules] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);

  // Load on mount; restore an unsaved local draft so switching tabs never loses work.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!diagramId) return;
      try {
        const savedRules = (await invoke('getAutomationRules', { diagramId })) || [];
        if (cancelled) return;

        let draft = null;
        try {
          const raw = localStorage.getItem(draftKey(diagramId));
          draft = raw ? JSON.parse(raw) : null;
        } catch {
          draft = null;
        }

        if (Array.isArray(draft) && draft.length > 0) {
          setRules(draft);
          setDirty(true);
          setDraftRestored(true); // ✅ Must be true here
        } else {
          setRules(savedRules);
          setDirty(false);
          setDraftRestored(false);
        }
      } catch (e) {
        console.error('Load rules error:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [diagramId]);

  // Keep a local draft while there are unsaved changes.
  React.useEffect(() => {
    if (!diagramId || !dirty) return;
    try { localStorage.setItem(draftKey(diagramId), JSON.stringify(rules)); } catch {}
  }, [rules, dirty, diagramId]);

  const addRule = useCallback(() => {
    setRules((prev) => [
      ...prev,
      {
        id: newRuleId(),
        name: '',
        enabled: true,
        trigger: 'issue_created',
        triggerConfig: {},
        conditions: [emptyCondition()],
        decisionTable: {
          inputs: [{ id: `in-${Date.now()}`, label: 'Priority', type: 'string' }],
          outputs: [{ id: `out-${Date.now()}`, label: 'Action', type: 'string' }],
          rows: [],
          hitPolicy: 'FIRST',
        },
        actions: [emptyAction()],
      },
    ]);
    setDirty(true);
    setDraftRestored(false);
  }, []);

  const updateRule = useCallback((updated) => {
    setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    setSaved(false);
  }, []);

  const removeRule = useCallback((id) => {
    setRules((prev) => prev.filter((r) => r.id !== id));
    setSaved(false);
  }, []);

  // handleSave
  const handleSave = async () => {
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    try {
      await invoke('saveAutomationRules', { diagramId, projectKey, rules });

      // Persisted → drop the draft
      setDirty(false);
      setDraftRestored(false);
      try { localStorage.removeItem(draftKey(diagramId)); } catch {}
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);

      // ── PLG: fire ONLY after confirmed persistence ──────────────
      const usesDmn = rules.some((r) => (r.decisionTable?.rows?.length || 0) > 0);
      PLG.track(Events.AUTOMATION_RULE_CREATED, {
        rule_count: rules.length,
        enabled_count: rules.filter((r) => r.enabled).length,
        uses_dmn: usesDmn,
        project_key: projectKey,
      });
      if (usesDmn) {
        PLG.track(Events.DECISION_TABLE_USED, {
          rows: rules.reduce((n, r) => n + (r.decisionTable?.rows?.length || 0), 0),
        });
      }
      if (!localStorage.getItem('plg_first_rule_done')) {
        PLG.track(Events.FIRST_RULE_CREATED, { project_key: projectKey });
        localStorage.setItem('plg_first_rule_done', '1');
      }
    } catch (e) {
      setError(e.message || 'Failed to save rules'); // no PLG events on failure
    } finally {
      setSaving(false);
    }
  };

  if (!canEdit) {
    return (
      <div className="automation-builder" data-testid="automation-builder-readonly">
        <h3>Automation Rules</h3>
        <p style={{ color: 'var(--ads-text-muted)', fontSize: 13 }}>
          You need edit permission on this project to manage automation rules.
        </p>
        {rules.length > 0 && (
          <p style={{ fontSize: 13 }}>{rules.length} rule(s) configured (view only).</p>
        )}
      </div>
    );
  }

  return (
    <div className="automation-builder" data-testid="automation-builder">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Automation Rules</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={addRule} data-testid="add-rule" className="btn-primary" style={{ color: '#fff' }}>
            + New Rule
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            data-testid="save-rules"
            className="btn-primary"
            style={{ color: '#fff' }}
          >
            {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Rules'}
          </button>
        </div>
      </div>

      {/* ✅ BANNER MUST BE HERE - Top level, outside of any conditionals */}
      {draftRestored && (
        <div data-testid="draft-restored" style={{ padding: '8px 12px', marginBottom: 12, fontSize: 13, background: '#ebecf0', borderRadius: 6, color: '#172b4d' }}>
          Unsaved draft restored — press <strong>Save Rules</strong> to persist it.
        </div>
      )}

      {error && (
        <div style={{ padding: '8px 12px', background: 'var(--ads-danger-bg)', color: 'var(--ads-danger)', borderRadius: 'var(--r-sm)', marginBottom: 12, fontSize: 13 }}>
          {error}
        </div>
      )}

      {rules.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--ads-text-muted)' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>⚡</div>
          <p style={{ fontSize: 14, marginBottom: 4 }}>No automation rules yet</p>
          <p style={{ fontSize: 12 }}>Create rules that automatically trigger actions when issues change.</p>
          <button onClick={addRule} className="btn-primary" style={{ color: '#fff', marginTop: 12 }}>+ Create Your First Rule</button>
        </div>
      ) : (
        rules.map((rule, idx) => (
          <RuleCard key={rule.id} rule={rule} index={idx} onChange={updateRule} onRemove={removeRule} />
        ))
      )}
    </div>
  );
}