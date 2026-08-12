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

  it('keeps an unsaved deletion across tab switches and persists it on save', async () => {
    store.d1 = [{
      id: 'rule-x', name: 'Do Nothing', enabled: true, trigger: 'issue_created',
      triggerConfig: {}, conditions: [], actions: [],
      decisionTable: { inputs: [], outputs: [], rows: [], hitPolicy: 'FIRST' },
    }];

    const view = render(<AutomationRuleBuilder {...props} />);
    expect(await screen.findByText('Do Nothing')).toBeTruthy();

    // Delete the rule (unsaved)
    fireEvent.click(screen.getByText('Delete'));

    // Wait for the state update and draft save to complete
    await waitFor(() => {
      const draft = localStorage.getItem('automation:draft:d1');
      expect(draft).toBe('[]');
    }, { timeout: 3000 });

    view.unmount();

    // Return: deletion still pending — the rule must NOT reappear
    const view2 = render(<AutomationRuleBuilder {...props} />);
    await waitFor(() => expect(screen.getByTestId('draft-restored')).toBeTruthy());
    expect(screen.queryByText('Do Nothing')).toBeNull();

    // Confirm with Save Rules → backend becomes []
    fireEvent.click(screen.getByTestId('save-rules'));
    await waitFor(() => expect(store.d1).toEqual([]));
    view2.unmount();

    // Return again: still empty, no banner (deletion is committed)
    render(<AutomationRuleBuilder {...props} />);
    await waitFor(() => expect(screen.queryByTestId('draft-restored')).toBeNull());
    expect(screen.queryByText('Do Nothing')).toBeNull();
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