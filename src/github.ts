export function pullRequestContext(event: unknown): { number: number; title?: string; branch: string; headSHA: string; fromFork: boolean } {
  const root = event as { pull_request?: { number?: number; title?: string; head?: { ref?: string; sha?: string; repo?: { fork?: boolean; full_name?: string } }; base?: { repo?: { full_name?: string } } }; number?: number };
  const number = root.pull_request?.number ?? root.number;
  const branch = root.pull_request?.head?.ref;
  const headSHA = root.pull_request?.head?.sha;
  if (!number || !branch || !headSHA || !/^[0-9a-f]{40}$/.test(headSHA)) throw new Error('Presto must run from a pull_request workflow event.');
  const headRepo = root.pull_request?.head?.repo?.full_name;
  const baseRepo = root.pull_request?.base?.repo?.full_name;
  // `repo.fork` describes the repository itself, not whether this pull request
  // crosses repositories. A repository fork can still receive safe same-repo
  // pull requests from its own branches.
  const fromFork = headRepo && baseRepo
    ? headRepo !== baseRepo
    : Boolean(root.pull_request?.head?.repo?.fork);
  return { number, title: root.pull_request?.title, branch, headSHA, fromFork };
}

export async function oidcToken(audience: string): Promise<string> {
  const endpoint = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!endpoint || !bearer) throw new Error('GitHub OIDC is unavailable. Add `permissions: id-token: write` to this job.');
  const url = new URL(endpoint);
  url.searchParams.set('audience', audience);
  const response = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } });
  const body = await response.json() as { value?: string; message?: string };
  if (!response.ok || !body.value) throw new Error(body.message || 'GitHub did not issue an OIDC token.');
  return body.value;
}
