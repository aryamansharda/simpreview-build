import { createRequire as __createRequire } from "module";const require=__createRequire(import.meta.url);

// src/index.ts
import { randomUUID } from "node:crypto";
import { createReadStream as createReadStream2 } from "node:fs";
import { mkdir, readFile, rm, stat as stat2 } from "node:fs/promises";
import path2 from "node:path";
import { Readable } from "node:stream";

// src/api.ts
var PrestoAPIError = class extends Error {
  constructor(code, message, status, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    this.name = "PrestoAPIError";
  }
};
async function api(url, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new PrestoAPIError(
      body.error?.code || "presto_api_error",
      body.error?.message || `Presto API returned ${response.status}.`,
      response.status,
      body.error?.details
    );
  }
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
async function saveState(name, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("Action state names must use uppercase letters, numbers, and underscores.");
  if (value.includes("\n") || value.includes("\r")) throw new Error("Action state values must fit on one line.");
  const statePath = process.env.GITHUB_STATE;
  if (!statePath) return;
  await appendFile(statePath, `${name}=${value}
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
function failureAnnotation(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  const title = {
    seat_required: "Presto seat required",
    free_repository_limit: "Choose the Presto repository",
    plan_limit_reached: "Presto free builds used",
    private_dependency_authentication: "Private dependency access required"
  }[code] ?? "Presto";
  return `::error title=${title}::${escapeWorkflowCommand(message)}`;
}
function fail(error) {
  process.stdout.write(`${failureAnnotation(error)}
`);
  process.exitCode = 1;
}
function escapeWorkflowCommand(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

// src/digests.ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
async function artifactDigests(file) {
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk);
    md5.update(chunk);
  }
  return { sha256: sha256.digest("hex"), md5: md5.digest("hex") };
}

// src/auth-payload.ts
function actionAuthenticationPayload(input2) {
  return {
    oidcToken: input2.oidcToken,
    pullRequest: input2.pullRequest,
    expectedHeadSha: input2.expectedHeadSha,
    phase: input2.phase,
    scheme: input2.scheme
  };
}

// src/process.ts
import { spawn } from "node:child_process";
var diagnosticLimit = 64 * 1024;
var CommandError = class extends Error {
  constructor(command, exitCode, diagnosticOutput) {
    super(`${command} exited with ${exitCode ?? "an unknown status"}. Review the Actions log for details.`);
    this.command = command;
    this.exitCode = exitCode;
    this.diagnosticOutput = diagnosticOutput;
    this.name = "CommandError";
  }
};
function appendDiagnostic(current, chunk) {
  const next = current + chunk.toString();
  return next.length <= diagnosticLimit ? next : next.slice(-diagnosticLimit);
}
async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let diagnosticOutput = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      diagnosticOutput = appendDiagnostic(diagnosticOutput, text);
      if (!options.quiet) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      diagnosticOutput = appendDiagnostic(diagnosticOutput, chunk);
      if (!options.quiet) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new CommandError(command, code, diagnosticOutput)));
  });
}
async function runShell(script) {
  return run("/bin/zsh", ["-eo", "pipefail", "-c", script]);
}

// src/build-diagnostics.ts
var BuildDiagnosticError = class extends Error {
  code = "private_dependency_authentication";
  constructor() {
    super(
      "A private build dependency could not authenticate. Configure its read-only HTTPS token or SSH key in this job before the Presto step, then rerun the workflow. GitHub\u2019s checkout token normally cannot read a different private repository. The failing repository and credentials are intentionally not repeated here; review the build log for the dependency name."
    );
    this.name = "BuildDiagnosticError";
  }
};
var unambiguousGitAuthenticationFailures = [
  /could not read username for/i,
  /authentication failed for/i,
  /permission denied \(publickey\)/i,
  /http basic: access denied/i,
  /the requested url returned error:\s*(?:401|403)\b/i,
  /remote:\s*(?:repository not found|invalid username or password|access denied)/i
];
var dependencyResolutionContext = [
  /could not resolve package dependencies/i,
  /failed to clone repository/i,
  /error installing\s+[^\r\n]+/i,
  /swift package manager|swiftpm|package\.resolved/i,
  /cocoapods|pod install|pod repo/i
];
var contextualAuthenticationFailures = [
  /(?:authentication|authorization) (?:failed|required)/i,
  /(?:missing|invalid|no) credentials?/i,
  /unauthorized|forbidden/i,
  /(?:http|status|response)[^\r\n]{0,24}\b(?:401|403)\b/i
];
function actionableBuildFailure(error) {
  if (!(error instanceof CommandError)) return error;
  const output2 = error.diagnosticOutput;
  const isAuthenticationFailure = unambiguousGitAuthenticationFailures.some((pattern) => pattern.test(output2)) || dependencyResolutionContext.some((pattern) => pattern.test(output2)) && contextualAuthenticationFailures.some((pattern) => pattern.test(output2));
  return isAuthenticationFailure ? new BuildDiagnosticError() : error;
}

// src/github.ts
function pullRequestContext(event) {
  const root = event;
  const number = root.pull_request?.number ?? root.number;
  const branch = root.pull_request?.head?.ref;
  const headSHA = root.pull_request?.head?.sha;
  if (!number || !branch || !headSHA || !/^[0-9a-f]{40}$/.test(headSHA)) throw new Error("Presto must run from a pull_request workflow event.");
  const headRepo = root.pull_request?.head?.repo?.full_name;
  const baseRepo = root.pull_request?.base?.repo?.full_name;
  const fromFork = headRepo && baseRepo ? headRepo !== baseRepo : Boolean(root.pull_request?.head?.repo?.fork);
  return { number, title: root.pull_request?.title, branch, headSHA, fromFork };
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

// src/heartbeat.ts
var workflowHeartbeatIntervalMs = 15 * 60 * 1e3;
var defaultScheduler = {
  every: (callback, intervalMs) => setInterval(callback, intervalMs),
  cancel: (handle) => clearInterval(handle)
};
function startWorkflowHeartbeat(heartbeat, scheduler = defaultScheduler) {
  let active = true;
  let running = false;
  const timer = scheduler.every(() => {
    if (!active || running) return;
    running = true;
    void heartbeat().catch(() => void 0).finally(() => {
      running = false;
    });
  }, workflowHeartbeatIntervalMs);
  timer.unref?.();
  return () => {
    active = false;
    scheduler.cancel(timer);
  };
}

// src/inspect.ts
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
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
async function verifyPullRequestCheckout(root, expectedHeadSHA) {
  try {
    await access(path.join(root, ".git"));
  } catch {
    return false;
  }
  const checkedOutSHA = (await run("git", ["-C", root, "rev-parse", "HEAD"], { quiet: true })).trim();
  if (checkedOutSHA !== expectedHeadSHA) {
    throw new Error(
      "The checked-out commit does not match this pull request. Configure actions/checkout with `ref: ${{ github.event.pull_request.head.sha }}` before the Presto step."
    );
  }
  return true;
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
async function findApp(derivedData, explicit, buildSettingsOutput, appName) {
  if (explicit && appName) throw new Error("Provide either app-path or app-name, not both.");
  if (explicit) {
    await access(explicit);
    return path.resolve(explicit);
  }
  if (buildSettingsOutput) {
    const allCandidates = [...new Set(simulatorAppPathsFromBuildSettings(buildSettingsOutput))];
    const candidates2 = appName ? allCandidates.filter((candidate) => path.basename(candidate, ".app") === appName) : allCandidates;
    if (appName && candidates2.length === 0) throw new Error(`The scheme did not build an iOS app named ${appName}. Choose one of: ${allCandidates.map((candidate) => path.basename(candidate, ".app")).join(", ") || "none"}.`);
    if (candidates2.length > 1) throw new Error(`The scheme builds more than one iOS app (${candidates2.map((candidate) => path.basename(candidate)).join(", ")}). Set the app-name input to the app reviewers should run.`);
    if (candidates2[0]) {
      await access(candidates2[0]);
      return candidates2[0];
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
  const candidates = appName ? found.filter((candidate) => path.basename(candidate.file, ".app") === appName) : found;
  candidates.sort((a, b) => b.modified - a.modified);
  if (!candidates[0]) {
    if (appName) throw new Error(`Xcode completed but no .app product named ${appName} was found in DerivedData.`);
    throw new Error("Xcode completed but no .app product was found in DerivedData.");
  }
  if (candidates.length > 1) throw new Error(`More than one .app product was found (${candidates.map((candidate) => path.basename(candidate.file)).join(", ")}). Set the app-name or app-path input to the app reviewers should run.`);
  return candidates[0].file;
}
async function needsDefaultBuild(explicitAppPath) {
  if (!explicitAppPath) return true;
  try {
    await access(explicitAppPath);
    return false;
  } catch {
    return true;
  }
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
  await saveState("PRESTO_STARTED", "true");
  await saveState("PRESTO_STAGE", "build");
  const root = process.env.GITHUB_WORKSPACE || process.cwd();
  const scheme = input("scheme", true);
  const configuration = input("configuration") || "Debug";
  const derivedData = path2.resolve(root, input("derived-data-path") || ".presto/DerivedData");
  const customCommand = input("build-command");
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GitHub pull request context is unavailable.");
  const context = pullRequestContext(JSON.parse(await readFile(eventPath, "utf8")));
  const publishAttemptId = randomUUID();
  if (context.fromFork) {
    notice("::notice title=Presto::Skipped: pull requests from forks are not built. Push a branch in this repository to get a Run button.");
    await saveState("PRESTO_FINALIZED", "true");
    return;
  }
  const checkoutVerified = await verifyPullRequestCheckout(root, context.headSHA);
  if (!checkoutVerified) {
    notice("::warning title=Presto could not verify the source commit::This job has no Git checkout. Presto assumes the app-path product came from the current pull request head.");
  }
  const baseURL = (input("api-url") || "https://presto.digitalbunker.dev").replace(/\/$/, "");
  const authenticate = async (phase) => {
    const identity = await oidcToken("presto");
    const result = await api(`${baseURL}/api/v1/auth/github-actions`, { method: "POST", body: JSON.stringify(actionAuthenticationPayload({ oidcToken: identity, pullRequest: context.number, expectedHeadSha: context.headSHA, phase, scheme })) });
    if (result.commitSha !== context.headSHA) throw new Error("GitHub API and workflow event disagree about the pull request head commit.");
    mask(result.token);
    return result;
  };
  let auth = await authenticate("building");
  let authenticatedAt = Date.now();
  let authenticationRefresh;
  const refreshAuthentication = async (force = false) => {
    if (!force && Date.now() - authenticatedAt <= 20 * 60 * 1e3) return;
    if (!authenticationRefresh) {
      authenticationRefresh = (async () => {
        const refreshed = await authenticate("none");
        auth = refreshed;
        authenticatedAt = Date.now();
      })().finally(() => {
        authenticationRefresh = void 0;
      });
    }
    await authenticationRefresh;
  };
  const reportFailure = async (stage, previewId) => {
    try {
      await refreshAuthentication();
      const send = () => fetch(`${baseURL}/api/v1/workflow/status`, { method: "POST", headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" }, body: JSON.stringify({ phase: "failed", stage, previewId }) });
      let response = await send();
      if (response.status === 401) {
        await refreshAuthentication(true);
        response = await send();
      }
    } catch {
    }
  };
  const stopHeartbeat = startWorkflowHeartbeat(() => refreshAuthentication(true));
  let appPath;
  let metadata;
  let archive;
  let size;
  let sha256;
  let md5;
  try {
    await mkdir(path2.dirname(derivedData), { recursive: true });
    notice("Presto \xB7 Building iOS Simulator product");
    let buildSettingsOutput;
    const appPathInput = input("app-path");
    const appNameInput = input("app-name");
    if (appPathInput && appNameInput) throw new Error("Provide either app-path or app-name, not both.");
    const requestedAppPath = appPathInput ? path2.resolve(root, appPathInput) : void 0;
    if (customCommand) await runShell(customCommand);
    else if (await needsDefaultBuild(requestedAppPath)) {
      const container = await detectContainer(root, input("workspace"), input("project"));
      const buildArguments = [...container, "-scheme", scheme, "-configuration", configuration, "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", derivedData, "CODE_SIGNING_ALLOWED=NO", "ONLY_ACTIVE_ARCH=NO"];
      await run("xcodebuild", [...buildArguments, "build"], { cwd: root });
      buildSettingsOutput = await run("xcodebuild", [...buildArguments, "-showBuildSettings", "-json"], { cwd: root, quiet: true });
    }
    appPath = await findApp(derivedData, requestedAppPath, buildSettingsOutput, appNameInput || void 0);
    metadata = await inspectApp(appPath);
    notice(`Presto \xB7 Validated ${metadata.displayName} (${metadata.architectures.join(", ")})`);
    const staging = path2.resolve(root, ".presto");
    archive = path2.join(staging, "artifact.zip");
    await mkdir(staging, { recursive: true });
    await rm(archive, { force: true });
    await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, archive], { quiet: true });
    size = (await stat2(archive)).size;
    ({ sha256, md5 } = await artifactDigests(archive));
  } catch (error) {
    stopHeartbeat();
    await reportFailure("build");
    throw actionableBuildFailure(error);
  }
  let createdPreviewId;
  try {
    await saveState("PRESTO_STAGE", "publish");
    await refreshAuthentication();
    mask(auth.token);
    const headers = { authorization: `Bearer ${auth.token}` };
    const created = await api(`${baseURL}/api/v1/previews`, { method: "POST", headers, body: JSON.stringify({ publishAttemptId, pullRequest: context.number, pullRequestTitle: auth.pullRequestTitle || context.title, commitSha: context.headSHA, branch: context.branch, scheme, configuration, ...metadata, artifactSize: size, sha256, md5 }) });
    createdPreviewId = created.preview.previewId;
    await saveState("PRESTO_PREVIEW_ID", createdPreviewId);
    if (created.preview.status !== "ready") {
      if (!created.upload) throw new Error("The preview is not ready and no artifact upload URL was returned.");
      const upload = await fetch(created.upload.url, {
        method: "PUT",
        body: Readable.toWeb(createReadStream2(archive)),
        duplex: "half",
        headers: { ...created.upload.headers, "content-type": "application/zip", "content-length": String(size) }
      });
      if (!upload.ok) throw new Error(`Artifact upload failed with ${upload.status}.`);
    }
    await refreshAuthentication();
    mask(auth.token);
    const complete = () => fetch(`${baseURL}/api/v1/previews/${created.preview.previewId}/complete`, { method: "POST", headers: { authorization: `Bearer ${auth.token}`, accept: "application/json" } });
    let completion = await complete();
    if (completion.status === 401) {
      await refreshAuthentication(true);
      completion = await complete();
    }
    if (!completion.ok) {
      const body = await completion.json().catch(() => ({}));
      throw new Error(body.error?.message || `Presto API returned ${completion.status}.`);
    }
    if (completion.headers.get("x-presto-comment") === "failed") notice("::warning title=Presto::The build is ready but the pull request comment could not be updated. Check the GitHub App installation permissions.");
    const previewURL = `${baseURL}/p/${created.preview.previewId}`;
    await output("preview-id", created.preview.previewId);
    await output("preview-url", previewURL);
    notice(`Presto \xB7 Ready ${previewURL}`);
    await saveState("PRESTO_FINALIZED", "true");
    stopHeartbeat();
  } catch (error) {
    stopHeartbeat();
    await reportFailure("publish", createdPreviewId);
    throw error;
  }
}
if (process.env.NODE_ENV !== "test") main().catch(fail);
export {
  main
};
