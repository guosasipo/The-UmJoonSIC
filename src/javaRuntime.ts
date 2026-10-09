import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function isJava17(executable: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await execute(executable, ['-version'], { timeout: 5000, windowsHide: true });
    return Number((stdout + stderr).match(/version "(?:1\.)?(\d+)/)?.[1]) >= 17;
  } catch { return false; }
}

function executable(directory: string): string {
  return process.platform === 'darwin' ? join(directory, 'Contents', 'Home', 'bin', 'java')
    : join(directory, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}

export async function managedJava(storage: string): Promise<string | undefined> {
  try {
    const { directory } = JSON.parse(await readFile(join(storage, 'java', 'runtime.json'), 'utf8'));
    if (typeof directory !== 'string' || !/^temurin17-[a-z0-9]+-[a-z0-9]+-[a-f0-9]{16}(?:-[a-f0-9]{16})?$/.test(directory)) return;
    const candidate = executable(join(storage, 'java', directory));
    if (await isJava17(candidate)) return candidate;
  } catch { /* No valid managed runtime yet. */ }
}

/** Install a verified archive in extension storage without changing JAVA_HOME or PATH. */
export async function installJavaRuntime(storage: string, signal: AbortSignal,
  progress: (message: string, increment?: number) => void = () => {}): Promise<string> {
  signal.throwIfAborted();
  const cached = await managedJava(storage);
  signal.throwIfAborted();
  if (cached) return cached;
  const os = ({ darwin: 'mac', win32: 'windows', linux: 'linux' } as Record<string, string>)[process.platform];
  const arch = ({ arm64: 'aarch64', x64: 'x64', ia32: 'x86' } as Record<string, string>)[process.arch];
  if (!os || !arch) throw new Error("Automatic Java installation is not supported on this platform. Select Java 17 or later.");
  progress("Checking Java download information");
  const metadata = await fetch(`https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=${arch}&image_type=jre&os=${os}&vendor=eclipse`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
  });
  if (!metadata.ok) throw new Error(`Cannot retrieve Java download information (HTTP ${metadata.status}).`);
  const assets = await metadata.json() as { binary?: { package?: { link?: string; checksum?: string; size?: number } } }[];
  const asset = Array.isArray(assets) ? assets[0]?.binary?.package : undefined;
  if (!asset?.link || !asset.checksum || !/^[a-f0-9]{64}$/i.test(asset.checksum) ||
      !Number.isSafeInteger(asset.size) || asset.size! <= 0 || asset.size! > 512 * 1024 * 1024) {
    throw new Error("Java download information is unavailable for this platform.");
  }
  const url = new URL(asset.link);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/adoptium/temurin17-binaries/releases/download/')) {
    throw new Error("This is not an official Temurin download URL.");
  }
  const checksum = asset.checksum.toLowerCase();
  let directory = `temurin17-${process.platform}-${process.arch}-${checksum.slice(0, 16)}`;
  const parent = join(storage, 'java');
  let destination = join(parent, directory);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, 'download-'));
  try {
    const archive = join(temporary, process.platform === 'win32' ? 'runtime.zip' : 'runtime.tar.gz');
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]) });
    if (!response.ok || !response.body) throw new Error(`Java download failed (HTTP ${response.status}).`);
    const hash = createHash('sha256');
    let bytes = 0, previousPercent = 0;
    const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > asset.size!) { callback(new Error("Java download size is incorrect.")); return; }
      hash.update(chunk);
      const percent = Math.floor(bytes * 100 / asset.size!);
      if (percent > previousPercent) { progress("Downloading Java", percent - previousPercent); previousPercent = percent; }
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), verify, createWriteStream(archive), { signal });
    if (bytes !== asset.size || hash.digest('hex') !== checksum) throw new Error("Java download verification failed. Try again.");
    signal.throwIfAborted();
    progress("Installing Java");
    const extracted = join(temporary, 'extracted');
    await mkdir(extracted);
    if (process.platform === 'win32') {
      const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
      await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(extracted)}`],
      { timeout: 120000, windowsHide: true, signal });
    } else {
      await execute('tar', ['-xzf', archive, '-C', extracted], { timeout: 120000, signal });
    }
    const entries = await readdir(extracted, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) throw new Error("The Java archive structure is invalid.");
    const unpacked = join(extracted, entries[0].name);
    if (!await isJava17(executable(unpacked))) throw new Error("The installed Java cannot run. Select a Java executable.");
    signal.throwIfAborted();
    try { await rename(unpacked, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      // Reuse a concurrent install; a damaged cache gets a separate replacement.
      if (!await isJava17(executable(destination))) {
        signal.throwIfAborted();
        directory += `-${randomBytes(8).toString('hex')}`;
        destination = join(parent, directory);
        await rename(unpacked, destination);
      }
    }
    await writeFile(join(temporary, 'runtime.json'), JSON.stringify({ directory }));
    await rename(join(temporary, 'runtime.json'), join(parent, 'runtime.json'));
    signal.throwIfAborted();
    progress("Java is ready");
    return executable(destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
