export type PendingPostReport = { stage: 'build' | 'publish'; previewId?: string };

export function pendingPostReport(environment: NodeJS.ProcessEnv): PendingPostReport | undefined {
  if (environment.STATE_PRESTO_STARTED !== 'true' || environment.STATE_PRESTO_FINALIZED === 'true') return undefined;
  const stage = environment.STATE_PRESTO_STAGE === 'publish' ? 'publish' : 'build';
  const previewId = environment.STATE_PRESTO_PREVIEW_ID;
  return { stage, ...(previewId && /^[A-Za-z0-9_-]{8,128}$/.test(previewId) ? { previewId } : {}) };
}
