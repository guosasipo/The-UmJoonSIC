import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function sourceFileKey(value: string, nativeFilename?: string): Promise<string> {
  const uri = new URL(value);
  if (uri.protocol !== 'file:') return value;
  const filename = nativeFilename ?? fileURLToPath(uri);
  const key = await realpath(filename).catch(() => filename);
  return process.platform === 'win32' ? key.toLowerCase() : key;
}
