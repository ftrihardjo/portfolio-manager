import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import GithubSyncPanel from './GithubSyncPanel';

const invokeMock = vi.fn();
vi.mock('@forge/bridge', () => ({ invoke: (...a) => invokeMock(...a) }));

const store = {}; // projectKey -> config

beforeEach(() => {
  invokeMock.mockReset();
  Object.keys(store).forEach((k) => delete store[k]);
  invokeMock.mockImplementation(async (cmd, payload = {}) => {
    switch (cmd) {
      case 'getGithubConfig':
        return store[payload.projectKey] || null;
      case 'saveGithubConfig': {
        const saved = {
          projectKey: payload.projectKey, owner: payload.owner, repo: payload.repo,
          branch: payload.branch, pathTemplate: payload.pathTemplate,
          enabled: payload.enabled, installed: true,
        };
        store[payload.projectKey] = saved;
        return saved;
      }
      default: return { ok: true };
    }
  });
});

describe('GithubSyncPanel', () => {
  it('shows an empty form and lets an editor connect a new repo', async () => {
    render(<GithubSyncPanel projectKey="OPS" canEdit={true} />);

    await screen.findByTestId('github-sync-panel');
    expect(screen.getByTestId('github-owner-input').value).toBe('');
    expect(screen.getByText('Connect repository')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('github-owner-input'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByTestId('github-repo-input'), { target: { value: 'widgets' } });
    fireEvent.click(screen.getByTestId('github-save-config'));

    await waitFor(() => expect(store.OPS).toMatchObject({ owner: 'acme', repo: 'widgets' }));
    expect(await screen.findByText(/Saved at/)).toBeInTheDocument();
  });

  it('loads an existing config and pre-fills the form', async () => {
    store.OPS = {
      projectKey: 'OPS', owner: 'acme', repo: 'widgets', branch: 'develop',
      pathTemplate: 'workflows/{name}.bpmn', enabled: true, installed: true,
    };
    render(<GithubSyncPanel projectKey="OPS" canEdit={true} />);

    expect(await screen.findByTestId('github-owner-input')).toHaveValue('acme');
    expect(screen.getByTestId('github-repo-input')).toHaveValue('widgets');
    expect(screen.getByTestId('github-branch-input')).toHaveValue('develop');
    expect(screen.getByText('Save changes')).toBeInTheDocument();
  });

  it('disables every field and hides the save button for a viewer without edit permission', async () => {
    store.OPS = { projectKey: 'OPS', owner: 'acme', repo: 'widgets', branch: 'main', enabled: true, installed: true };
    render(<GithubSyncPanel projectKey="OPS" canEdit={false} />);

    await screen.findByTestId('github-sync-panel');
    expect(screen.getByTestId('github-owner-input')).toBeDisabled();
    expect(screen.queryByTestId('github-save-config')).not.toBeInTheDocument();
    expect(screen.getByText(/View only/)).toBeInTheDocument();
  });

  it('flags a repo the App is no longer installed on', async () => {
    store.OPS = { projectKey: 'OPS', owner: 'acme', repo: 'widgets', branch: 'main', enabled: true, installed: false };
    render(<GithubSyncPanel projectKey="OPS" canEdit={true} />);

    expect(await screen.findByRole('alert')).toHaveTextContent("isn't installed on acme/widgets");
  });

  it('surfaces a save error without clobbering the form', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'getGithubConfig') return null;
      if (cmd === 'saveGithubConfig') throw new Error('App not installed on acme/widgets.');
      return { ok: true };
    });
    render(<GithubSyncPanel projectKey="OPS" canEdit={true} />);

    await screen.findByTestId('github-sync-panel');
    fireEvent.change(screen.getByTestId('github-owner-input'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByTestId('github-repo-input'), { target: { value: 'widgets' } });
    fireEvent.click(screen.getByTestId('github-save-config'));

    expect(await screen.findByText('App not installed on acme/widgets.')).toBeInTheDocument();
    expect(screen.getByTestId('github-owner-input')).toHaveValue('acme');
  });

  it('keeps the save button disabled until both owner and repo are filled in', async () => {
    render(<GithubSyncPanel projectKey="OPS" canEdit={true} />);
    await screen.findByTestId('github-sync-panel');

    expect(screen.getByTestId('github-save-config')).toBeDisabled();
    fireEvent.change(screen.getByTestId('github-owner-input'), { target: { value: 'acme' } });
    expect(screen.getByTestId('github-save-config')).toBeDisabled();
    fireEvent.change(screen.getByTestId('github-repo-input'), { target: { value: 'widgets' } });
    expect(screen.getByTestId('github-save-config')).not.toBeDisabled();
  });
});
