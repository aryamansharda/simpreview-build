import { readFile } from 'node:fs/promises';
import { api } from './api.js';
import { input, mask, notice } from './action-io.js';
import { oidcToken, pullRequestContext } from './github.js';
import { pendingPostReport } from './post-policy.js';

export async function post() {
  const pending = pendingPostReport(process.env);
  if (!pending) return;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GitHub pull request context is unavailable.');
  const context = pullRequestContext(JSON.parse(await readFile(eventPath, 'utf8')));
  if (context.fromFork) return;

  const baseURL = (input('api-url') || 'https://presto.digitalbunker.dev').replace(/\/$/, '');
  const identity = await oidcToken('presto');
  const auth = await api<{ token: string; commitSha: string }>(`${baseURL}/api/v1/auth/github-actions`, {
    method: 'POST',
    body: JSON.stringify({ oidcToken: identity, pullRequest: context.number, expectedHeadSha: context.headSHA, phase: 'none' }),
  });
  if (auth.commitSha !== context.headSHA) throw new Error('GitHub API and workflow event disagree about the pull request head commit.');
  mask(auth.token);
  await api(`${baseURL}/api/v1/workflow/status`, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth.token}` },
    body: JSON.stringify({ phase: 'failed', stage: pending.stage, previewId: pending.previewId }),
  });
  notice('Presto · Updated the pull request after the workflow stopped early.');
}

if (process.env.NODE_ENV !== 'test') post().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  notice(`::warning title=Presto cleanup::Could not update the pull request after the workflow stopped: ${message.replaceAll('\n', '%0A')}`);
});
