import { spawn } from 'node:child_process';

const diagnosticLimit = 64 * 1024;

export class CommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly exitCode: number | null,
    public readonly diagnosticOutput: string,
  ) {
    super(`${command} exited with ${exitCode ?? 'an unknown status'}. Review the Actions log for details.`);
    this.name = 'CommandError';
  }
}

function appendDiagnostic(current: string, chunk: Buffer | string) {
  const next = current + chunk.toString();
  return next.length <= diagnosticLimit ? next : next.slice(-diagnosticLimit);
}

export async function run(command: string, args: string[], options: { cwd?: string; quiet?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let diagnosticOutput = '';
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      diagnosticOutput = appendDiagnostic(diagnosticOutput, text);
      if (!options.quiet) process.stdout.write(text);
    });
    child.stderr.on('data', chunk => {
      diagnosticOutput = appendDiagnostic(diagnosticOutput, chunk);
      if (!options.quiet) process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new CommandError(command, code, diagnosticOutput)));
  });
}

export async function runShell(script: string) { return run('/bin/zsh', ['-eo', 'pipefail', '-c', script]); }
