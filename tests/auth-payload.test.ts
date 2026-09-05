import assert from 'node:assert/strict';
import test from 'node:test';
import { actionAuthenticationPayload } from '../src/auth-payload.js';

void test('GitHub Actions authentication binds the required scheme to every session', () => {
  assert.deepEqual(actionAuthenticationPayload({
    oidcToken: 'oidc-token',
    pullRequest: 42,
    expectedHeadSha: 'a'.repeat(40),
    phase: 'building',
    scheme: 'Storefront',
  }), {
    oidcToken: 'oidc-token',
    pullRequest: 42,
    expectedHeadSha: 'a'.repeat(40),
    phase: 'building',
    scheme: 'Storefront',
  });
});
