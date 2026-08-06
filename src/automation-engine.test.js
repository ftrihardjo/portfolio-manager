import { automationEngine, evaluateCondition, evaluateDecisionTable, executeAction } from './automation-engine';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';

// ─── Mock Forge APIs ───────────────────────────────────────────────────────
jest.mock('@forge/api', () => {
  const mockRequestJira = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ transitions: [{ id: '21', name: 'In Progress' }] }),
  });

  return {
    __esModule: true, // Required for Jest to recognize default exports
    default: {        // This maps to the `api` default import
      asApp: jest.fn(() => ({ requestJira: mockRequestJira })),
      asUser: jest.fn(() => ({ requestJira: mockRequestJira })),
    },
    route: jest.fn((strings, ...values) => {
      if (Array.isArray(strings)) return strings.reduce((res, str, i) => res + str + (values[i] || ''), '');
      return strings;
    }),
  };
});

jest.mock('@forge/kvs', () => ({
  kvs: {
    get: jest.fn(),
  },
}));

describe('Automation Engine', () => {
  const mockIssue = {
    key: 'TEST-123',
    fields: {
      project: { key: 'TEST' },
      status: { name: 'To Do' },
      priority: { name: 'High' },
      issuetype: { name: 'Bug' },
      labels: ['urgent'],
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Unit Tests: Condition Evaluation ────────────────────────────────────
  describe('evaluateCondition', () => {
    test('matches equals operator', () => {
      expect(evaluateCondition({ field: 'priority', operator: 'equals', value: 'High' }, mockIssue)).toBe(true);
      expect(evaluateCondition({ field: 'priority', operator: 'equals', value: 'Low' }, mockIssue)).toBe(false);
    });

    test('matches contains operator for arrays (labels)', () => {
      expect(evaluateCondition({ field: 'labels', operator: 'contains', value: 'urgent' }, mockIssue)).toBe(true);
    });

    test('matches is_empty operator', () => {
      const noAssigneeIssue = { fields: { ...mockIssue.fields, assignee: null } };
      expect(evaluateCondition({ field: 'assignee', operator: 'is_empty', value: '' }, noAssigneeIssue)).toBe(true);
    });
  });

  // ─── Unit Tests: Decision Tables (DMN) ───────────────────────────────────
  describe('evaluateDecisionTable', () => {
    const dmnTable = {
      hitPolicy: 'FIRST',
      inputs: [{ id: 'in1', label: 'Priority' }, { id: 'in2', label: 'Status' }],
      outputs: [{ id: 'out1', label: 'Action' }],
      rows: [
        { id: 'r1', in1: 'High', in2: 'To Do', out1: 'transition: In Progress' },
        { id: 'r2', in1: 'Low', in2: 'To Do', out1: 'add_comment: Needs Triage' },
      ],
    };

    test('returns action for matching row (FIRST policy)', () => {
      const actions = evaluateDecisionTable(dmnTable, mockIssue);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('transition');
      expect(actions[0].config.value).toBe('In Progress');
    });

    test('returns empty array if no rows match', () => {
      const lowIssue = { fields: { ...mockIssue.fields, priority: { name: 'Low' }, status: { name: 'Done' } } };
      const actions = evaluateDecisionTable(dmnTable, lowIssue);
      expect(actions).toHaveLength(0);
    });
  });

  // ─── Integration Test: Main Engine Execution ─────────────────────────────
  describe('automationEngine', () => {
    test('executes transition action when issue_created trigger fires', async () => {
      // Mock KVS to return an active rule
      kvs.get.mockImplementation((key) => {
        if (key === 'bpmn:index') return [{ id: 'diagram-1', projectKey: 'TEST' }];
        if (key === 'automation:rules:diagram-1') return [{
          id: 'rule-1',
          enabled: true,
          trigger: 'issue_created',
          conditions: [{ field: 'priority', operator: 'equals', value: 'High' }],
          actions: [{ type: 'transition', config: { value: 'In Progress' } }],
        }];
        return null;
      });

      const event = {
        webhookEvent: 'jira:issue_created',
        issue: mockIssue,
      };

      await automationEngine(event);

      // Verify Jira API was called to get transitions
      expect(api.asApp().requestJira).toHaveBeenCalledWith(
        expect.stringContaining('/rest/api/3/issue/TEST-123/transitions'),
        expect.objectContaining({ method: 'POST' }) // The actual transition call
      );
    });
  });
});