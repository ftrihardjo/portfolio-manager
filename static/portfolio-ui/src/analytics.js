import ReactGA from 'react-ga4';

ReactGA.initialize(process.env.REACT_APP_GA_MEASUREMENT_ID);

// 🚀 PLG Event Taxonomy
export const Events = {
  // Activation (The "Aha!" moments)
  FIRST_DIAGRAM_SAVED: 'activation_first_diagram_saved',
  FIRST_RULE_CREATED: 'activation_first_rule_created',

  // Engagement & Power Features
  DIAGRAM_SAVED: 'engagement_diagram_saved',
  DIAGRAM_REVERTED: 'engagement_diagram_reverted',
  AUTOMATION_RULE_CREATED: 'engagement_rule_created',
  DECISION_TABLE_USED: 'engagement_decision_table_used',
  COMMIT_LEDGER_USED: 'engagement_commit_ledger_used',

  // Friction (Drop-off points to fix in the next sprint)
  SAVE_CONFLICT: 'friction_save_conflict',
  RULE_EXECUTION_FAILED: 'friction_rule_execution_failed',
};

let identifiedUser = null;

export const PLG = {
  identify: (user) => {
    if (!user || identifiedUser === user.accountId) return;
    identifiedUser = user.accountId;

    ReactGA.set({
      user_id: user.accountId,
      user_properties: {
        account_type: user.accountType || 'unknown',
        is_admin: user.isAdmin || false,
        locale: user.locale,
        timezone: user.timezone,
      },
    });
  },

  track: (eventName, properties = {}) => {
    ReactGA.event({
      category: properties.category || 'PLG',
      action: eventName,
      label: properties.label || '',
      value: properties.value || 1,
      ...properties,
    });

    console.log(`[PLG Track] ${eventName}`, properties);
  }
};