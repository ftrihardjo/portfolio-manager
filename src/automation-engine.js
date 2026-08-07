import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';

export const automationEngine = async (event) => {
  console.log('🚀 Automation Engine Triggered:', JSON.stringify(event));

  const stubIssue = event.issue;
  if (!stubIssue || !stubIssue.fields) return;

  const projectKey = stubIssue.fields.project?.key;
  if (!projectKey) return;

  // The native Forge trigger payload only includes a minimal field set
  // (summary, status, project, people, dates) — it does NOT include
  // priority, labels, assignee, or components. Re-fetch the full issue
  // before evaluating any rule conditions or decision tables.
  const issueRes = await api.asApp().requestJira(
    route`/rest/api/3/issue/${stubIssue.key}?fields=summary,status,priority,issuetype,assignee,labels,components,project`
  );
  const issue = await issueRes.json();
  if (!issue || !issue.fields) return;

  // 1. Determine the specific trigger type from the webhook event
  let triggerType = 'issue_updated';
  if (event.eventType === 'avi:jira:created:issue') {
    triggerType = 'issue_created';
  } else if (event.eventType === 'avi:jira:updated:issue') {
    const items = event.changelog?.items || [];
    if (items.some(item => item.field === 'status')) triggerType = 'issue_transitioned';
    else if (items.some(item => item.field === 'priority')) triggerType = 'priority_changed';
    else if (items.some(item => item.field === 'comment')) triggerType = 'comment_added';
    else if (items.some(item => item.field === 'assignee')) triggerType = 'issue_assigned';
  }

  // 2. Fetch all active diagrams for this project from the central index
  const index = (await kvs.get('bpmn:index')) || [];
  const projectDiagrams = index.filter(d => d.projectKey === projectKey);

  for (const diagramMeta of projectDiagrams) {
    const rules = (await kvs.get(`automation:rules:${diagramMeta.id}`)) || [];

    for (const rule of rules) {
      if (!rule.enabled) continue;

      // 3. Check Trigger Match
      if (rule.trigger !== triggerType) continue;

      // Validate trigger-specific configs (e.g. target status for transitions)
      if (rule.trigger === 'issue_transitioned' && rule.triggerConfig?.toStatus) {
        if (issue.fields.status?.name !== rule.triggerConfig.toStatus) continue;
      }

      // 4. Evaluate Conditions (Logical AND)
      const conditionsMet = (rule.conditions || []).every(cond => evaluateCondition(cond, issue));
      if (!conditionsMet) continue;

      // 5. Evaluate Decision Table (DMN)
      const decisionActions = evaluateDecisionTable(rule.decisionTable, issue);

      // 6. Execute Standard Rule Actions
      for (const action of (rule.actions || [])) {
        await executeAction(action, issue);
      }

      // 7. Execute Decision Table Outputs (if any actions were derived)
      for (const outAction of decisionActions) {
        await executeAction(outAction, issue);
      }
    }
  }
};

// --- Helper: Evaluate Conditions ---
function evaluateCondition(cond, issue) {
  const fields = issue.fields || {};
  let fieldValue;

  switch (cond.field) {
    case 'status': fieldValue = fields.status?.name; break;
    case 'priority': fieldValue = fields.priority?.name; break;
    case 'issueType': fieldValue = fields.issuetype?.name; break;
    case 'assignee': fieldValue = fields.assignee?.displayName; break;
    case 'labels': fieldValue = (fields.labels || []).join(','); break;
    case 'components': fieldValue = (fields.components || []).map(c => c.name).join(','); break;
    case 'customField': fieldValue = fields[cond.value]; break;
    default: fieldValue = '';
  }

  const valStr = String(fieldValue || '').toLowerCase();
  const condVal = String(cond.value || '').toLowerCase();

  switch (cond.operator) {
    case 'equals': return valStr === condVal;
    case 'not_equals': return valStr !== condVal;
    case 'contains': return valStr.includes(condVal);
    case 'not_contains': return !valStr.includes(condVal);
    case 'is_empty': return !fieldValue && fieldValue !== 0;
    case 'is_not_empty': return !!(fieldValue || fieldValue === 0);
    case 'greater_than': return parseFloat(valStr) > parseFloat(condVal);
    case 'less_than': return parseFloat(valStr) < parseFloat(condVal);
    default: return false;
  }
}

// --- Helper: Evaluate DMN Decision Table ---
function evaluateDecisionTable(table, issue) {
  if (!table || !table.rows) return [];
  const matchedRows = [];

  for (const row of table.rows) {
    let allInputsMatch = true;
    for (const input of table.inputs) {
      const condValue = row[input.id];
      if (!condValue) continue; // Empty cell matches all
      const mappedField = input.label.toLowerCase().replace(' ', '');
      const fakeCond = { field: mappedField, operator: 'equals', value: condValue };
      if (!evaluateCondition(fakeCond, issue)) {
        allInputsMatch = false;
        break;
      }
    }
    if (allInputsMatch) matchedRows.push(row);
  }

  // Handle Hit Policies
  if (table.hitPolicy === 'UNIQUE' && matchedRows.length > 1) return [];
  if (table.hitPolicy === 'ANY' && matchedRows.length > 1) {
    const outputsMatch = matchedRows.every((r, i, arr) =>
      table.outputs.every(out => r[out.id] === arr[0][out.id])
    );
    if (!outputsMatch) return [];
  }

  const actions = [];
  for (const row of matchedRows) {
    for (const output of table.outputs) {
      const outVal = row[output.id];
      if (outVal && output.label.toLowerCase().includes('action')) {
        if (outVal.toLowerCase().startsWith('transition:')) {
          actions.push({ type: 'transition', config: { value: outVal.split(':')[1].trim() } });
        } else if (outVal.toLowerCase().startsWith('assign:')) {
          actions.push({ type: 'assign_to', config: { value: outVal.split(':')[1].trim() } });
        } else {
          actions.push({ type: 'add_comment', config: { value: outVal } });
        }
      }
    }
    if (table.hitPolicy === 'FIRST') break;
  }
  return actions;
}

// --- Helper: Execute Actions via Jira API ---
async function executeAction(action, issue) {
  const issueKey = issue.key;
  const config = action.config || {};
  const value = config.value || '';

  try {
    switch (action.type) {
      case 'set_field': {
        const [field, val] = value.split(':').map(s => s.trim());
        if (field && val) {
          await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: { [field]: val } })
          });
        }
        break;
      }
      case 'transition': {
        const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/transitions`, { headers: { Accept: 'application/json' } });
        const data = await res.json();
        const target = data.transitions?.find(t => t.name.toLowerCase() === value.toLowerCase());
        if (target) {
          await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/transitions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transition: { id: target.id } })
          });
        }
        break;
      }
      case 'add_comment': {
        await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ text: value, type: "text" }] }] } })
        });
        break;
      }
      case 'assign_to': {
        await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/assignee`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: value })
        });
        break;
      }
      case 'add_label': {
        await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ update: { labels: [{ add: value }] } })
        });
        break;
      }
      case 'remove_label': {
        await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ update: { labels: [{ remove: value }] } })
        });
        break;
      }
      case 'create_issue': {
        const [proj, type, summary] = value.split('|').map(s => s.trim());
        if (proj && type && summary) {
          await api.asApp().requestJira(route`/rest/api/3/issue`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: { project: { key: proj }, issuetype: { name: type }, summary: summary } })
          });
        }
        break;
      }
      case 'webhook': {
        await fetch(value, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issueKey, issue }) }).catch(e => console.error(e));
        break;
      }
    }
  } catch (e) {
    console.error(`❌ Action ${action.type} failed for ${issueKey}:`, e.message);
  }
}

export { evaluateCondition, evaluateDecisionTable, executeAction };