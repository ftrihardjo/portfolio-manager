// Thin wrapper around gtag so call sites don't need optional-chaining
// everywhere and analytics failures can never break the actual feature.
// window.gtag is assigned in index.jsx once the Google tag loads.
export function trackEvent(name, params = {}) {
  try {
    if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
      window.gtag('event', name, params);
    }
  } catch {
    // Analytics must never throw into product code.
  }
}