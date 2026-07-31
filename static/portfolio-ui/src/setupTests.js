import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// @forge/bridge requires the Custom UI bridge that only exists inside
// the Atlassian product iframe. Mock it globally here so test files can
// import { invoke, router } from '@forge/bridge' without crashing on load.
vi.mock('@forge/bridge', () => ({
  invoke: vi.fn(),
  router: {
    open: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(undefined),
    getUrl: vi.fn().mockResolvedValue(new URL('https://example.atlassian.net/')),
    reload: vi.fn(),
  },
}));

// Alias `jest` -> `vi` so the existing jest.mock / jest.fn calls
// in your test files still resolve.
globalThis.jest = vi;
