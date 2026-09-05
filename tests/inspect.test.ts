import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detectContainer, findApp, needsDefaultBuild, parseBuildSettings, simulatorAppPathsFromBuildSettings, verifyPullRequestCheckout } from '../src/inspect.js';
import { pullRequestContext } from '../src/github.js';
import { run } from '../src/process.js';

const headSHA = 'a'.repeat(40);
test('pullRequestContext reads canonical pull request metadata', () => { assert.deepEqual(pullRequestContext({ number: 42, pull_request: { title: 'New flow', head: { ref: 'feature/new-flow', sha: headSHA } } }), { number: 42, title: 'New flow', branch: 'feature/new-flow', headSHA, fromFork: false }); });
test('pullRequestContext flags pull requests from forks', () => {
  assert.equal(pullRequestContext({ number: 7, pull_request: { head: { ref: 'x', sha: headSHA, repo: { fork: true, full_name: 'someone/app' } }, base: { repo: { full_name: 'acme/app' } } } }).fromFork, true);
  assert.equal(pullRequestContext({ number: 7, pull_request: { head: { ref: 'x', sha: headSHA, repo: { fork: false, full_name: 'acme/app' } }, base: { repo: { full_name: 'acme/app' } } } }).fromFork, false);
  assert.equal(pullRequestContext({ number: 7, pull_request: { head: { ref: 'x', sha: headSHA, repo: { fork: true, full_name: 'acme/app' } }, base: { repo: { full_name: 'acme/app' } } } }).fromFork, false, 'a forked repository can receive safe PRs from its own branches');
});
test('pullRequestContext rejects non-PR events', () => { assert.throws(() => pullRequestContext({ ref: 'main' }), /pull_request/); });
test('parseBuildSettings extracts paths without scraping fixed spacing', () => { assert.deepEqual(parseBuildSettings('    TARGET_BUILD_DIR = /tmp/Build Products/Debug\n    WRAPPER_NAME = MyApp.app\n'), { targetBuildDir: '/tmp/Build Products/Debug', wrapperName: 'MyApp.app' }); });

test('process failures never copy command stderr into the surfaced error', async () => {
  const secret = 'PRESTO_TEST_SECRET_SHOULD_NOT_ESCAPE';
  await assert.rejects(
    run('/bin/sh', ['-c', `printf '%s\\n' '${secret}' >&2; exit 7`], { quiet: true }),
    (error: unknown) => error instanceof Error
      && error.message === '/bin/sh exited with 7. Review the Actions log for details.'
      && !error.message.includes(secret),
  );
});

test('verifyPullRequestCheckout accepts the exact pull request head', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'presto-checkout-'));
  try {
    await run('git', ['init', '--quiet', root], { quiet: true });
    await run('git', ['-C', root, 'config', 'user.email', 'presto@example.com'], { quiet: true });
    await run('git', ['-C', root, 'config', 'user.name', 'Presto Test'], { quiet: true });
    await writeFile(path.join(root, 'README.md'), 'fixture');
    await run('git', ['-C', root, 'add', 'README.md'], { quiet: true });
    await run('git', ['-C', root, 'commit', '--quiet', '-m', 'Fixture'], { quiet: true });
    const head = (await run('git', ['-C', root, 'rev-parse', 'HEAD'], { quiet: true })).trim();
    assert.equal(await verifyPullRequestCheckout(root, head), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifyPullRequestCheckout rejects a synthetic merge or stale checkout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'presto-checkout-'));
  try {
    await run('git', ['init', '--quiet', root], { quiet: true });
    await run('git', ['-C', root, 'config', 'user.email', 'presto@example.com'], { quiet: true });
    await run('git', ['-C', root, 'config', 'user.name', 'Presto Test'], { quiet: true });
    await writeFile(path.join(root, 'README.md'), 'fixture');
    await run('git', ['-C', root, 'add', 'README.md'], { quiet: true });
    await run('git', ['-C', root, 'commit', '--quiet', '-m', 'Fixture'], { quiet: true });
    await assert.rejects(
      verifyPullRequestCheckout(root, 'a'.repeat(40)),
      /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifyPullRequestCheckout reports when a downloaded artifact job has no checkout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'presto-checkout-'));
  try {
    assert.equal(await verifyPullRequestCheckout(root, headSHA), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('detectContainer finds a single iOS workspace in a monorepo', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'presto-container-'));
  try {
    await mkdir(path.join(root, 'apps', 'ios', 'My App.xcworkspace'), { recursive: true });
    await mkdir(path.join(root, 'Pods', 'Pods.xcodeproj'), { recursive: true });
    assert.deepEqual(await detectContainer(root), ['-workspace', path.join('apps', 'ios', 'My App.xcworkspace')]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('detectContainer refuses to guess between multiple workspaces', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'presto-container-'));
  try {
    await mkdir(path.join(root, 'Consumer.xcworkspace'));
    await mkdir(path.join(root, 'Enterprise.xcworkspace'));
    await assert.rejects(detectContainer(root), /More than one Xcode workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('simulatorAppPathsFromBuildSettings ignores tests, App Clips, and Watch apps', () => {
  const settings = JSON.stringify([
    { target: 'MyApp', buildSettings: { PRODUCT_TYPE: 'com.apple.product-type.application', PLATFORM_NAME: 'iphonesimulator', TARGET_BUILD_DIR: '/tmp/Debug-iphonesimulator', WRAPPER_NAME: 'MyApp.app' } },
    { target: 'MyAppTests', buildSettings: { PRODUCT_TYPE: 'com.apple.product-type.bundle.unit-test', PLATFORM_NAME: 'iphonesimulator', TARGET_BUILD_DIR: '/tmp/Debug-iphonesimulator', WRAPPER_NAME: 'MyAppTests.xctest' } },
    { target: 'MyClip', buildSettings: { PRODUCT_TYPE: 'com.apple.product-type.application.on-demand-install-capable', PLATFORM_NAME: 'iphonesimulator', TARGET_BUILD_DIR: '/tmp/Debug-iphonesimulator', WRAPPER_NAME: 'MyClip.app' } },
    { target: 'MyWatch', buildSettings: { PRODUCT_TYPE: 'com.apple.product-type.application.watchapp2', PLATFORM_NAME: 'watchsimulator', TARGET_BUILD_DIR: '/tmp/Debug-watchsimulator', WRAPPER_NAME: 'MyWatch.app' } },
  ]);
  assert.deepEqual(simulatorAppPathsFromBuildSettings(settings), ['/tmp/Debug-iphonesimulator/MyApp.app']);
});

test('findApp uses Xcode product metadata instead of a newer unrelated app', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'presto-products-'));
  try {
    const product = path.join(root, 'Build', 'Products', 'Debug-iphonesimulator', 'My App.app');
    const unrelated = path.join(root, 'Build', 'Products', 'Debug-iphonesimulator', 'Other.app');
    await mkdir(product, { recursive: true });
    await mkdir(unrelated, { recursive: true });
    await writeFile(path.join(unrelated, 'newer'), 'newer');
    const settings = JSON.stringify([{ buildSettings: { PRODUCT_TYPE: 'com.apple.product-type.application', PLATFORM_NAME: 'iphonesimulator', TARGET_BUILD_DIR: path.dirname(product), WRAPPER_NAME: path.basename(product) } }]);
    assert.equal(await findApp(root, undefined, settings), product);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('findApp requires app-path when a custom build leaves multiple app products', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'presto-products-'));
  try {
    await mkdir(path.join(root, 'Build', 'Products', 'Debug-iphonesimulator', 'Consumer.app'), { recursive: true });
    await mkdir(path.join(root, 'Build', 'Products', 'Debug-iphonesimulator', 'Enterprise.app'), { recursive: true });
    await assert.rejects(findApp(root), /More than one \.app product/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an app-path selects the desired built-in build product without skipping a required build', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'presto-products-'));
  const requested = path.join(root, 'Build', 'Products', 'Debug-iphonesimulator', 'Consumer.app');
  try {
    assert.equal(await needsDefaultBuild(requested), true, 'a clean runner still needs to build the selected app');
    await mkdir(requested, { recursive: true });
    assert.equal(await needsDefaultBuild(requested), false, 'an app produced by existing CI is reused');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
