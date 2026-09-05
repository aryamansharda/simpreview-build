import { CommandError } from './process.js';

export class BuildDiagnosticError extends Error {
  readonly code = 'private_dependency_authentication';

  constructor() {
    super(
      'A private build dependency could not authenticate. Configure its read-only HTTPS token or SSH key in this job before the Presto step, then rerun the workflow. GitHub’s checkout token normally cannot read a different private repository. The failing repository and credentials are intentionally not repeated here; review the build log for the dependency name.',
    );
    this.name = 'BuildDiagnosticError';
  }
}

const unambiguousGitAuthenticationFailures = [
  /could not read username for/i,
  /authentication failed for/i,
  /permission denied \(publickey\)/i,
  /http basic: access denied/i,
  /the requested url returned error:\s*(?:401|403)\b/i,
  /remote:\s*(?:repository not found|invalid username or password|access denied)/i,
];

const dependencyResolutionContext = [
  /could not resolve package dependencies/i,
  /failed to clone repository/i,
  /error installing\s+[^\r\n]+/i,
  /swift package manager|swiftpm|package\.resolved/i,
  /cocoapods|pod install|pod repo/i,
];

const contextualAuthenticationFailures = [
  /(?:authentication|authorization) (?:failed|required)/i,
  /(?:missing|invalid|no) credentials?/i,
  /unauthorized|forbidden/i,
  /(?:http|status|response)[^\r\n]{0,24}\b(?:401|403)\b/i,
];

export function actionableBuildFailure(error: unknown): unknown {
  if (!(error instanceof CommandError)) return error;
  const output = error.diagnosticOutput;
  const isAuthenticationFailure = unambiguousGitAuthenticationFailures.some(pattern => pattern.test(output))
    || (
      dependencyResolutionContext.some(pattern => pattern.test(output))
      && contextualAuthenticationFailures.some(pattern => pattern.test(output))
    );
  return isAuthenticationFailure ? new BuildDiagnosticError() : error;
}
