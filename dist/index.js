import { createRequire as __createRequire } from "module";const require=__createRequire(import.meta.url);

// src/index.ts
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat as stat2 } from "node:fs/promises";
import path2 from "node:path";
import { Readable } from "node:stream";

// src/api.ts
async function api(url, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `Presto API returned ${response.status}.`);
  return body;
}

// src/action-io.ts
import { appendFile } from "node:fs/promises";
function input(name, required = false) {
  const key = `INPUT_${name.replaceAll("-", "_").toUpperCase()}`;
  const value = process.env[key]?.trim() ?? "";
  if (required && !value) throw new Error(`Input \`${name}\` is required.`);
  return value;
}
async function output(name, value) {
  const path3 = process.env.GITHUB_OUTPUT;
  if (!path3) return;
  await appendFile(path3, `${name}=${value}
`, "utf8");
}
function mask(value) {
  process.stdout.write(`::add-mask::${value}
`);
}
function notice(message) {
  process.stdout.write(`${message}
`);
}
function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`::error title=Presto::${message.replaceAll("\n", "%0A")}
`);
  process.exitCode = 1;
}

// src/github.ts
function pullRequestContext(event) {
  const root = event;
  const number = root.pull_request?.number ?? root.number;
  const branch = root.pull_request?.head?.ref;
  const headSHA = root.pull_request?.head?.sha;
  if (!number || !branch || !headSHA || !/^[0-9a-f]{40}$/.test(headSHA)) throw new Error("Presto must run from a pull_request workflow event.");
  return { number, title: root.pull_request?.title, branch, headSHA };
}
async function oidcToken(audience) {
  const endpoint = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!endpoint || !bearer) throw new Error("GitHub OIDC is unavailable. Add `permissions: id-token: write` to this job.");
  const url = new URL(endpoint);
  url.searchParams.set("audience", audience);
  const response = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } });
  const body = await response.json();
  if (!response.ok || !body.value) throw new Error(body.message || "GitHub did not issue an OIDC token.");
  return body.value;
}

// src/inspect.ts
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";

// src/process.ts
import { spawn } from "node:child_process";
async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!options.quiet) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!options.quiet) process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with ${code}.
${stderr.slice(-4e3)}`)));
  });
}
async function runShell(script) {
  return run("/bin/zsh", ["-eo", "pipefail", "-c", script]);
}

// src/inspect.ts
async function detectContainer(root, workspace, project) {
  if (workspace && project) throw new Error("Provide either workspace or project, not both.");
  if (workspace) return ["-workspace", workspace];
  if (project) return ["-project", project];
  const containers = await discoverContainers(root);
  if (containers.workspaces.length === 1) return ["-workspace", containers.workspaces[0]];
  if (containers.workspaces.length > 1) throw new Error(`More than one Xcode workspace was found (${containers.workspaces.join(", ")}). Set the workspace input.`);
  if (containers.projects.length === 1) return ["-project", containers.projects[0]];
  if (containers.projects.length > 1) throw new Error(`More than one Xcode project was found (${containers.projects.join(", ")}). Set the project input.`);
  throw new Error("No .xcworkspace or .xcodeproj was found. Set the workspace or project input.");
}
var ignoredContainerDirectories = /* @__PURE__ */ new Set([".git", ".build", ".presto", "build", "Carthage", "DerivedData", "node_modules", "Pods"]);
async function discoverContainers(root) {
  const workspaces = [];
  const projects = [];
  async function walk(directory, depth) {
    if (depth > 4) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || ignoredContainerDirectories.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.name.endsWith(".xcworkspace")) workspaces.push(relative);
      else if (entry.name.endsWith(".xcodeproj")) projects.push(relative);
      else await walk(absolute, depth + 1);
    }
  }
  await walk(root, 0);
  return { workspaces: workspaces.sort(), projects: projects.sort() };
}
function simulatorAppPathsFromBuildSettings(output2) {
  let entries;
  try {
    entries = JSON.parse(output2);
  } catch {
    throw new Error("Xcode returned unreadable build settings. Set the app-path input to the Simulator .app product.");
  }
  if (!Array.isArray(entries)) throw new Error("Xcode returned unreadable build settings. Set the app-path input to the Simulator .app product.");
  return entries.flatMap(({ buildSettings = {} }) => {
    if (buildSettings.PRODUCT_TYPE !== "com.apple.product-type.application" || buildSettings.PLATFORM_NAME !== "iphonesimulator") return [];
    const directory = buildSettings.TARGET_BUILD_DIR;
    const wrapper = buildSettings.WRAPPER_NAME;
    return directory && wrapper ? [path.join(directory, wrapper)] : [];
  });
}
async function findApp(derivedData, explicit, buildSettingsOutput) {
  if (explicit) {
    await access(explicit);
    return path.resolve(explicit);
  }
  if (buildSettingsOutput) {
    const candidates = [...new Set(simulatorAppPathsFromBuildSettings(buildSettingsOutput))];
    if (candidates.length > 1) throw new Error(`The scheme builds more than one iOS app (${candidates.map((candidate) => path.basename(candidate)).join(", ")}). Set the app-path input to the app reviewers should run.`);
    if (candidates[0]) {
      await access(candidates[0]);
      return candidates[0];
    }
    throw new Error("The selected scheme did not produce an iOS Simulator app. Set the scheme or app-path input.");
  }
  const products = path.join(derivedData, "Build", "Products");
  const found = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".app")) found.push({ file, modified: (await stat(file)).mtimeMs });
      else if (entry.isDirectory()) await walk(file);
    }
  }
  await walk(products);
  found.sort((a, b) => b.modified - a.modified);
  if (!found[0]) throw new Error("Xcode completed but no .app product was found in DerivedData.");
  if (found.length > 1) throw new Error(`More than one .app product was found (${found.map((candidate) => path.basename(candidate.file)).join(", ")}). Set the app-path input to the app reviewers should run.`);
  return found[0].file;
}
async function inspectApp(appPath) {
  const plistPath = path.join(appPath, "Info.plist");
  const json = await run("plutil", ["-convert", "json", "-o", "-", plistPath], { quiet: true });
  const plist = JSON.parse(json);
  const executable = requiredString(plist, "CFBundleExecutable");
  const binary = path.join(appPath, executable);
  const archOutput = await run("lipo", ["-archs", binary], { quiet: true });
  const architectures = archOutput.trim().split(/\s+/).filter((arch) => arch === "arm64" || arch === "x86_64");
  const platform = requiredString(plist, "DTPlatformName");
  if (platform !== "iphonesimulator") throw new Error(`Expected an iOS Simulator product, received \`${platform}\`.`);
  if (!architectures.length) throw new Error("The app does not contain an arm64 or x86_64 Simulator architecture.");
  return { bundleId: requiredString(plist, "CFBundleIdentifier"), displayName: optionalString(plist, "CFBundleDisplayName") || optionalString(plist, "CFBundleName") || path.basename(appPath, ".app"), minimumOSVersion: requiredString(plist, "MinimumOSVersion"), platform, architectures: [...new Set(architectures)], xcodeVersion: optionalString(plist, "DTXcodeBuild") || (await run("xcodebuild", ["-version"], { quiet: true })).trim().replaceAll("\n", " ") };
}
function requiredString(plist, key) {
  const value = optionalString(plist, key);
  if (!value) throw new Error(`Built app is missing ${key} in Info.plist.`);
  return value;
}
function optionalString(plist, key) {
  return typeof plist[key] === "string" ? plist[key] : "";
}

// src/index.ts
async function main() {
  const root = process.env.GITHUB_WORKSPACE || process.cwd();
  const scheme = input("scheme", true);
  const configuration = input("configuration") || "Debug";
  const derivedData = path2.resolve(root, input("derived-data-path") || ".presto/DerivedData");
  const customCommand = input("build-command");
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GitHub pull request context is unavailable.");
  const context = pullRequestContext(JSON.parse(await readFile(eventPath, "utf8")));
  const baseURL = (input("api-url") || "https://presto.digitalbunker.dev").replace(/\/$/, "");
  const authenticate = async (phase) => {
    const identity = await oidcToken("presto");
    const result = await api(`${baseURL}/api/v1/auth/github-actions`, { method: "POST", body: JSON.stringify({ oidcToken: identity, pullRequest: context.number, phase }) });
    if (result.commitSha !== context.headSHA) throw new Error("GitHub API and workflow event disagree about the pull request head commit.");
    mask(result.token);
    return result;
  };
  let auth = await authenticate("building");
  const authenticatedAt = Date.now();
  const reportFailure = async (detail) => {
    await fetch(`${baseURL}/api/v1/workflow/status`, { method: "POST", headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" }, body: JSON.stringify({ phase: "failed", detail }) }).catch(() => void 0);
  };
  let appPath;
  let metadata;
  let archive;
  let size;
  let sha256;
  try {
    await mkdir(path2.dirname(derivedData), { recursive: true });
    notice("Presto \xB7 Building iOS Simulator product");
    let buildSettingsOutput;
    if (customCommand) await runShell(customCommand);
    else if (!input("app-path")) {
      const container = await detectContainer(root, input("workspace"), input("project"));
      const buildArguments = [...container, "-scheme", scheme, "-configuration", configuration, "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", derivedData, "CODE_SIGNING_ALLOWED=NO"];
      await run("xcodebuild", [...buildArguments, "build"], { cwd: root });
      buildSettingsOutput = await run("xcodebuild", [...buildArguments, "-showBuildSettings", "-json"], { cwd: root, quiet: true });
    }
    appPath = await findApp(derivedData, input("app-path"), buildSettingsOutput);
    metadata = await inspectApp(appPath);
    notice(`Presto \xB7 Validated ${metadata.displayName} (${metadata.architectures.join(", ")})`);
    const staging = path2.resolve(root, ".presto");
    archive = path2.join(staging, "artifact.zip");
    await mkdir(staging, { recursive: true });
    await rm(archive, { force: true });
    await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, archive], { quiet: true });
    size = (await stat2(archive)).size;
    sha256 = (await run("shasum", ["-a", "256", archive], { quiet: true })).trim().split(/\s+/)[0] ?? "";
    if (!sha256) throw new Error("Could not calculate artifact checksum.");
  } catch (error) {
    await reportFailure(error instanceof Error ? error.message : String(error));
    throw error;
  }
  try {
    if (Date.now() - authenticatedAt > 20 * 60 * 1e3) {
      auth = await authenticate("none");
    }
    mask(auth.token);
    const headers = { authorization: `Bearer ${auth.token}` };
    const created = await api(`${baseURL}/api/v1/previews`, { method: "POST", headers, body: JSON.stringify({ pullRequest: context.number, pullRequestTitle: auth.pullRequestTitle || context.title, commitSha: context.headSHA, branch: context.branch, scheme, configuration, ...metadata, artifactSize: size, sha256 }) });
    if (created.preview.status !== "ready") {
      if (!created.upload) throw new Error("The preview is not ready and no artifact upload URL was returned.");
      const upload = await fetch(created.upload.url, {
        method: "PUT",
        body: Readable.toWeb(createReadStream(archive)),
        duplex: "half",
        headers: { "content-type": "application/zip", "content-length": String(size) }
      });
      if (!upload.ok) throw new Error(`Artifact upload failed with ${upload.status}.`);
    }
    const completion = await fetch(`${baseURL}/api/v1/previews/${created.preview.previewId}/complete`, { method: "POST", headers: { ...headers, accept: "application/json" } });
    if (!completion.ok) {
      const body = await completion.json().catch(() => ({}));
      throw new Error(body.error?.message || `Presto API returned ${completion.status}.`);
    }
    if (completion.headers.get("x-presto-comment") === "failed") notice("::warning title=Presto::The build is ready but the pull request comment could not be updated. Check the GitHub App installation permissions.");
    const previewURL = `${baseURL}/p/${created.preview.previewId}`;
    await output("preview-id", created.preview.previewId);
    await output("preview-url", previewURL);
    notice(`Presto \xB7 Ready ${previewURL}`);
  } catch (error) {
    await reportFailure(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
if (process.env.NODE_ENV !== "test") main().catch(fail);
export {
  main
};
