import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { publish } from '@forge/realtime';

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

// ✅ FIXED
async function jiraPost(path, body) {
  const res = await api.asUser().requestJira(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jira ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

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

resolver.define('getProjectStats', async ({ payload }) => {
  const { projectKey } = payload;
  const base = `project = "${projectKey}"`;
  const [all, done, inProgress, overdueEpics, blockedData, earliestEpic, latestEpic] =
    await Promise.all([
      jiraPost('/rest/api/3/search/approximate-count', { jql: base }),
      jiraPost('/rest/api/3/search/approximate-count', { jql: `${base} AND statusCategory = Done` }),
      jiraPost('/rest/api/3/search/approximate-count', { jql: `${base} AND statusCategory = "In Progress"` }),
      jiraPost('/rest/api/3/search/approximate-count', { jql: `${base} AND issuetype = Epic AND duedate < now() AND statusCategory != Done` }),
      jiraGet('/rest/api/3/search/jql', { jql: base, maxResults: '100', fields: 'status,issuelinks' }),
      jiraGet('/rest/api/3/search/jql', { jql: `${base} AND issuetype = Epic AND cf[10015] is not EMPTY ORDER BY cf[10015] ASC`, maxResults: '1', fields: 'customfield_10015' }),
      jiraGet('/rest/api/3/search/jql', { jql: `${base} AND issuetype = Epic AND duedate is not EMPTY ORDER BY duedate DESC`, maxResults: '1', fields: 'duedate' }),
    ]);
  const total = all.count ?? 0;
  const blockedCount = (blockedData.issues || []).filter((i) =>
    (i.fields.issuelinks || []).some((l) =>
      l.type?.name === 'Blocks' && l.inwardIssue &&
      l.inwardIssue.fields?.status?.statusCategory?.key !== 'done'
    )).length;
  const overdueCount = overdueEpics.count ?? 0;
  const blockedRatio = total > 0 ? blockedCount / total : 0;
  const overdueComponent = Math.min(overdueCount, 3) / 3;
  const riskScore = Math.round(100 * (0.5 * blockedRatio + 0.5 * overdueComponent));
  return {
    total, done: done.count ?? 0, blocked: blockedCount,
    inProgress: inProgress.count ?? 0, overdueEpics: overdueCount, riskScore,
    startDate: earliestEpic.issues?.[0]?.fields?.customfield_10015 ?? null,
    dueDate: latestEpic.issues?.[0]?.fields?.duedate ?? null,
  };
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

resolver.define('getCurrentUser', async ({ context }) => ({
  accountId: context?.accountId ?? null,
}));

resolver.define('canEditProject', async ({ payload, context }) => {
  const { projectKey } = payload;
  const accountId = context?.accountId ?? null;
  if (!projectKey) return { canEdit: false };
  return { canEdit: await canEditProject(projectKey, accountId) };
});

resolver.define('getBpmnDiagrams', async () => (await kvs.get(BPMN_INDEX_KEY)) || []);

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

  // ★ REALTIME: Broadcast the save to all connected clients
  try {
    await publish(REALTIME_CHANNEL, {
      type: 'diagram:saved',
      diagramId: id,
      version,
      versionName: vName,
      savedAt: now,
      savedBy: accountId,
      savedByDisplay: editorDisplay,
      projectKey,
    });
  } catch (e) {
    console.error('Realtime publish failed (non-fatal):', e);
  }

  return record;
});

resolver.define('deleteBpmnDiagram', async ({ payload, context }) => {
  const { diagramId } = payload;
  const accountId = context?.accountId ?? null;
  const diagram = await kvs.get(bpmnDiagramKey(diagramId));
  if (!diagram) return { deleted: false };
  if (!(await canEditProject(diagram.projectKey, accountId))) {
    throw new Error('You need edit permission on this project to delete this diagram.');
  }
  await kvs.delete(bpmnDiagramKey(diagramId));
  const index = (await kvs.get(BPMN_INDEX_KEY)) || [];
  await kvs.set(BPMN_INDEX_KEY, index.filter((d) => d.id !== diagramId));

  // ★ REALTIME: Broadcast deletion
  try {
    await publish(REALTIME_CHANNEL, {
      type: 'diagram:deleted',
      diagramId,
      deletedBy: accountId,
    });
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

  return { saved: true, count: rules.length };
});

export const handler = resolver.getDefinitions();