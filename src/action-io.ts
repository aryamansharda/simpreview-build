import { appendFile } from 'node:fs/promises';

export function input(name: string, required = false): string {
  const key = `INPUT_${name.replaceAll('-', '_').toUpperCase()}`;
  const value = process.env[key]?.trim() ?? '';
  if (required && !value) throw new Error(`Input \`${name}\` is required.`);
  return value;
}

export async function output(name: string, value: string) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  await appendFile(path, `${name}=${value}\n`, 'utf8');
}

export async function saveState(name: string, value: string) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('Action state names must use uppercase letters, numbers, and underscores.');
  if (value.includes('\n') || value.includes('\r')) throw new Error('Action state values must fit on one line.');
  const statePath = process.env.GITHUB_STATE;
  if (!statePath) return;
  await appendFile(statePath, `${name}=${value}\n`, 'utf8');
}

export function mask(value: string) { process.stdout.write(`::add-mask::${value}\n`); }
export function notice(message: string) { process.stdout.write(`${message}\n`); }

export function failureAnnotation(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  const title = {
    seat_required: 'Presto seat required',
    free_repository_limit: 'Choose the Presto repository',
    plan_limit_reached: 'Presto free builds used',
    private_dependency_authentication: 'Private dependency access required',
  }[code] ?? 'Presto';
  return `::error title=${title}::${escapeWorkflowCommand(message)}`;
}

export function fail(error: unknown) {
  process.stdout.write(`${failureAnnotation(error)}\n`);
  process.exitCode = 1;
}

function escapeWorkflowCommand(value: string) {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}
