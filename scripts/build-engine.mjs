import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const engine = fileURLToPath(new URL('../engine/', import.meta.url));
const executable = process.platform === 'win32' ? '.exe' : '';
const javac = process.env.UMJOONSIC_JAVAC ||
  (process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin', `javac${executable}`)) ||
  ['/opt/homebrew/opt/openjdk/bin/javac', '/usr/local/opt/openjdk/bin/javac'].find(existsSync) || `javac${executable}`;
const jar = javac.includes('/') || javac.includes('\\') ? join(dirname(javac), `jar${executable}`) : `jar${executable}`;
const gson = join(engine, '.cache/gson-2.10.1.jar');
const hash = '4241c14a7727c34feea6507ec801318a3d4a90f070e4525681079fb94ee4c593';
mkdirSync(dirname(gson), { recursive: true });
if (!existsSync(gson)) {
  const response = await fetch('https://repo.maven.apache.org/maven2/com/google/code/gson/gson/2.10.1/gson-2.10.1.jar');
  if (!response.ok) throw new Error(`Gson download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Gson checksum mismatch');
  writeFileSync(gson, bytes);
}
if (createHash('sha256').update(readFileSync(gson)).digest('hex') !== hash) throw new Error('Cached Gson checksum mismatch');
const classes = join(engine, '.build/classes');
rmSync(classes, { recursive: true, force: true });
mkdirSync(classes, { recursive: true });
mkdirSync(join(engine, 'dist'), { recursive: true });
execFileSync(javac, ['--release', '17', '-encoding', 'UTF-8', '-cp', gson, '-sourcepath', 'src', '-d', classes, 'src/umjoonsic/Main.java'], { cwd: engine, stdio: 'inherit' });
execFileSync(jar, ['xf', gson], { cwd: classes, stdio: 'inherit' });
rmSync(join(classes, 'META-INF/MANIFEST.MF'), { force: true });
execFileSync(jar, ['--create', '--file', join(engine, 'dist/umjoonsic-engine.jar'), '--main-class', 'umjoonsic.Main', '-C', classes, '.'], { stdio: 'inherit' });
console.log('Built engine/dist/umjoonsic-engine.jar (Java 17).');
