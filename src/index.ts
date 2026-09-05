import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { api } from './api.js';
import { fail, input, mask, notice, output, saveState } from './action-io.js';
import { artifactDigests } from './digests.js';
import { actionAuthenticationPayload, type ActionAuthenticationPhase } from './auth-payload.js';
import { actionableBuildFailure } from './build-diagnostics.js';
import { oidcToken, pullRequestContext } from './github.js';
import { startWorkflowHeartbeat } from './heartbeat.js';
import { detectContainer, findApp, inspectApp } from './inspect.js';
import { run, runShell } from './process.js';

export async function main() {
  await saveState('PRESTO_STARTED', 'true');
  await saveState('PRESTO_STAGE', 'build');
  const root = process.env.GITHUB_WORKSPACE || process.cwd();
  const scheme = input('scheme', true);
  const configuration = input('configuration') || 'Debug';
  const derivedData = path.resolve(root, input('derived-data-path') || '.presto/DerivedData');
  const customCommand = input('build-command');
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GitHub pull request context is unavailable.');
  const context = pullRequestContext(JSON.parse(await readFile(eventPath, 'utf8')));
  const publishAttemptId = randomUUID();
  if (context.fromFork) {
    // Fork PRs get no OIDC identity, and their code should not be published under this repo's name anyway.
    notice('::notice title=Presto::Skipped: pull requests from forks are not built. Push a branch in this repository to get a Run button.');
    await saveState('PRESTO_FINALIZED', 'true');
    return;
  }

  const baseURL = (input('api-url') || 'https://presto.digitalbunker.dev').replace(/\/$/, '');
  // Authenticate before building so the pull request comment can say "Building…" right away.
  const authenticate = async (phase: ActionAuthenticationPhase) => {
    const identity = await oidcToken('presto');
    const result = await api<{ token: string; commitSha: string; pullRequestTitle?: string }>(`${baseURL}/api/v1/auth/github-actions`, { method: 'POST', body: JSON.stringify(actionAuthenticationPayload({ oidcToken: identity, pullRequest: context.number, expectedHeadSha: context.headSHA, phase, scheme })) });
    if (result.commitSha !== context.headSHA) throw new Error('GitHub API and workflow event disagree about the pull request head commit.');
    mask(result.token);
    return result;
  };
  let auth = await authenticate('building');
  let authenticatedAt = Date.now();
  let authenticationRefresh: Promise<void> | undefined;
  const refreshAuthentication = async (force = false) => {
    if (!force && Date.now() - authenticatedAt <= 20 * 60 * 1000) return;
    if (!authenticationRefresh) {
      authenticationRefresh = (async () => {
        const refreshed = await authenticate('none');
        auth = refreshed;
        authenticatedAt = Date.now();
      })().finally(() => {
        authenticationRefresh = undefined;
      });
    }
    await authenticationRefresh;
  };
  const reportFailure = async (stage: 'build' | 'publish', previewId?: string) => {
    try {
      await refreshAuthentication();
      const send = () => fetch(`${baseURL}/api/v1/workflow/status`, { method: 'POST', headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ phase: 'failed', stage, previewId }) });
      let response = await send();
      if (response.status === 401) {
        await refreshAuthentication(true);
        response = await send();
      }
    } catch {
      // Reporting must never replace the build or publish error that caused it.
    }
  };
  const stopHeartbeat = startWorkflowHeartbeat(() => refreshAuthentication(true));

  let appPath: string; let metadata: Awaited<ReturnType<typeof inspectApp>>; let archive: string; let size: number; let sha256: string; let md5: string;
  try {
    await mkdir(path.dirname(derivedData), { recursive: true });
    notice('Presto · Building iOS Simulator product');
    let buildSettingsOutput: string | undefined;
    if (customCommand) await runShell(customCommand);
    else if (!input('app-path')) {
      const container = await detectContainer(root, input('workspace'), input('project'));
      // ONLY_ACTIVE_ARCH=NO: Debug builds default to the runner's arch only, which leaves Intel Macs unable to run the app.
      const buildArguments = [...container, '-scheme', scheme, '-configuration', configuration, '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', derivedData, 'CODE_SIGNING_ALLOWED=NO', 'ONLY_ACTIVE_ARCH=NO'];
      await run('xcodebuild', [...buildArguments, 'build'], { cwd: root });
      buildSettingsOutput = await run('xcodebuild', [...buildArguments, '-showBuildSettings', '-json'], { cwd: root, quiet: true });
    }

    appPath = await findApp(derivedData, input('app-path'), buildSettingsOutput);
    metadata = await inspectApp(appPath);
    notice(`Presto · Validated ${metadata.displayName} (${metadata.architectures.join(', ')})`);

    const staging = path.resolve(root, '.presto');
    archive = path.join(staging, 'artifact.zip');
    await mkdir(staging, { recursive: true });
    await rm(archive, { force: true });
    await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, archive], { quiet: true });
    size = (await stat(archive)).size;
    ({ sha256, md5 } = await artifactDigests(archive));
  } catch (error) {
    stopHeartbeat();
    await reportFailure('build');
    throw actionableBuildFailure(error);
  }

  let createdPreviewId: string | undefined;
  try {
    await saveState('PRESTO_STAGE', 'publish');
    // The session is short-lived; take a fresh one if the build ran long.
    await refreshAuthentication();
    mask(auth.token);
    const headers = { authorization: `Bearer ${auth.token}` };
    const created = await api<{ preview: { previewId: string; status: string }; upload: { url: string; headers?: Record<string, string> } | null }>(`${baseURL}/api/v1/previews`, { method: 'POST', headers, body: JSON.stringify({ publishAttemptId, pullRequest: context.number, pullRequestTitle: auth.pullRequestTitle || context.title, commitSha: context.headSHA, branch: context.branch, scheme, configuration, ...metadata, artifactSize: size, sha256, md5 }) });
    createdPreviewId = created.preview.previewId;
    await saveState('PRESTO_PREVIEW_ID', createdPreviewId);
    if (created.preview.status !== 'ready') {
      if (!created.upload) throw new Error('The preview is not ready and no artifact upload URL was returned.');
      const upload = await fetch(created.upload.url, {
        method: 'PUT',
        body: Readable.toWeb(createReadStream(archive)),
        duplex: 'half',
        headers: { ...created.upload.headers, 'content-type': 'application/zip', 'content-length': String(size) },
      } as RequestInit & { duplex: 'half' });
      if (!upload.ok) throw new Error(`Artifact upload failed with ${upload.status}.`);
    }
    // A slow upload can outlive the session; take a fresh one before completing.
    await refreshAuthentication();
    mask(auth.token);
    // Completion is intentionally idempotent so a retry can repair a missing PR
    // comment even when the artifact became ready during an earlier attempt.
    const complete = () => fetch(`${baseURL}/api/v1/previews/${created.preview.previewId}/complete`, { method: 'POST', headers: { authorization: `Bearer ${auth.token}`, accept: 'application/json' } });
    let completion = await complete();
    if (completion.status === 401) {
      await refreshAuthentication(true);
      completion = await complete();
    }
    if (!completion.ok) {
      const body = await completion.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(body.error?.message || `Presto API returned ${completion.status}.`);
    }
    if (completion.headers.get('x-presto-comment') === 'failed') notice('::warning title=Presto::The build is ready but the pull request comment could not be updated. Check the GitHub App installation permissions.');
    const previewURL = `${baseURL}/p/${created.preview.previewId}`;
    await output('preview-id', created.preview.previewId);
    await output('preview-url', previewURL);
    notice(`Presto · Ready ${previewURL}`);
    await saveState('PRESTO_FINALIZED', 'true');
    stopHeartbeat();
  } catch (error) {
    stopHeartbeat();
    await reportFailure('publish', createdPreviewId);
    throw error;
  }
}

if (process.env.NODE_ENV !== 'test') main().catch(fail);
