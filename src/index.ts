import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { api } from './api.js';
import { fail, input, mask, notice, output } from './action-io.js';
import { oidcToken, pullRequestContext } from './github.js';
import { detectContainer, findApp, inspectApp } from './inspect.js';
import { run, runShell } from './process.js';

export async function main() {
  const root = process.env.GITHUB_WORKSPACE || process.cwd();
  const scheme = input('scheme', true);
  const configuration = input('configuration') || 'Debug';
  const derivedData = path.resolve(root, input('derived-data-path') || '.simpreview/DerivedData');
  const customCommand = input('build-command');
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GitHub pull request context is unavailable.');
  const context = pullRequestContext(JSON.parse(await readFile(eventPath, 'utf8')));

  await mkdir(path.dirname(derivedData), { recursive: true });
  notice('SimPreview · Building iOS Simulator product');
  if (customCommand) await runShell(customCommand);
  else if (!input('app-path')) {
    const container = await detectContainer(root, input('workspace'), input('project'));
    await run('xcodebuild', [...container, '-scheme', scheme, '-configuration', configuration, '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', derivedData, 'CODE_SIGNING_ALLOWED=NO', 'build'], { cwd: root });
  }

  const appPath = await findApp(derivedData, input('app-path'));
  const metadata = await inspectApp(appPath);
  notice(`SimPreview · Validated ${metadata.displayName} (${metadata.architectures.join(', ')})`);

  const staging = path.resolve(root, '.simpreview');
  const archive = path.join(staging, 'artifact.zip');
  await mkdir(staging, { recursive: true });
  await rm(archive, { force: true });
  await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, archive], { quiet: true });
  const size = (await stat(archive)).size;
  const sha256 = (await run('shasum', ['-a', '256', archive], { quiet: true })).trim().split(/\s+/)[0];
  if (!sha256) throw new Error('Could not calculate artifact checksum.');

  const baseURL = (input('api-url') || 'https://simpreview.digitalbunker.dev').replace(/\/$/, '');
  const identity = await oidcToken('simpreview');
  const auth = await api<{ token: string; commitSha: string; pullRequestTitle?: string }>(`${baseURL}/api/v1/auth/github-actions`, { method: 'POST', body: JSON.stringify({ oidcToken: identity, pullRequest: context.number }) });
  if (auth.commitSha !== context.headSHA) throw new Error('GitHub API and workflow event disagree about the pull request head commit.');
  mask(auth.token);
  const headers = { authorization: `Bearer ${auth.token}` };
  const created = await api<{ preview: { previewId: string; status: string }; upload: { url: string } | null }>(`${baseURL}/api/v1/previews`, { method: 'POST', headers, body: JSON.stringify({ pullRequest: context.number, pullRequestTitle: auth.pullRequestTitle || context.title, commitSha: context.headSHA, branch: context.branch, scheme, configuration, ...metadata, artifactSize: size, sha256 }) });
  if (created.preview.status !== 'ready') {
    if (!created.upload) throw new Error('The preview is not ready and no artifact upload URL was returned.');
    const bytes = await readFile(archive);
    const upload = await fetch(created.upload.url, { method: 'PUT', body: bytes, headers: { 'content-type': 'application/zip' } });
    if (!upload.ok) throw new Error(`Artifact upload failed with ${upload.status}.`);
  }
  // Completion is intentionally idempotent so a retry can repair a missing PR
  // comment even when the artifact became ready during an earlier attempt.
  const completion = await fetch(`${baseURL}/api/v1/previews/${created.preview.previewId}/complete`, { method: 'POST', headers: { ...headers, accept: 'application/json' } });
  if (!completion.ok) {
    const body = await completion.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message || `SimPreview API returned ${completion.status}.`);
  }
  if (completion.headers.get('x-simpreview-comment') === 'failed') notice('::warning title=SimPreview::The build is ready but the pull request comment could not be updated. Check the GitHub App installation permissions.');
  const previewURL = `${baseURL}/p/${created.preview.previewId}`;
  await output('preview-id', created.preview.previewId);
  await output('preview-url', previewURL);
  notice(`SimPreview · Ready ${previewURL}`);
}

if (process.env.NODE_ENV !== 'test') main().catch(fail);
