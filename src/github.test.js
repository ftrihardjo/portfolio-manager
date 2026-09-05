import crypto from 'node:crypto';

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { fetch: jest.fn() },
  Response: undefined, // replaced per-test below via require after mock
}));

jest.mock('@forge/kvs', () => ({
  kvs: { get: jest.fn(), set: jest.fn(), delete: jest.fn() },
}));

// Re-require with a real Response stub wired in (jest.mock factories can't
// reference outer-scope classes, so we patch the mocked module directly).
import api from '@forge/api';
import * as forgeApi from '@forge/api';
import { kvs } from '@forge/kvs';

import {
  getInstallationIdForRepo,
  getInstallationToken,
  pushFileToGithub,
  handleGithubWebhook,
} from './github';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const WEBHOOK_SECRET = 'test-webhook-secret';

function signedRequest(payload, { badSignature = false } = {}) {
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex');
  return {
    body,
    headers: {
      'x-github-event': [payload.__event || 'installation'],
      'x-hub-signature-256': [badSignature ? 'sha256=deadbeef'.padEnd(sig.length, '0') : sig],
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GITHUB_APP_ID = '123456';
  process.env.GITHUB_APP_PRIVATE_KEY_B64 = Buffer.from(privateKey, 'utf8').toString('base64');
  process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

describe('getInstallationIdForRepo', () => {
  it('reads the lowercased owner/repo key from KVS', async () => {
    kvs.get.mockResolvedValue(999);
    const id = await getInstallationIdForRepo('Acme', 'Widgets');
    expect(kvs.get).toHaveBeenCalledWith('github:installation:acme#widgets');
    expect(id).toBe(999);
  });
});

describe('getInstallationToken', () => {
  it('signs a valid App JWT and exchanges it for an installation token', async () => {
    api.fetch.mockResolvedValue({ ok: true, json: async () => ({ token: 'ghs_abc123' }) });

    const token = await getInstallationToken(42);

    expect(token).toBe('ghs_abc123');
    expect(api.fetch).toHaveBeenCalledWith(
      'https://api.github.com/app/installations/42/access_tokens',
      expect.objectContaining({ method: 'POST' })
    );
    const authHeader = api.fetch.mock.calls[0][1].headers.Authorization;
    expect(authHeader).toMatch(/^Bearer /);

    const jwt = authHeader.replace('Bearer ', '');
    const [h, p, s] = jwt.split('.');
    expect(h && p && s).toBeTruthy();
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    expect(payload.iss).toBe('123456');

    const signed = crypto.verify(
      'RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')
    );
    expect(signed).toBe(true);
  });

  it('throws when the token exchange fails', async () => {
    api.fetch.mockResolvedValue({ ok: false, status: 401 });
    await expect(getInstallationToken(42)).rejects.toThrow('token exchange failed: 401');
  });
});

describe('pushFileToGithub', () => {
  beforeEach(() => {
    // Every test in this block goes through getInstallationToken first.
    api.fetch.mockImplementation((url) => {
      if (url.includes('/access_tokens')) {
        return Promise.resolve({ ok: true, json: async () => ({ token: 'ghs_abc123' }) });
      }
      return Promise.resolve({ ok: false, status: 599 }); // overridden per-test
    });
  });

  it('creates a new file (no sha) when none exists yet', async () => {
    api.fetch.mockImplementation((url, opts = {}) => {
      if (url.includes('/access_tokens')) {
        return Promise.resolve({ ok: true, json: async () => ({ token: 'ghs_abc123' }) });
      }
      if (opts.method === undefined) {
        // GET contents
        return Promise.resolve({ ok: false, status: 404 });
      }
      if (opts.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            content: { sha: 'new-sha', html_url: 'https://github.com/o/r/blob/main/f' },
            commit: { sha: 'commit-sha', html_url: 'https://github.com/o/r/commit/commit-sha' },
          }),
        });
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const result = await pushFileToGithub({
      installationId: 42, owner: 'o', repo: 'r', branch: 'main',
      path: 'workflows/order-process.bpmn', content: '<xml/>', message: 'v1 (via Portfolio Manager)',
    });

    expect(result).toEqual({
      sha: 'new-sha', commitSha: 'commit-sha',
      htmlUrl: 'https://github.com/o/r/blob/main/f',
      commitUrl: 'https://github.com/o/r/commit/commit-sha',
    });

    const putCall = api.fetch.mock.calls.find(([, opts]) => opts?.method === 'PUT');
    const putBody = JSON.parse(putCall[1].body);
    expect(putBody.sha).toBeUndefined();
    expect(putBody.branch).toBe('main');
    expect(Buffer.from(putBody.content, 'base64').toString('utf8')).toBe('<xml/>');
  });

  it('updates an existing file, sending its current sha', async () => {
    api.fetch.mockImplementation((url, opts = {}) => {
      if (url.includes('/access_tokens')) {
        return Promise.resolve({ ok: true, json: async () => ({ token: 'ghs_abc123' }) });
      }
      if (opts.method === undefined) {
        return Promise.resolve({ ok: true, json: async () => ({ sha: 'old-sha' }) });
      }
      if (opts.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ content: { sha: 'new-sha' }, commit: { sha: 'commit-sha' } }),
        });
      }
      throw new Error(`unexpected call: ${url}`);
    });

    await pushFileToGithub({
      installationId: 42, owner: 'o', repo: 'r', branch: 'main',
      path: 'workflows/order-process.bpmn', content: '<xml/>', message: 'v2',
    });

    const putCall = api.fetch.mock.calls.find(([, opts]) => opts?.method === 'PUT');
    const putBody = JSON.parse(putCall[1].body);
    expect(putBody.sha).toBe('old-sha');
  });

  it('throws with the response body when the PUT fails', async () => {
    api.fetch.mockImplementation((url, opts = {}) => {
      if (url.includes('/access_tokens')) {
        return Promise.resolve({ ok: true, json: async () => ({ token: 'ghs_abc123' }) });
      }
      if (opts.method === undefined) return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({ ok: false, status: 409, text: async () => 'sha mismatch' });
    });

    await expect(pushFileToGithub({
      installationId: 42, owner: 'o', repo: 'r', branch: 'main',
      path: 'f.bpmn', content: 'x', message: 'm',
    })).rejects.toThrow('GitHub PUT contents failed: 409 sha mismatch');
  });
});

describe('handleGithubWebhook', () => {
  it('rejects a request with an invalid signature', async () => {
    const res = await handleGithubWebhook(signedRequest({ __event: 'installation' }, { badSignature: true }));
    expect(res.status).toBe(401);   // was: res._status
  });

  it('records the installation directory on "installation: created"', async () => {
    const payload = {
      __event: 'installation',
      action: 'created',
      installation: { id: 7 },
      repositories: [{ full_name: 'Acme/Widgets' }, { full_name: 'Acme/Gadgets' }],
    };
    const res = await handleGithubWebhook(signedRequest(payload));
    expect(res.status).toBe(200);
    expect(kvs.set).toHaveBeenCalledWith('github:installation:acme#widgets', 7);
    expect(kvs.set).toHaveBeenCalledWith('github:installation:acme#gadgets', 7);
  });

  it('clears the installation directory on "installation: deleted"', async () => {
    const payload = {
      __event: 'installation',
      action: 'deleted',
      installation: { id: 7 },
      repositories: [{ full_name: 'Acme/Widgets' }],
    };
    const res = await handleGithubWebhook(signedRequest(payload));
    expect(res.status).toBe(200);
    expect(kvs.delete).toHaveBeenCalledWith('github:installation:acme#widgets');
  });

  it('adds newly-granted repos on "installation_repositories: added"', async () => {
    const payload = {
      __event: 'installation_repositories',
      action: 'added',
      installation: { id: 7 },
      repositories_added: [{ full_name: 'Acme/NewRepo' }],
    };
    const res = await handleGithubWebhook(signedRequest(payload));
    expect(res.status).toBe(200);
    expect(kvs.set).toHaveBeenCalledWith('github:installation:acme#newrepo', 7);
  });
});
