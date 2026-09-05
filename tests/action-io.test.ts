import assert from 'node:assert/strict';
import test from 'node:test';
import { failureAnnotation } from '../src/action-io.js';
import { PrestoAPIError } from '../src/api.js';
import { BuildDiagnosticError } from '../src/build-diagnostics.js';

void test('seat failures are unmistakable in the GitHub Actions log', () => {
  const annotation = failureAnnotation(new PrestoAPIError(
    'seat_required',
    'Give @alex a seat.\nOpen billing to continue.',
    402,
  ));
  assert.equal(
    annotation,
    '::error title=Presto seat required::Give @alex a seat.%0AOpen billing to continue.',
  );
});

void test('workflow annotation messages escape command characters', () => {
  assert.equal(
    failureAnnotation(new Error('Upload is 50% complete\r\nTry again.')),
    '::error title=Presto::Upload is 50%25 complete%0D%0ATry again.',
  );
});

void test('private dependency failures have a specific GitHub annotation title', () => {
  assert.match(
    failureAnnotation(new BuildDiagnosticError()),
    /^::error title=Private dependency access required::/,
  );
});
