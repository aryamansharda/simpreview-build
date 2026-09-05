import { spawn } from 'node:child_process';

export async function run(command: string, args: string[], options: { cwd?: string; quiet?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', chunk => { const text = chunk.toString(); stdout += text; if (!options.quiet) process.stdout.write(text); });
    child.stderr.on('data', chunk => { if (!options.quiet) process.stderr.write(chunk); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with ${code}. Review the Actions log for details.`)));
  });
}

export async function runShell(script: string) { return run('/bin/zsh', ['-eo', 'pipefail', '-c', script]); }
