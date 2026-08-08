// static/portfolio-ui/src/analytics.js
import ReactGA from 'react-ga4';

// ⚠️ Vite build: env vars come from import.meta.env and MUST be VITE_-prefixed.
// Referencing process.env here crashes the browser bundle (blank page).
const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID;

if (GA_ID) {
  ReactGA.initialize(GA_ID);
}

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
    if (!GA_ID) return;
    ReactGA.set({
      user_id: user.accountId,
      user_properties: {
        account_type: user.accountType || 'unknown',
        is_admin: !!user.isAdmin,
        locale: user.locale,
        timezone: user.timezone,
      },
    });
  },

  track: (eventName, properties = {}) => {
    if (import.meta.env.DEV) {
      console.log(`[PLG Track] ${eventName}`, properties);
    }
    if (!GA_ID) return; // not configured → skip GA, keep dev logs
    ReactGA.event({
      category: properties.category || 'PLG',
      action: eventName,
      label: properties.label || '',
      value: properties.value || 1,
      ...properties,
    });
  },
};