// src/github.js (export handleGithubWebhook from your index)
import crypto from 'node:crypto';
import api, { Response } from '@forge/api';

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function githubAppJwt(appId, pem) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const p = b64url(Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })));
  return `${h}.${p}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), pem))}`;
}

export async function getInstallationToken(installationId) {
  const pem = Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_B64, 'base64').toString('utf8');
  const res = await api.fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubAppJwt(process.env.GITHUB_APP_ID, pem)}`,
      'User-Agent': 'process-portfolio-manager', // required by GitHub API
    },
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  return (await res.json()).token;
}

export async function handleGithubWebhook(request) {
  // Forge webtrigger headers are { name: string[] }
  const sig = (request.headers['x-hub-signature-256'] || [])[0] || '';
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET)
    .update(request.body, 'utf8').digest('hex');

  const ok = Buffer.from(sig).length === Buffer.from(expected).length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return new Response().status(401).body('bad signature');

  const event = (request.headers['x-github-event'] || [])[0];
  const payload = JSON.parse(request.body || '{}');

  if (event === 'pull_request') {
    // parse issue keys from payload.pull_request.title, then call your
    // existing resolvers / Jira API to update portfolio & roadmap metrics
    // const token = await getInstallationToken(payload.installation.id);
  }
  return new Response().status(200).body('ok');
}