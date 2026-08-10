export function trackEvent(name, params = {}) {
  try {
    window.__forgeInvoke?.('trackAnalyticsEvent', { name, params }).catch(() => {});
  } catch {}
}