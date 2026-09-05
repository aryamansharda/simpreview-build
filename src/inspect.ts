import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { run } from './process.js';

export type ArtifactMetadata = { bundleId: string; displayName: string; minimumOSVersion: string; platform: 'iphonesimulator'; architectures: Array<'arm64' | 'x86_64'>; xcodeVersion: string };

export async function detectContainer(root: string, workspace?: string, project?: string): Promise<readonly [string, string]> {
  if (workspace && project) throw new Error('Provide either workspace or project, not both.');
  if (workspace) return ['-workspace', workspace] as const;
  if (project) return ['-project', project] as const;
  const containers = await discoverContainers(root);
  if (containers.workspaces.length === 1) return ['-workspace', containers.workspaces[0]!] as const;
  if (containers.workspaces.length > 1) throw new Error(`More than one Xcode workspace was found (${containers.workspaces.join(', ')}). Set the workspace input.`);
  if (containers.projects.length === 1) return ['-project', containers.projects[0]!] as const;
  if (containers.projects.length > 1) throw new Error(`More than one Xcode project was found (${containers.projects.join(', ')}). Set the project input.`);
  throw new Error('No .xcworkspace or .xcodeproj was found. Set the workspace or project input.');
}

/**
 * GitHub checks out a synthetic merge commit by default for pull_request jobs.
 * Presto identifies previews by the pull request head SHA, so publishing that
 * merge product under the head SHA would make the Run button misleading.
 *
 * A job that only downloads an already-built app may not have a checkout at
 * all; in that case there is no local Git state for this action to verify.
 */
export async function verifyPullRequestCheckout(root: string, expectedHeadSHA: string): Promise<boolean> {
  try {
    await access(path.join(root, '.git'));
  } catch {
    return false;
  }

  const checkedOutSHA = (await run('git', ['-C', root, 'rev-parse', 'HEAD'], { quiet: true })).trim();
  if (checkedOutSHA !== expectedHeadSHA) {
    throw new Error(
      'The checked-out commit does not match this pull request. Configure actions/checkout with `ref: ${{ github.event.pull_request.head.sha }}` before the Presto step.',
    );
  }
  return true;
}

const ignoredContainerDirectories = new Set(['.git', '.build', '.presto', 'build', 'Carthage', 'DerivedData', 'node_modules', 'Pods']);

async function discoverContainers(root: string) {
  const workspaces: string[] = [];
  const projects: string[] = [];
  async function walk(directory: string, depth: number) {
    if (depth > 4) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || ignoredContainerDirectories.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.name.endsWith('.xcworkspace')) workspaces.push(relative);
      else if (entry.name.endsWith('.xcodeproj')) projects.push(relative);
      else await walk(absolute, depth + 1);
    }
  }
  await walk(root, 0);
  return { workspaces: workspaces.sort(), projects: projects.sort() };
}

export function parseBuildSettings(output: string): { targetBuildDir?: string; wrapperName?: string } {
  const values: Record<string, string> = {};
  for (const line of output.split('\n')) { const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/); if (match?.[1] && match[2]) values[match[1]] = match[2].trim(); }
  return { targetBuildDir: values.TARGET_BUILD_DIR, wrapperName: values.WRAPPER_NAME };
}

type XcodeBuildSettingsEntry = {
  target?: string;
  buildSettings?: Record<string, string>;
};

export function simulatorAppPathsFromBuildSettings(output: string): string[] {
  let entries: XcodeBuildSettingsEntry[];
  try {
    entries = JSON.parse(output) as XcodeBuildSettingsEntry[];
  } catch {
    throw new Error('Xcode returned unreadable build settings. Set the app-path input to the Simulator .app product.');
  }
  if (!Array.isArray(entries)) throw new Error('Xcode returned unreadable build settings. Set the app-path input to the Simulator .app product.');
  return entries.flatMap(({ buildSettings = {} }) => {
    if (buildSettings.PRODUCT_TYPE !== 'com.apple.product-type.application' || buildSettings.PLATFORM_NAME !== 'iphonesimulator') return [];
    const directory = buildSettings.TARGET_BUILD_DIR;
    const wrapper = buildSettings.WRAPPER_NAME;
    return directory && wrapper ? [path.join(directory, wrapper)] : [];
  });
}

export async function findApp(derivedData: string, explicit?: string, buildSettingsOutput?: string): Promise<string> {
  if (explicit) { await access(explicit); return path.resolve(explicit); }
  if (buildSettingsOutput) {
    const candidates = [...new Set(simulatorAppPathsFromBuildSettings(buildSettingsOutput))];
    if (candidates.length > 1) throw new Error(`The scheme builds more than one iOS app (${candidates.map(candidate => path.basename(candidate)).join(', ')}). Set the app-path input to the app reviewers should run.`);
    if (candidates[0]) {
      await access(candidates[0]);
      return candidates[0];
    }
    throw new Error('The selected scheme did not produce an iOS Simulator app. Set the scheme or app-path input.');
  }
  const products = path.join(derivedData, 'Build', 'Products');
  const found: Array<{ file: string; modified: number }> = [];
  async function walk(directory: string) { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory() && entry.name.endsWith('.app')) found.push({ file, modified: (await stat(file)).mtimeMs }); else if (entry.isDirectory()) await walk(file); } }
  await walk(products);
  found.sort((a, b) => b.modified - a.modified);
  if (!found[0]) throw new Error('Xcode completed but no .app product was found in DerivedData.');
  if (found.length > 1) throw new Error(`More than one .app product was found (${found.map(candidate => path.basename(candidate.file)).join(', ')}). Set the app-path input to the app reviewers should run.`);
  return found[0].file;
}

/** Reuse an app that CI already produced; otherwise let the default builder create it. */
export async function needsDefaultBuild(explicitAppPath?: string): Promise<boolean> {
  if (!explicitAppPath) return true;
  try {
    await access(explicitAppPath);
    return false;
  } catch {
    return true;
  }
}

export async function inspectApp(appPath: string): Promise<ArtifactMetadata> {
  const plistPath = path.join(appPath, 'Info.plist');
  const json = await run('plutil', ['-convert', 'json', '-o', '-', plistPath], { quiet: true });
  const plist = JSON.parse(json) as Record<string, unknown>;
  const executable = requiredString(plist, 'CFBundleExecutable');
  const binary = path.join(appPath, executable);
  const archOutput = await run('lipo', ['-archs', binary], { quiet: true });
  const architectures = archOutput.trim().split(/\s+/).filter((arch): arch is 'arm64' | 'x86_64' => arch === 'arm64' || arch === 'x86_64');
  const platform = requiredString(plist, 'DTPlatformName');
  if (platform !== 'iphonesimulator') throw new Error(`Expected an iOS Simulator product, received \`${platform}\`.`);
  if (!architectures.length) throw new Error('The app does not contain an arm64 or x86_64 Simulator architecture.');
  return { bundleId: requiredString(plist, 'CFBundleIdentifier'), displayName: optionalString(plist, 'CFBundleDisplayName') || optionalString(plist, 'CFBundleName') || path.basename(appPath, '.app'), minimumOSVersion: requiredString(plist, 'MinimumOSVersion'), platform, architectures: [...new Set(architectures)], xcodeVersion: optionalString(plist, 'DTXcodeBuild') || (await run('xcodebuild', ['-version'], { quiet: true })).trim().replaceAll('\n', ' ') };
}

function requiredString(plist: Record<string, unknown>, key: string) { const value = optionalString(plist, key); if (!value) throw new Error(`Built app is missing ${key} in Info.plist.`); return value; }
function optionalString(plist: Record<string, unknown>, key: string) { return typeof plist[key] === 'string' ? plist[key] as string : ''; }
