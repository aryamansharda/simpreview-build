import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { run } from './process.js';

export type ArtifactMetadata = { bundleId: string; displayName: string; minimumOSVersion: string; platform: 'iphonesimulator'; architectures: Array<'arm64' | 'x86_64'>; xcodeVersion: string };

export async function detectContainer(root: string, workspace?: string, project?: string) {
  if (workspace && project) throw new Error('Provide either workspace or project, not both.');
  if (workspace) return ['-workspace', workspace] as const;
  if (project) return ['-project', project] as const;
  const entries = await readdir(root);
  const detectedWorkspace = entries.find(name => name.endsWith('.xcworkspace'));
  if (detectedWorkspace) return ['-workspace', detectedWorkspace] as const;
  const detectedProject = entries.find(name => name.endsWith('.xcodeproj'));
  if (detectedProject) return ['-project', detectedProject] as const;
  throw new Error('No .xcworkspace or .xcodeproj was found. Set the workspace or project input.');
}

export function parseBuildSettings(output: string): { targetBuildDir?: string; wrapperName?: string } {
  const values: Record<string, string> = {};
  for (const line of output.split('\n')) { const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/); if (match?.[1] && match[2]) values[match[1]] = match[2].trim(); }
  return { targetBuildDir: values.TARGET_BUILD_DIR, wrapperName: values.WRAPPER_NAME };
}

export async function findApp(derivedData: string, explicit?: string): Promise<string> {
  if (explicit) { await access(explicit); return path.resolve(explicit); }
  const products = path.join(derivedData, 'Build', 'Products');
  const found: Array<{ file: string; modified: number }> = [];
  async function walk(directory: string) { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory() && entry.name.endsWith('.app')) found.push({ file, modified: (await stat(file)).mtimeMs }); else if (entry.isDirectory()) await walk(file); } }
  await walk(products);
  found.sort((a, b) => b.modified - a.modified);
  if (!found[0]) throw new Error('Xcode completed but no .app product was found in DerivedData.');
  return found[0].file;
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

