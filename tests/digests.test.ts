import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { artifactDigests } from '../src/digests.js';

void test('artifact digests match the bytes sent to storage', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'presto-digests-'));
  try {
    const file = path.join(directory, 'artifact.zip');
    await writeFile(file, 'Presto artifact fixture');
    assert.deepEqual(await artifactDigests(file), {
      sha256: '1e51b107676cf742043614097504dce9101eef687a24810e52cacf243d543ccb',
      md5: 'd33dd2c265bc98c076c8611da08e348d',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
