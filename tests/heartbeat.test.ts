import assert from 'node:assert/strict';
import test from 'node:test';
import {
  startWorkflowHeartbeat,
  workflowHeartbeatIntervalMs,
} from '../src/heartbeat.js';

void test('workflow heartbeat is bounded, non-overlapping, and stoppable', async () => {
  let callback: (() => void) | undefined;
  let interval = 0;
  let cancelled = false;
  let unreferenced = false;
  const handle = { unref: () => { unreferenced = true; } };
  let release: (() => void) | undefined;
  let calls = 0;
  const stop = startWorkflowHeartbeat(
    () => {
      calls += 1;
      return new Promise<void>((resolve) => { release = resolve; });
    },
    {
      every(next, milliseconds) {
        callback = next;
        interval = milliseconds;
        return handle;
      },
      cancel(received) {
        assert.equal(received, handle);
        cancelled = true;
      },
    },
  );

  assert.equal(interval, workflowHeartbeatIntervalMs);
  assert.equal(unreferenced, true);
  callback?.();
  callback?.();
  assert.equal(calls, 1, 'a slow heartbeat is never overlapped');
  release?.();
  await Promise.resolve();
  await Promise.resolve();
  callback?.();
  assert.equal(calls, 2, 'the next interval runs after the first finishes');

  stop();
  assert.equal(cancelled, true);
  callback?.();
  assert.equal(calls, 2, 'a stopped heartbeat cannot restart');
});

void test('a failed heartbeat does not prevent the next attempt', async () => {
  let callback: (() => void) | undefined;
  let calls = 0;
  startWorkflowHeartbeat(
    async () => {
      calls += 1;
      throw new Error('temporary network failure');
    },
    {
      every(next) {
        callback = next;
        return {};
      },
      cancel() {},
    },
  );
  callback?.();
  await Promise.resolve();
  await Promise.resolve();
  callback?.();
  assert.equal(calls, 2);
});
