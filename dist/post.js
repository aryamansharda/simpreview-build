import { createRequire as __createRequire } from "module";const require=__createRequire(import.meta.url);

// src/post.ts
import { readFile } from "node:fs/promises";

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

// src/action-io.ts
function input(name, required = false) {
  const key = `INPUT_${name.replaceAll("-", "_").toUpperCase()}`;
  const value = process.env[key]?.trim() ?? "";
  if (required && !value) throw new Error(`Input \`${name}\` is required.`);
  return value;
}
function mask(value) {
  process.stdout.write(`::add-mask::${value}
`);
}
function notice(message) {
  process.stdout.write(`${message}
`);
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

// src/post-policy.ts
function pendingPostReport(environment) {
  if (environment.STATE_PRESTO_STARTED !== "true" || environment.STATE_PRESTO_FINALIZED === "true") return void 0;
  const stage = environment.STATE_PRESTO_STAGE === "publish" ? "publish" : "build";
  const previewId = environment.STATE_PRESTO_PREVIEW_ID;
  return { stage, ...previewId && /^[A-Za-z0-9_-]{8,128}$/.test(previewId) ? { previewId } : {} };
}

// src/post.ts
async function post() {
  const pending = pendingPostReport(process.env);
  if (!pending) return;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GitHub pull request context is unavailable.");
  const context = pullRequestContext(JSON.parse(await readFile(eventPath, "utf8")));
  if (context.fromFork) return;
  const baseURL = (input("api-url") || "https://presto.digitalbunker.dev").replace(/\/$/, "");
  const scheme = input("scheme", true);
  const identity = await oidcToken("presto");
  const auth = await api(`${baseURL}/api/v1/auth/github-actions`, {
    method: "POST",
    body: JSON.stringify(actionAuthenticationPayload({ oidcToken: identity, pullRequest: context.number, expectedHeadSha: context.headSHA, phase: "none", scheme }))
  });
  if (auth.commitSha !== context.headSHA) throw new Error("GitHub API and workflow event disagree about the pull request head commit.");
  mask(auth.token);
  await api(`${baseURL}/api/v1/workflow/status`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.token}` },
    body: JSON.stringify({ phase: "failed", stage: pending.stage, previewId: pending.previewId })
  });
  notice("Presto \xB7 Updated the pull request after the workflow stopped early.");
}
if (process.env.NODE_ENV !== "test") post().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  notice(`::warning title=Presto cleanup::Could not update the pull request after the workflow stopped: ${message.replaceAll("\n", "%0A")}`);
});
export {
  post
};
