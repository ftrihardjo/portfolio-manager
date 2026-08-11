import { invoke } from '@forge/bridge';

let clientId = localStorage.getItem('plg_cid');
if (!clientId) {
  clientId = `${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem('plg_cid', clientId);
}

const send = (name, params) => {
  try {
    Promise.resolve(invoke('trackPlgEvent', { name, params, clientId })).catch(() => {});
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