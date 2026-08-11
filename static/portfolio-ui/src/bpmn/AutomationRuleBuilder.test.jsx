import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AutomationRuleBuilder from './AutomationRuleBuilder';
import { Events } from '../analytics';

const invokeMock = vi.fn();
vi.mock('@forge/bridge', () => ({ invoke: (...a) => invokeMock(...a) }));

const store = {};
const tracked = () =>
  invokeMock.mock.calls.filter(([cmd]) => cmd === 'trackPlgEvent').map(([, p]) => p.name);

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
  Object.keys(store).forEach((k) => delete store[k]);
  invokeMock.mockImplementation(async (cmd, payload = {}) => {
    switch (cmd) {
      case 'getAutomationRules': return store[payload.diagramId] || [];
      case 'saveAutomationRules':
        store[payload.diagramId] = payload.rules;
        return { saved: true, count: payload.rules.length };
      default: return { ok: true };
    }
  });
});

const props = { diagramId: 'd1', projectKey: 'OPS', canEdit: true };

describe('AutomationRuleBuilder PLG + persistence', () => {
  it('fires rule_created events only after a successful save', async () => {
    render(<AutomationRuleBuilder {...props} />);
    fireEvent.click(await screen.findByTestId('add-rule'));
    fireEvent.click(screen.getByTestId('save-rules'));

    await waitFor(() => expect(store.d1).toHaveLength(1));
    await waitFor(() => {
      expect(tracked()).toContain(Events.AUTOMATION_RULE_CREATED);
      expect(tracked()).toContain(Events.FIRST_RULE_CREATED);
    });
  });

  it('fires no PLG events when the save fails', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'saveAutomationRules') throw new Error('boom');
      if (cmd === 'getAutomationRules') return [];
      return { ok: true };
    });
    render(<AutomationRuleBuilder {...props} />);
    fireEvent.click(await screen.findByTestId('add-rule'));
    fireEvent.click(screen.getByTestId('save-rules'));

    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy());
    expect(tracked()).not.toContain(Events.AUTOMATION_RULE_CREATED);
  });

  it('keeps saved rules across unmount/remount (tab switch)', async () => {
    const view = render(<AutomationRuleBuilder {...props} />);
    fireEvent.click(await screen.findByTestId('add-rule'));
    fireEvent.click(screen.getByTestId('save-rules'));
    await waitFor(() => expect(store.d1).toHaveLength(1));
    view.unmount();

    render(<AutomationRuleBuilder {...props} />);
    expect(await screen.findAllByText('Untitled Rule')).toHaveLength(1);
  });

  it('restores an unsaved draft when returning without saving', async () => {
    const view = render(<AutomationRuleBuilder {...props} />);
    fireEvent.click(await screen.findByTestId('add-rule'));
    await waitFor(() => expect(localStorage.getItem('automation:draft:d1')).toBeTruthy());
    view.unmount();

    render(<AutomationRuleBuilder {...props} />);

    // Use waitFor to ensure the state update finishes before asserting
    await waitFor(() => {
      expect(screen.getByTestId('draft-restored')).toBeTruthy();
      expect(screen.getAllByText('Untitled Rule')).toHaveLength(1);
    });
  });

  it('clears the draft after a successful save', async () => {
    const view = render(<AutomationRuleBuilder {...props} />);
    fireEvent.click(await screen.findByTestId('add-rule'));
    fireEvent.click(screen.getByTestId('save-rules'));
    await waitFor(() => expect(store.d1).toHaveLength(1));
    view.unmount();

    render(<AutomationRuleBuilder {...props} />);
    await screen.findAllByText('Untitled Rule');
    expect(screen.queryByTestId('draft-restored')).toBeNull();
  });
});