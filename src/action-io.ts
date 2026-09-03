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

export function mask(value: string) { process.stdout.write(`::add-mask::${value}\n`); }
export function notice(message: string) { process.stdout.write(`${message}\n`); }
export function fail(error: unknown) { const message = error instanceof Error ? error.message : String(error); process.stdout.write(`::error title=SimPreview::${message.replaceAll('\n', '%0A')}\n`); process.exitCode = 1; }

