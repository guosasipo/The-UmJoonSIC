import * as vscode from 'vscode';
import * as path from 'node:path';
import { EngineClient } from './engineClient';
import { installJavaRuntime, isJava17, managedJava } from './javaRuntime';

let selectedJava: Promise<string> | undefined;
let failed = false;
let preparing: AbortController | undefined;

export function clearJavaCache(): void { preparing?.abort(); preparing = undefined; selectedJava = undefined; failed = false; }

async function findJava(context: vscode.ExtensionContext, output: vscode.OutputChannel, controller: AbortController): Promise<string> {
  const { signal } = controller;
  const configuration = vscode.workspace.getConfiguration('umjoonsic');
  const configured = configuration.get<string>('javaPath', '').trim();
  const candidates = configured ? [configured] : [
    ...(process.env.JAVA_HOME ? [path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')] : []),
    'java',
    ...(process.platform === 'darwin' ? ['/opt/homebrew/opt/openjdk/bin/java', '/usr/local/opt/openjdk/bin/java'] : []),
  ];
  for (const candidate of candidates) {
    const valid = await isJava17(candidate);
    signal.throwIfAborted();
    if (valid) return candidate;
  }
  if (!configured && context.globalStorageUri.scheme === 'file') {
    const storage = context.globalStorageUri.fsPath;
    const cached = await managedJava(storage);
    signal.throwIfAborted();
    if (cached) return cached;
    if (configuration.get('autoInstallJava', true)) {
      return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("UmJoonSIC: Preparing Java"), cancellable: true }, async (progress, token) => {
        const cancel = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        try {
          const installed = await installJavaRuntime(storage, controller.signal, (message, increment) => progress.report({ message: vscode.l10n.t(message), increment }));
          signal.throwIfAborted();
          output.appendLine(vscode.l10n.t('Java is ready: {0}', installed));
          return installed;
        } catch (error) {
          throw new Error(controller.signal.aborted ? vscode.l10n.t("Java setup was cancelled. Run a program to try again.")
            : vscode.l10n.t('Java setup failed: {0}. Select a Java executable or run a program to try again.', vscode.l10n.t(error instanceof Error ? error.message : String(error))));
        } finally { cancel.dispose(); }
      });
    }
  }
  throw new Error(vscode.l10n.t("Java 17 or later is required. Use UmJoonSIC: Select Java Executable or set javaPath."));
}

export async function createEngine(context: vscode.ExtensionContext, output: vscode.OutputChannel, automatic = false): Promise<EngineClient> {
  if (!vscode.workspace.isTrusted) throw new Error(vscode.l10n.t("Running the engine requires a trusted workspace."));
  if (!automatic && failed) clearJavaCache();
  if (!selectedJava) {
    const controller = preparing = new AbortController();
    context.subscriptions.push({ dispose: () => controller.abort() });
    selectedJava = findJava(context, output, controller).finally(() => { if (preparing === controller) preparing = undefined; });
  }
  const pending = selectedJava;
  let javaPath: string;
  try { javaPath = await pending; }
  catch (error) { if (selectedJava === pending) failed = true; throw error; }
  if (selectedJava !== pending) throw new Error(vscode.l10n.t("Java settings changed. Try again."));
  const client = new EngineClient({ javaPath, jarPath: context.asAbsolutePath('engine/dist/umjoonsic-engine.jar') });
  client.on('log', message => output.appendLine(String(message)));
  try {
    await client.ready();
    if (selectedJava !== pending) throw new Error(vscode.l10n.t("Java settings changed. Try again."));
    return client;
  } catch (error) { if (selectedJava === pending) clearJavaCache(); client.dispose(); throw error; }
}

export async function selectJava(): Promise<void> {
  const files = await vscode.window.showOpenDialog({ canSelectMany: false, title: vscode.l10n.t("Select a Java 17 or later executable"), openLabel: vscode.l10n.t("Use Java") });
  if (!files) return;
  await vscode.workspace.getConfiguration('umjoonsic').update('javaPath', files[0].fsPath, vscode.ConfigurationTarget.Global);
  clearJavaCache();
}
