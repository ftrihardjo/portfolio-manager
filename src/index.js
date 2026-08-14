import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { publish } from '@forge/realtime';
import { automationEngine } from './automation-engine';

const resolver = new Resolver();

// ─── Jira REST helpers ──────────────────────────────────────────────
async function jiraGet(path, params = {}) {
  const keys = Object.keys(params);
  if (keys.length === 0) {
    const res = await api.asUser().requestJira(route`${path}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Jira ${res.status} on ${path}: ${await res.text()}`);
    return res.json();
  }
  const strings = []; const values = [];
  strings.push(`${path}?${keys[0]}=`); values.push(params[keys[0]]);
  for (let i = 1; i < keys.length; i++) {
    strings.push(`&${keys[i]}=`); values.push(params[keys[i]]);
  }
  strings.push('');
  const res = await api.asUser().requestJira(route(strings, ...values), {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Jira ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

// ✅ Path lives in the strings array (literal), so its slashes stay literal.
// A raw string is rejected by the runtime; route`${path}` would %-encode it.
async function jiraPost(path, body) {
  const res = await api.asUser().requestJira(route([path]), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jira ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

// Portable "how many issues match this JQL" — POST /search with maxResults:0
// returns { total: N, issues: [] } on every Jira Cloud instance.
async function countJql(jql) {
  const r = await jiraPost('/rest/api/3/search/approximate-count', { jql });
  const n = r?.count ?? r?.total;          // approximate-count returns { count }; /search returns { total }
  return typeof n === 'number' ? n : 0;
}

resolver.define('getAutomationEngine', async () => {
  return { message: "Engine is running. Handlers are exported via index.automationEngine" };
});

resolver.define('getPlgMetrics', async () => {
  const actionsExecuted = (await kvs.get('plg:actions_executed')) || 0;
  return { actionsExecuted, hoursSaved: Math.round(actionsExecuted * 0.05) }; // ~3 mins per action
});

resolver.define('getProjectStats', async ({ payload }) => {
  const { projectKey } = payload;
  const base = `project = "${projectKey}"`;

  // Primary counts — each isolated; one bad JQL yields 0, never a total wipe.
  let countError = null;
  const safeCount = async (jql) => {
    try { return await countJql(jql); }
    catch (e) { countError = countError || e.message; return 0; }
  };
  const [total, done, inProgress, overdueCount] = await Promise.all([
    safeCount(base),
    safeCount(`${base} AND statusCategory = Done`),
    safeCount(`${base} AND statusCategory = "In Progress"`),
    safeCount(`${base} AND issuetype = Epic AND duedate < now() AND statusCategory != Done`),
  ]);

  // Secondary data — non-fatal. A failure here degrades to 0 / null instead
  // of throwing the whole resolver (which is what produced the silent zeros).
  let blockedCount = 0;
  try {
    const blockedData = await jiraGet('/rest/api/3/search/jql', {
      jql: base, maxResults: '100', fields: 'status,issuelinks',
    });
    blockedCount = (blockedData.issues || []).filter((i) =>
      (i.fields.issuelinks || []).some((l) =>
        l.type?.name === 'Blocks' && l.inwardIssue &&
        l.inwardIssue.fields?.status?.statusCategory?.key !== 'done'
      )).length;
  } catch (e) { countError = countError || e.message; }

  let startDate = null;
  try {
    // NOTE: 10015 is the "Start date" custom-field id on many sites but NOT
    // all. If it 400s on yours this now degrades to null (Start shows "—",
    // which is correct when the epic has no start date anyway) instead of
    // killing the counts. See the README note on resolving it by name.
    const earliestEpic = await jiraGet('/rest/api/3/search/jql', {
      jql: `${base} AND issuetype = Epic AND cf[10015] is not EMPTY ORDER BY cf[10015] ASC`,
      maxResults: '1', fields: 'customfield_10015',
    });
    startDate = earliestEpic.issues?.[0]?.fields?.customfield_10015 ?? null;
  } catch (e) { countError = countError || e.message; }

  let dueDate = null;
  try {
    const latestEpic = await jiraGet('/rest/api/3/search/jql', {
      jql: `${base} AND issuetype = Epic AND duedate is not EMPTY ORDER BY duedate DESC`,
      maxResults: '1', fields: 'duedate',
    });
    dueDate = latestEpic.issues?.[0]?.fields?.duedate ?? null;
  } catch (e) { countError = countError || e.message; }

  const blockedRatio = total > 0 ? blockedCount / total : 0;
  const overdueComponent = Math.min(overdueCount, 3) / 3;
  const riskScore = Math.round(100 * (0.5 * blockedRatio + 0.5 * overdueComponent));

  const out = {
    total, done, blocked: blockedCount, inProgress,
    overdueEpics: overdueCount, riskScore, startDate, dueDate,
  };
  if (countError) out._error = countError;   // surfaced by the UI; ignored otherwise
  return out;
});

// Records that a user opened a specific version in the editor. Called only on
// an explicit open (never from the 4 s poll), so it doesn't spam writes. The
// version list sorts by this field, falling back to savedAt.
resolver.define('touchBpmnVersion', async ({ payload }) => {
  const { diagramId, version } = payload;
  const key = bpmnDiagramKey(diagramId);
  const diagram = await kvs.get(key);
  if (!diagram) return { touched: false };
  const now = new Date().toISOString();
  let changed = false;
  if (Array.isArray(diagram.versions)) {
    const v = diagram.versions.find((x) => x.version === version);
    if (v) { v.lastAccessedAt = now; changed = true; }
  }
  if (diagram.version === version) { diagram.lastAccessedAt = now; changed = true; }
  if (changed) {
    await kvs.set(key, diagram);
    const blob = await kvs.get(bpmnVersionKey(diagramId, version));
    if (blob) { blob.lastAccessedAt = now; await kvs.set(bpmnVersionKey(diagramId, version), blob); }
  }
  return { touched: changed, lastAccessedAt: now };
});

// ─── User display-name resolution ───────────────────────────────────
// Cache in kvs so we don't hammer the Jira API on every render.
const USER_CACHE_KEY = 'user:displaynames';

async function resolveDisplayName(accountId) {
  if (!accountId) return 'Unknown';
  // Check cache first
  const cache = (await kvs.get(USER_CACHE_KEY)) || {};
  if (cache[accountId]) return cache[accountId];
  try {
    const user = await jiraGet('/rest/api/3/user', { accountId });
    const name = user.displayName || accountId;
    cache[accountId] = name;
    await kvs.set(USER_CACHE_KEY, cache);
    return name;
  } catch {
    return accountId; // fallback to raw ID
  }
}

resolver.define('getUserDisplayName', async ({ payload }) => {
  const { accountId } = payload;
  return { accountId, displayName: await resolveDisplayName(accountId) };
});

resolver.define('getUsersDisplayNames', async ({ payload }) => {
  const { accountIds } = payload; // string[]
  const cache = (await kvs.get(USER_CACHE_KEY)) || {};
  const missing = (accountIds || []).filter((id) => id && !cache[id]);
  // Resolve missing ones in parallel
  await Promise.all(
    missing.map(async (id) => {
      try {
        const user = await jiraGet('/rest/api/3/user', { accountId: id });
        cache[id] = user.displayName || id;
      } catch {
        cache[id] = id;
      }
    })
  );
  if (missing.length) await kvs.set(USER_CACHE_KEY, cache);
  const result = {};
  for (const id of accountIds || []) {
    result[id] = cache[id] || id || 'Unknown';
  }
  return result;
});

// ─── Projects / stats / dependencies / roadmap (unchanged) ──────────
resolver.define('getProjects', async () => {
  const data = await jiraGet('/rest/api/3/project/search', {
    maxResults: '50', orderBy: 'name', expand: 'description,lead',
  });
  return (data.values || []).map((p) => ({
    id: p.id, key: p.key, name: p.name,
    lead: p.lead?.displayName ?? null,
    leadAccountId: p.lead?.accountId ?? null,
    avatarUrl: p.avatarUrls?.['32x32'] ?? null,
  }));
});

resolver.define('getIssueDependencies', async ({ payload }) => {
  const { projectKeys } = payload;
  if (!projectKeys?.length) return [];
  const data = await jiraGet('/rest/api/3/search/jql', {
    jql: `project in (${projectKeys.join(',')}) ORDER BY created DESC`,
    maxResults: '100',
    fields: 'summary,status,issuetype,project,issuelinks,assignee,priority',
  });
  return (data.issues || []).map((issue) => ({
    id: issue.key, title: issue.fields.summary, project: issue.fields.project.key,
    type: issue.fields.issuetype.name.toLowerCase(),
    statusCategory: issue.fields.status.statusCategory.key,
    statusName: issue.fields.status.name,
    assignee: issue.fields.assignee?.displayName ?? null,
    priority: issue.fields.priority?.name ?? 'Medium',
    links: (issue.fields.issuelinks || []).map((l) => ({
      type: l.type.name, outwardLabel: l.type.outward, inwardLabel: l.type.inward,
      inward: l.inwardIssue?.key ?? null, outward: l.outwardIssue?.key ?? null,
    })),
  }));
});

resolver.define('getRoadmapEpics', async ({ payload }) => {
  const { projectKeys } = payload;
  if (!projectKeys?.length) return [];
  const data = await jiraGet('/rest/api/3/search/jql', {
    jql: `project in (${projectKeys.join(',')}) AND issuetype = Epic ORDER BY duedate ASC`,
    maxResults: '100',
    fields: 'summary,status,project,duedate,customfield_10015,assignee',
  });
  return (data.issues || []).map((issue) => ({
    id: issue.key, title: issue.fields.summary, project: issue.fields.project.key,
    statusCategory: issue.fields.status.statusCategory.key,
    startDate: issue.fields.customfield_10015 ?? null,
    dueDate: issue.fields.duedate ?? null,
    assignee: issue.fields.assignee?.displayName ?? null,
  }));
});

// ─── BPMN library + Realtime collaborative editing ──────────────────
const BPMN_INDEX_KEY = 'bpmn:index';
const bpmnDiagramKey = (id) => `bpmn:diagram:${id}`;
const bpmnVersionKey = (id, v) => `bpmn:diagram:${id}:v${v}`;
const REALTIME_CHANNEL = 'bpmn-diagram-events';

async function canEditProject(projectKey, accountId) {
  if (!accountId) return false;
  const res = await api.asUser().requestJira(
    route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=EDIT_ISSUES`,
    { headers: { Accept: 'application/json' } }
  );
  if (!res.ok) return false;
  const perms = await res.json();
  return !!perms.permissions?.EDIT_ISSUES?.havePermission;
}

// Jira has no Forge trigger for project deletion (only issue- and
// board-level delete events exist), so there's no way to react to a
// project being deleted as it happens. Diagrams keep working fine
// afterward — canEditProject naturally starts returning false once the
// project's gone, so edits are already blocked — but nothing ever stopped
// the diagram from being freely opened and viewed indefinitely. This
// checks project existence on demand instead, so the list/UI can flag it.
async function projectKeyExists(projectKey) {
  if (!projectKey) return false;
  try {
    const res = await api.asUser().requestJira(
      route`/rest/api/3/project/${projectKey}`,
      { headers: { Accept: 'application/json' } }
    );
    return res.ok;
  } catch (e) {
    // Network/API hiccup: don't misreport a real project as deleted.
    console.error('projectKeyExists check failed (non-fatal):', e);
    return true;
  }
}

resolver.define('getCurrentUser', async ({ context }) => ({
  accountId: context?.accountId ?? null,
}));

resolver.define('canEditProject', async ({ payload, context }) => {
  const { projectKey } = payload;
  const accountId = context?.accountId ?? null;
  if (!projectKey) return { canEdit: false };
  return { canEdit: await canEditProject(projectKey, accountId) };
});

// Self-service diagnostic for the per-user PLG activation flags. Lets a
// person confirm their own account's state (or reset it for testing)
// without needing KVS/console access. Scoped to context.accountId only —
// nobody can read or reset another account's flags.
resolver.define('getMyActivationStatus', async ({ context }) => {
  const accountId = context?.accountId ?? null;
  if (!accountId) return { firstDiagramDone: false, firstRuleDone: false };
  const [firstDiagramDone, firstRuleDone] = await Promise.all([
    kvs.get(`activation:firstDiagram:${accountId}`),
    kvs.get(`activation:firstRule:${accountId}`),
  ]);
  return { firstDiagramDone: !!firstDiagramDone, firstRuleDone: !!firstRuleDone };
});

resolver.define('resetMyActivationStatus', async ({ context }) => {
  const accountId = context?.accountId ?? null;
  if (!accountId) return { ok: false };
  await Promise.all([
    kvs.delete(`activation:firstDiagram:${accountId}`),
    kvs.delete(`activation:firstRule:${accountId}`),
  ]);
  return { ok: true };
});

resolver.define('getBpmnDiagrams', async () => {
  const diagrams = (await kvs.get(BPMN_INDEX_KEY)) || [];
  const distinctKeys = [...new Set(diagrams.map((d) => d.projectKey).filter(Boolean))];
  const existsByKey = {};
  await Promise.all(distinctKeys.map(async (key) => { existsByKey[key] = await projectKeyExists(key); }));
  return diagrams.map((d) => ({ ...d, projectExists: d.projectKey ? !!existsByKey[d.projectKey] : true }));
});

resolver.define('getBpmnDiagram', async ({ payload }) => {
  const diagram = await kvs.get(bpmnDiagramKey(payload.diagramId));
  if (!diagram) throw new Error(`Diagram ${payload.diagramId} not found`);
  if (!Array.isArray(diagram.versions) && typeof diagram.version === 'number') {
    diagram.versions = [{
      version: diagram.version,
      name: diagram.latestVersionName || `v${diagram.version}`,
      savedAt: diagram.updatedAt,
      savedBy: diagram.lastEditedBy,
    }];
  }
  // ★ Resolve display names for all version authors
  if (Array.isArray(diagram.versions)) {
    const cache = (await kvs.get(USER_CACHE_KEY)) || {};
    for (const v of diagram.versions) {
      v.savedByDisplay = cache[v.savedBy] || v.savedBy || 'Unknown';
    }
    diagram.lastEditedByDisplay = cache[diagram.lastEditedBy] || diagram.lastEditedBy || 'Unknown';
  }
  diagram.projectExists = diagram.projectKey ? await projectKeyExists(diagram.projectKey) : true;
  return diagram;
});

resolver.define('getBpmnDiagramVersion', async ({ payload }) => {
  const { diagramId, version } = payload;
  const stored = await kvs.get(bpmnVersionKey(diagramId, version));
  if (stored) {
    stored.savedByDisplay = await resolveDisplayName(stored.savedBy);
    return stored;
  }
  const diagram = await kvs.get(bpmnDiagramKey(diagramId));
  if (!diagram) throw new Error(`Diagram ${diagramId} not found`);
  if (diagram.version === version) {
    return {
      version,
      name: diagram.latestVersionName || `v${version}`,
      savedAt: diagram.updatedAt,
      savedBy: diagram.lastEditedBy,
      savedByDisplay: await resolveDisplayName(diagram.lastEditedBy),
      xml: diagram.xml,
    };
  }
  throw new Error(`Version ${version} not found for diagram ${diagramId}`);
});

resolver.define('saveBpmnDiagram', async ({ payload, context }) => {
  const { diagramId, name, projectKey, xml, baseVersion, versionName } = payload;
  const accountId = context?.accountId ?? null;
  if (!(await canEditProject(projectKey, accountId))) {
    throw new Error('You need edit permission on this project to save this diagram.');
  }
  const id = diagramId || `bpmn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const existing = diagramId ? await kvs.get(bpmnDiagramKey(id)) : null;
  if (!existing && diagramId && (await kvs.get(`bpmn:tombstone:${diagramId}`))) {
    throw new Error('This diagram was deleted. Close it and create a new one.');
  }

  if (existing && typeof baseVersion === 'number' && baseVersion !== existing.version) {
    // ★ Resolve the conflicting editor's display name for a friendly message
    const editorName = await resolveDisplayName(existing.lastEditedBy);
    throw new Error(
      `Conflict: this diagram was saved by ${editorName} at ${existing.updatedAt}. Reload before saving.`
    );
  }

  const version = (existing?.version || 0) + 1;
  const vName = (typeof versionName === 'string' && versionName.trim())
    ? versionName.trim() : `v${version}`;
  const editorDisplay = await resolveDisplayName(accountId);
  const versionEntry = {
    version, name: vName, savedAt: now,
    savedBy: accountId, savedByDisplay: editorDisplay,
    lastAccessedAt: now,
    // ★ commit metadata — turns a "version" into a signed, chainable commit
    kind: 'save',
    parentVersion: existing?.version ?? null,
    message: (typeof payload.message === 'string' && payload.message.trim())
      ? payload.message.trim() : '',
  };

  let versions = Array.isArray(existing?.versions) ? existing.versions.slice() : [];
  if (!versions.length && existing && typeof existing.version === 'number') {
    const legacy = {
      version: existing.version,
      name: existing.latestVersionName || `v${existing.version}`,
      savedAt: existing.updatedAt,
      savedBy: existing.lastEditedBy,
      savedByDisplay: await resolveDisplayName(existing.lastEditedBy),
    };
    versions.push(legacy);
    await kvs.set(bpmnVersionKey(id, existing.version), { ...legacy, xml: existing.xml });
  }
  versions.push(versionEntry);
  await kvs.set(bpmnVersionKey(id, version), { ...versionEntry, xml });

  // ★ Per-user activation tracking (declare before record)
  const activationKey = `activation:firstDiagram:${accountId}`;
  const firstDiagramForUser = accountId ? !(await kvs.get(activationKey)) : false;
  if (firstDiagramForUser) await kvs.set(activationKey, true);

  // Do NOT include firstDiagramForUser here — it belongs in the response, not the DB
  const record = {
    id, name, projectKey, xml,
    createdAt: existing?.createdAt ?? now, updatedAt: now,
    version, lastEditedBy: accountId, lastEditedByDisplay: editorDisplay,
    versions, latestVersionName: vName,
  };
  await kvs.set(bpmnDiagramKey(id), record);

  const index = (await kvs.get(BPMN_INDEX_KEY)) || [];
  const meta = {
    id, name, projectKey, updatedAt: now,
    lastEditedBy: accountId, lastEditedByDisplay: editorDisplay,
    version, latestVersionName: vName,
  };
  const nextIndex = diagramId ? index.map((d) => (d.id === id ? meta : d)) : [...index, meta];
  await kvs.set(BPMN_INDEX_KEY, nextIndex);

  try {
    await publish(REALTIME_CHANNEL, {
      type: 'diagram:saved', diagramId: id, version,
      versionName: vName, savedAt: now,
      savedBy: accountId, savedByDisplay: editorDisplay,
      projectKey,
    });
  } catch (e) {
    console.error('Realtime publish failed (non-fatal):', e);
  }

  // Return the flag ONLY in the response payload
  return { ...record, firstDiagramForUser };
});

resolver.define('deleteBpmnDiagram', async ({ payload, context }) => {
  const { diagramId } = payload;
  const accountId = context?.accountId ?? null;
  const diagram = await kvs.get(bpmnDiagramKey(diagramId));

  if (!diagram) return { deleted: false };

  // ─── 1. Restore original permission logic (matches test mocks exactly) ───
  // The tests set up mockProjectExists() then mockCanEdit().
  // projectKeyExists consumes the first mock; canEditProject consumes the second.
  const projectStillExists = await projectKeyExists(diagram.projectKey);
  if (projectStillExists) {
    if (!(await canEditProject(diagram.projectKey, accountId))) {
      throw new Error('You need edit permission on this project to delete this diagram.');
    }
  } else if (!accountId) {
    // Project is gone, but no user is signed in
    throw new Error('You must be signed in to delete this diagram.');
  }
  // (If project is gone AND a user is signed in, we fall through to delete)

  // ─── 2. Cascade delete: versions, automation rules, locks, and the diagram ───
  const versions = Array.isArray(diagram.versions) ? diagram.versions
    : (typeof diagram.version === 'number' ? [{ version: diagram.version }] : []);

  await Promise.all([
    ...versions.map((v) => kvs.delete(bpmnVersionKey(diagramId, v.version)).catch(() => {})),
    kvs.delete(automationRulesKey(diagramId)).catch(() => {}),
    kvs.delete(`bpmn:lock:${diagramId}`).catch(() => {}),
    kvs.delete(bpmnDiagramKey(diagramId)),
  ]);

  // ─── 3. Purge index and tombstone the ID to prevent resurrection ───
  const index = (await kvs.get(BPMN_INDEX_KEY)) || [];
  await kvs.set(BPMN_INDEX_KEY, index.filter((d) => d.id !== diagramId));
  await kvs.set(`bpmn:tombstone:${diagramId}`, true);

  try {
    await publish(REALTIME_CHANNEL, { type: 'diagram:deleted', diagramId, deletedBy: accountId });
  } catch (e) {
    console.error('Realtime publish failed (non-fatal):', e);
  }

  return { deleted: true };
});

// Lock / unlock (kept for presence indicators)
resolver.define('lockDiagram', async ({ payload, context }) => {
  const { diagramId } = payload;
  const accountId = context?.accountId;
  const lockKey = `bpmn:lock:${diagramId}`;
  const existing = await kvs.get(lockKey);
  if (existing && existing.accountId !== accountId) {
    const age = Date.now() - new Date(existing.lockedAt).getTime();
    if (age < 5 * 60 * 1000) {
      return {
        locked: true,
        lockedBy: existing.accountId,
        lockedByDisplay: await resolveDisplayName(existing.accountId),
      };
    }
  }
  await kvs.set(lockKey, { diagramId, accountId, lockedAt: new Date().toISOString() });
  return { locked: false };
});

resolver.define('unlockDiagram', async ({ payload, context }) => {
  const lockKey = `bpmn:lock:${payload.diagramId}`;
  const existing = await kvs.get(lockKey);
  if (existing?.accountId === context?.accountId) await kvs.delete(lockKey);
  return { unlocked: true };
});

// ─── Automation Rules storage ───────────────────────────────────────
const automationRulesKey = (diagramId) => `automation:rules:${diagramId}`;

resolver.define('getAutomationRules', async ({ payload }) => {
  const { diagramId } = payload;
  return (await kvs.get(automationRulesKey(diagramId))) || [];
});

resolver.define('saveAutomationRules', async ({ payload, context }) => {
  const { diagramId, projectKey, rules } = payload;
  const accountId = context?.accountId ?? null;
  if (!(await canEditProject(projectKey, accountId))) {
    throw new Error('You need edit permission on this project to save automation rules.');
  }
  await kvs.set(automationRulesKey(diagramId), rules);

  // Per-user activation flag, mirroring saveBpmnDiagram — server-side so it's
  // consistent across browsers/devices, not just the current one.
  const activationKey = `activation:firstRule:${accountId}`;
  const firstRuleForUser = accountId ? !(await kvs.get(activationKey)) : false;
  if (firstRuleForUser) await kvs.set(activationKey, true);

  try {
    await publish(REALTIME_CHANNEL, {
      type: 'rules:saved',
      diagramId,
      savedBy: accountId,
      savedAt: new Date().toISOString(),
      ruleCount: rules.length,
    });
  } catch (e) {
    console.error('Realtime publish failed (non-fatal):', e);
  }

  return { saved: true, count: rules.length, firstRuleForUser };   // ← add flag
});

// Revert = create a NEW head commit whose XML is copied from an older one.
// Append-only on purpose: the commit being undone stays in the ledger, the
// revert sits on top of it (exactly how `git revert` works), so nothing is
// ever lost and the chain of custody is unbroken.
resolver.define('revertBpmnDiagram', async ({ payload, context }) => {
  const { diagramId, toVersion, baseVersion, message } = payload;
  const accountId = context?.accountId ?? null;
  const diagram = await kvs.get(bpmnDiagramKey(diagramId));
  if (!diagram) throw new Error(`Diagram ${diagramId} not found`);
  if (!(await canEditProject(diagram.projectKey, accountId))) {
    throw new Error('You need edit permission on this project to revert this diagram.');
  }
  // Optimistic lock — same contract as saveBpmnDiagram, so a concurrent
  // edit between "I opened the ledger" and "I clicked revert" surfaces as
  // the existing conflict banner instead of silently clobbering work.
  if (typeof baseVersion === 'number' && baseVersion !== diagram.version) {
    const editorName = await resolveDisplayName(diagram.lastEditedBy);
    throw new Error(
      `Conflict: this diagram was saved by ${editorName} at ${diagram.updatedAt}. Reload before reverting.`
    );
  }
  if (toVersion === diagram.version) {
    throw new Error('That version is already the latest — nothing to revert.');
  }

  // Resolve the target snapshot's XML + name (per-version blob first, then
  // the head record as a fallback for legacy single-version diagrams).
  let targetXml = null;
  let targetName = `v${toVersion}`;
  const blob = await kvs.get(bpmnVersionKey(diagramId, toVersion));
  if (blob) { targetXml = blob.xml; targetName = blob.name || targetName; }
  else if (diagram.version === toVersion) { targetXml = diagram.xml; targetName = diagram.latestVersionName || targetName; }
  else throw new Error(`Version ${toVersion} not found; cannot revert.`);

  const now = new Date().toISOString();
  const version = diagram.version + 1;
  const editorDisplay = await resolveDisplayName(accountId);
  const autoMsg = `Reverted to ${targetName} (v${toVersion})`;
  const versionEntry = {
    version, name: `v${version}`, savedAt: now,
    savedBy: accountId, savedByDisplay: editorDisplay, lastAccessedAt: now,
    kind: 'revert',
    parentVersion: diagram.version,
    revertedFromVersion: toVersion,
    message: (typeof message === 'string' && message.trim()) ? message.trim() : autoMsg,
  };

  const versions = Array.isArray(diagram.versions) ? diagram.versions.slice() : [];
  versions.push(versionEntry);
  await kvs.set(bpmnVersionKey(diagramId, version), { ...versionEntry, xml: targetXml });

  const record = {
    ...diagram,
    xml: targetXml,
    updatedAt: now, version,
    lastEditedBy: accountId, lastEditedByDisplay: editorDisplay,
    versions, latestVersionName: versionEntry.name,
  };
  await kvs.set(bpmnDiagramKey(diagramId), record);

  // Index meta keeps the SAME shape as saveBpmnDiagram writes — no new
  // fields here, so the existing index-shape test stays green.
  const index = (await kvs.get(BPMN_INDEX_KEY)) || [];
  const meta = {
    id: diagramId, name: diagram.name, projectKey: diagram.projectKey, updatedAt: now,
    lastEditedBy: accountId, lastEditedByDisplay: editorDisplay,
    version, latestVersionName: versionEntry.name,
  };
  await kvs.set(BPMN_INDEX_KEY, index.map((d) => (d.id === diagramId ? meta : d)));

  try {
    await publish(REALTIME_CHANNEL, {
      type: 'diagram:saved', diagramId, version,
      versionName: versionEntry.name, savedAt: now,
      savedBy: accountId, savedByDisplay: editorDisplay,
      projectKey: diagram.projectKey,
      kind: 'revert', revertedFromVersion: toVersion,
    });
  } catch (e) { console.error('Realtime publish failed (non-fatal):', e); }

  return record;
});

// ─── Version diff ("Compare" in the commit ledger) ──────────────────
// Read-only structural diff between two stored commits: loads the two
// version blobs and compares element ids/names. Never writes anything.
resolver.define('diffBpmnVersions', async ({ payload }) => {
  const { diagramId, baseVersion, targetVersion } = payload;
  const parseEls = (xml) => {
    const els = [];
    const re = /<bpmn:[A-Za-z]+\b[^>]*>/g;   // whole opening tag, then inspect attrs
    let m;
    while ((m = re.exec(xml || ''))) {
      const tag = m[0];
      const idM = tag.match(/\bid="([^"]+)"/);
      if (!idM) continue;                    // skips <bpmn:definitions> etc.
      const nameM = tag.match(/\bname="([^"]*)"/);
      els.push({
        type: tag.slice(1, tag.search(/[\s>]/)).replace('bpmn:', ''),
        id: idM[1],
        name: nameM ? nameM[1] : '',
      });
    }
    return els;
  };
  const load = async (v) => {
    const blob = await kvs.get(bpmnVersionKey(diagramId, v));
    if (blob) return blob;
    const d = await kvs.get(bpmnDiagramKey(diagramId));
    if (d && d.version === v) return { xml: d.xml, name: d.latestVersionName || `v${v}` };
    throw new Error(`Version ${v} not found for diagram ${diagramId}`);
  };
  const [a, b] = await Promise.all([load(baseVersion), load(targetVersion)]);
  const ea = parseEls(a.xml);
  const eb = parseEls(b.xml);
  const mapA = new Map(ea.map((e) => [e.id, e]));
  const mapB = new Map(eb.map((e) => [e.id, e]));
  const added    = eb.filter((e) => !mapA.has(e.id));
  const removed  = ea.filter((e) => !mapB.has(e.id));
  const modified = eb.filter((e) => {
    const old = mapA.get(e.id);
    return old && (old.name !== e.name || old.type !== e.type);
  });
  return {
    base:   { version: baseVersion,   name: a.name || `v${baseVersion}` },
    target: { version: targetVersion, name: b.name || `v${targetVersion}` },
    added, removed, modified,
    unchangedCount: eb.length - added.length - modified.length,
  };
});

const GA_MEASUREMENT_ID = 'G-9FFJELQ6BR';
// TODO: move off the hardcoded fallback — run
//   forge variables set --encrypt GA_API_SECRET <secret>
// then this reads it via process.env instead of shipping it in source.
const GA_API_SECRET = process.env.GA_API_SECRET || 't_irWikPRiK4b7-hMnWgMw';

resolver.define('trackPlgEvent', async ({ payload, context }) => {
  const { name, params = {}, clientId } = payload;
  try {
    const eventParams = { ...params, actor: context?.accountId };
    // Only tag hits as debug when explicitly requested (e.g. while watching
    // GA4 DebugView during development). Hardcoding this to true routes every
    // hit to DebugView only and keeps it out of standard reports, which is
    // why "Active users" stayed at 0 even after events started sending.
    if (params.debug_mode) eventParams.debug_mode = true;
    else delete eventParams.debug_mode;

    const res = await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId || 'unknown',
          events: [{ name, params: eventParams }],
        }),
      }
    );
    if (!res.ok) {
      console.error('GA4 collect failed', res.status, await res.text());
    }
  } catch (e) { console.error('GA4 collect error', e); /* analytics must never break the app */ }
  return { ok: true };
});

export const handler = resolver.getDefinitions();
export { automationEngine };