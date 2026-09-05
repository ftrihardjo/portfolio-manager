// src/github.js (export handleGithubWebhook from your index)
//
// Setup (once, outside this repo):
//  1. Create a GitHub App at https://github.com/settings/apps/new with:
//     - Repository permissions: Contents = Read & write
//     - Webhook URL = the `github-webhook` webtrigger URL (`forge webtrigger`)
//     - Webhook events: Installation, Installation repositories, Pull request
//     - Generate a private key (.pem) and set a webhook secret
//  2. Install the App on the repo(s) that should receive BPMN pushes.
//  3. Set these as Forge environment variables (`forge variables set`):
//     - GITHUB_APP_ID
//     - GITHUB_APP_PRIVATE_KEY_B64 (the .pem file, base64-encoded)
//     - GITHUB_WEBHOOK_SECRET
import crypto from 'node:crypto';
import api from '@forge/api';
import { kvs } from '@forge/kvs';

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const USER_AGENT = 'process-portfolio-manager'; // required by GitHub API

function githubAppJwt(appId, pem) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const p = b64url(Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })));
  return `${h}.${p}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), pem))}`;
}

export async function getInstallationToken(installationId) {
  // 1. Try environment variables first (old way)
  let appId = process.env.GITHUB_APP_ID;
  let pemB64 = process.env.GITHUB_APP_PRIVATE_KEY_B64;

  // 2. Fall back to the UI settings page (KVS)
  if (!appId || !pemB64) {
    appId = (await kvs.get('github_app_id')) || appId;
    pemB64 = (await kvs.getSecret('github_private_key')) || pemB64;
  }

  // If still missing, throw a clear error so it shows up in the logs
  if (!appId || !pemB64) {
    throw new Error('GitHub App credentials not found. Set them via the UI or Environment Variables.');
  }

  const pem = Buffer.from(pemB64, 'base64').toString('utf8');
  const res = await api.fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubAppJwt(appId, pem)}`, // Use the resolved appId
      'User-Agent': USER_AGENT,
    },
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  return (await res.json()).token;
}

// ─── Installation directory ──────────────────────────────────────────
// GitHub never tells us which installation covers a given repo except via
// the `installation` / `installation_repositories` webhook events, so we
// record that mapping ourselves as those events arrive. Keyed by the
// lowercase "owner/repo" full name.
const installationKey = (fullName) =>
  `github:installation:${fullName.toLowerCase().replace(/\//g, '#')}`;

export async function getInstallationIdForRepo(owner, repo) {
  return kvs.get(installationKey(`${owner}/${repo}`));
}

async function rememberInstallation(installationId, repositories = []) {
  await Promise.all(
    repositories
      .map((r) => r.full_name)
      .filter(Boolean)
      .map((fullName) => kvs.set(installationKey(fullName), installationId))
  );
}

async function forgetInstallation(repositories = []) {
  await Promise.all(
    repositories
      .map((r) => r.full_name)
      .filter(Boolean)
      .map((fullName) => kvs.delete(installationKey(fullName)))
  );
}

// ─── Contents API — push a file, creating or updating it ────────────
async function githubApiFetch(token, path, opts = {}) {
  const res = await api.fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': USER_AGENT,
      ...(opts.headers || {}),
    },
  });
  return res;
}

async function getFileSha(token, owner, repo, path, branch) {
  const res = await githubApiFetch(
    token, `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET contents failed: ${res.status} ${await res.text()}`);
  return (await res.json()).sha;
}

// Commits `content` (utf8 text) to `path` on `branch`, creating the file if
// it doesn't exist yet or updating it (via its current sha) if it does.
export async function pushFileToGithub({ installationId, owner, repo, branch, path, content, message }) {
  const token = await getInstallationToken(installationId);
  const sha = await getFileSha(token, owner, repo, path, branch);
  const res = await githubApiFetch(token, `/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(`GitHub PUT contents failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return {
    sha: body.content?.sha ?? null,
    commitSha: body.commit?.sha ?? null,
    htmlUrl: body.content?.html_url ?? null,
    commitUrl: body.commit?.html_url ?? null,
  };
}

export async function handleGithubWebhook(request) {
  // Forge webtrigger headers are { name: string[] }
  const sig = (request.headers['x-hub-signature-256'] || [])[0] || '';
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET)
    .update(request.body, 'utf8').digest('hex');

  const ok = Buffer.from(sig).length === Buffer.from(expected).length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return { status: 401, body: 'bad signature' };

  const event = (request.headers['x-github-event'] || [])[0];
  const payload = JSON.parse(request.body || '{}');

  // Keep the installationId directory current so saveBpmnDiagram (GitOps
  // push) and future webhook-driven features can resolve a repo -> token
  // without asking the user to paste an installation id anywhere.
  if (event === 'installation') {
    if (payload.action === 'created') {
      await rememberInstallation(payload.installation.id, payload.repositories);
    } else if (payload.action === 'deleted') {
      await forgetInstallation(payload.repositories);
    }
  } else if (event === 'installation_repositories') {
    if (payload.action === 'added') {
      await rememberInstallation(payload.installation.id, payload.repositories_added);
    } else if (payload.action === 'removed') {
      await forgetInstallation(payload.repositories_removed);
    }
  } else if (event === 'pull_request') {
    // parse issue keys from payload.pull_request.title, then call your
    // existing resolvers / Jira API to update portfolio & roadmap metrics
    // const token = await getInstallationToken(payload.installation.id);
  }
  return { status: 200, body: 'ok' };
}