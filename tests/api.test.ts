import assert from 'node:assert/strict';
import test from 'node:test';
import { api, PrestoAPIError } from '../src/api.js';

void test('API errors preserve the product error code for actionable workflow output', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    error: {
      code: 'seat_required',
      message: 'Give @alex a developer seat before publishing this build.',
      details: { githubUserId: 42 },
    },
  }, { status: 402 });

  try {
    await assert.rejects(api('https://presto.example/api'), (error: unknown) => {
      assert.ok(error instanceof PrestoAPIError);
      assert.equal(error.code, 'seat_required');
      assert.equal(error.status, 402);
      assert.deepEqual(error.details, { githubUserId: 42 });
      assert.equal(error.message, 'Give @alex a developer seat before publishing this build.');
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('non-JSON API failures still produce a useful product error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('Bad gateway', { status: 502 });

  try {
    await assert.rejects(api('https://presto.example/api'), (error: unknown) => {
      assert.ok(error instanceof PrestoAPIError);
      assert.equal(error.code, 'presto_api_error');
      assert.equal(error.status, 502);
      assert.equal(error.message, 'Presto API returned 502.');
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
