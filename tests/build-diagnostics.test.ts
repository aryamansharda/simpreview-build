import assert from 'node:assert/strict';
import test from 'node:test';
import { actionableBuildFailure, BuildDiagnosticError } from '../src/build-diagnostics.js';
import { CommandError } from '../src/process.js';

void test('private Swift package authentication failures receive static privacy-safe guidance', () => {
  const secretRepository = 'https://oauth2:github_pat_never_repeat@example.com/acme/private-kit.git';
  const failure = new CommandError(
    'xcodebuild',
    65,
    `Could not resolve package dependencies:\nfatal: Authentication failed for '${secretRepository}'`,
  );

  const diagnosed = actionableBuildFailure(failure);

  assert.ok(diagnosed instanceof BuildDiagnosticError);
  assert.equal(diagnosed.code, 'private_dependency_authentication');
  assert.match(diagnosed.message, /Configure its read-only HTTPS token or SSH key/);
  assert.doesNotMatch(diagnosed.message, /github_pat_never_repeat|private-kit|example\.com/);
});

void test('private pod SSH failures receive the same actionable guidance', () => {
  const failure = new CommandError(
    '/bin/zsh',
    1,
    '[!] Error installing PrivatePod\ngit@github.com: Permission denied (publickey).',
  );

  assert.ok(actionableBuildFailure(failure) instanceof BuildDiagnosticError);
});

void test('ordinary compiler failures keep the original command error', () => {
  const failure = new CommandError('xcodebuild', 65, 'MyView.swift:12:7: error: cannot find type Widget in scope');
  assert.equal(actionableBuildFailure(failure), failure);
});

void test('generic package resolution errors are not mislabeled as authentication failures', () => {
  const failure = new CommandError('xcodebuild', 74, 'Could not resolve package dependencies: package requires Swift tools version 7.0');
  assert.equal(actionableBuildFailure(failure), failure);
});
