export type ActionAuthenticationPhase = 'building' | 'none';

export function actionAuthenticationPayload(input: {
  oidcToken: string;
  pullRequest: number;
  expectedHeadSha: string;
  phase: ActionAuthenticationPhase;
  scheme: string;
}) {
  return {
    oidcToken: input.oidcToken,
    pullRequest: input.pullRequest,
    expectedHeadSha: input.expectedHeadSha,
    phase: input.phase,
    scheme: input.scheme,
  };
}
