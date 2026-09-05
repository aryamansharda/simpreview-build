import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { saveState } from '../src/action-io.js';
import { pendingPostReport } from '../src/post-policy.js';

void test('the post hook reports only an unfinished action and keeps its last safe stage', () => {
  assert.deepEqual(pendingPostReport({ STATE_PRESTO_STARTED: 'true', STATE_PRESTO_STAGE: 'publish', STATE_PRESTO_PREVIEW_ID: 'preview_1234' }), { stage: 'publish', previewId: 'preview_1234' });
  assert.deepEqual(pendingPostReport({ STATE_PRESTO_STARTED: 'true', STATE_PRESTO_STAGE: 'unexpected', STATE_PRESTO_PREVIEW_ID: '../../unsafe' }), { stage: 'build' });
  assert.equal(pendingPostReport({ STATE_PRESTO_STARTED: 'true', STATE_PRESTO_FINALIZED: 'true' }), undefined);
  assert.equal(pendingPostReport({}), undefined);
});

void test('action state uses the runner state file without accepting command injection', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'presto-state-'));
  const statePath = path.join(directory, 'state');
  const previous = process.env.GITHUB_STATE;
  process.env.GITHUB_STATE = statePath;
  try {
    await saveState('PRESTO_STAGE', 'publish');
    assert.equal(await readFile(statePath, 'utf8'), 'PRESTO_STAGE=publish\n');
    await assert.rejects(saveState('unsafe-name', 'value'), /state names/);
    await assert.rejects(saveState('PRESTO_STAGE', 'publish\nPRESTO_FINALIZED=true'), /one line/);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_STATE;
    else process.env.GITHUB_STATE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
