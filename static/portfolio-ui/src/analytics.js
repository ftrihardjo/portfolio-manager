import { invoke } from '@forge/bridge';

let clientId = localStorage.getItem('plg_cid');
if (!clientId) {
  clientId = `${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem('plg_cid', clientId);
}

// GA4 requires session_id + engagement_time_msec on Measurement Protocol
// events for them to be counted in Realtime/Active users reports — without
// these, GA accepts the hit but it won't show up as user activity anywhere.
// One session_id per tab/page-load is enough; sessionStorage clears itself
// when the tab closes, which is the behavior we want here.
let sessionId = sessionStorage.getItem('plg_sid');
if (!sessionId) {
  sessionId = `${Date.now()}`;
  sessionStorage.setItem('plg_sid', sessionId);
}
let lastEventAt = Date.now();

const send = (name, params) => {
  try {
    const now = Date.now();
    const engagementMs = Math.max(now - lastEventAt, 1);
    lastEventAt = now;
    const fullParams = {
      ...params,
      session_id: sessionId,
      engagement_time_msec: engagementMs,
    };
    Promise.resolve(invoke('trackPlgEvent', { name, params: fullParams, clientId })).catch(() => {});
  } catch { /* never break the UI */ }
};

export const Events = {
  FIRST_DIAGRAM_SAVED: 'activation_first_diagram_saved',
  FIRST_RULE_CREATED: 'activation_first_rule_created',
  DIAGRAM_SAVED: 'engagement_diagram_saved',
  DIAGRAM_REVERTED: 'engagement_diagram_reverted',
  AUTOMATION_RULE_CREATED: 'engagement_rule_created',
  DECISION_TABLE_USED: 'engagement_decision_table_used',
  COMMIT_LEDGER_USED: 'engagement_commit_ledger_used',
  SAVE_CONFLICT: 'friction_save_conflict',
  TAB_VIEWED: 'engagement_tab_viewed',
};

let identifiedUser = null;

export const PLG = {
  identify: (user) => {
    if (!user || identifiedUser === user.accountId) return;
    identifiedUser = user.accountId;
    send('plg_identify', {
      account_type: user.accountType || 'unknown',
      is_admin: !!user.isAdmin,
    });
  },
  track: (eventName, properties = {}) => send(eventName, properties),
};