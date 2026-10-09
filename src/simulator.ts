import * as vscode from 'vscode';
import * as path from 'node:path';
import { Diagnostics } from './diagnostics';
import { clearJavaCache, createEngine, selectJava } from './java';
import { UmJoonDebugSession } from './debug';
import { captureDelaySource, chooseConfiguration, chooseMain, configureDevices, configureFiles, currentFolder, importProject, newProject, prepareLaunch, reorderFiles, saveStepDelay, type ProjectTarget } from './projects';
import { getProject, onDidChangeProjects, projectConfiguration, refreshProjects } from './projectFiles';
import type { AssemblyResult, Snapshot } from './protocol';
import { Views } from './views';
import { getDeviceUsage } from './deviceUsage';

export function registerSimulator(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('UmJoonSIC');
  const diagnostics = new Diagnostics(context, output);
  const views = new Views(context);
  const delayStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 109);
  delayStatus.name = 'UmJoonSIC automatic step delay';
  delayStatus.command = 'umjoonsic.setDelay';
  delayStatus.tooltip = vscode.l10n.t("Change execution interval (0 ms = full speed)");
  let disposed = false;
  const seenSessions = new Set<string>();
  let activeAdapter: UmJoonDebugSession | undefined;
  let assembling = false;
  let artifactWrites = Promise.resolve();

  function requireIdle(): void {
    if (activeAdapter) throw new Error(vscode.l10n.t("Stop the current SIC session before starting another."));
    if (assembling) throw new Error(vscode.l10n.t("Wait for assembly to finish before starting again."));
  }

  function error(error: unknown): void {
    if (disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    void vscode.window.showErrorMessage(message);
  }
  function command(name: string, action: (...args: any[]) => PromiseLike<unknown>): vscode.Disposable {
    return vscode.commands.registerCommand(`umjoonsic.${name}`, (...args) => Promise.resolve().then(() => action(...args)).catch(error));
  }
  function updateStatus(): void {
    const session = vscode.debug.activeDebugSession;
    if (session?.type === 'umjoonsic') {
      delayStatus.text = `$(watch) ${session.configuration.stepDelayMs ?? 250} ms`;
      delayStatus.show();
    } else delayStatus.hide();
    views.refreshState();
  }
  async function writeArtifacts(result: AssemblyResult, programs: string[], folder?: vscode.WorkspaceFolder, projectFile?: string): Promise<void> {
    if (!result.success || !programs.length) return;
    const project = !folder && typeof projectFile === 'string' ? vscode.Uri.parse(projectFile) : undefined;
    const base = folder?.uri ?? (project?.scheme === 'file' ? vscode.Uri.joinPath(project, '..') : vscode.Uri.file(path.dirname(programs[0])));
    // A closed adapter may still be exporting.
    // ponytail: one queue for the single runtime; split by output folder if parallel runs are supported.
    const pending = artifactWrites.catch(() => {}).then(async () => {
      if (disposed) return;
      const out = vscode.Uri.joinPath(base, '.out');
      await vscode.workspace.fs.createDirectory(out);
      for (const artifact of result.artifacts) {
        if (disposed) return;
        if (!artifact.name || /[\\/]/.test(artifact.name) || artifact.name === '.' || artifact.name === '..') throw new Error(vscode.l10n.t("Invalid engine artifact name."));
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(out, artifact.name), Buffer.from(artifact.content, 'utf8'));
      }
      if (!disposed) output.appendLine(vscode.l10n.t('Assembly complete: {0} artifacts → {1}', result.artifacts.length, out.fsPath));
    });
    artifactWrites = pending;
    await pending;
  }

  context.subscriptions.push(
    { dispose() { disposed = true; activeAdapter?.dispose(); } }, output, diagnostics, views, delayStatus,
    vscode.window.registerWebviewViewProvider('umjoonsic.debugger', views),
    vscode.workspace.onDidOpenTextDocument(document => diagnostics.schedule(document)),
    vscode.workspace.onDidChangeTextDocument(event => {
      diagnostics.schedule(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument(document => diagnostics.close(document)),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { for (const document of vscode.workspace.textDocuments) diagnostics.schedule(document); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('umjoonsic.javaPath') || event.affectsConfiguration('umjoonsic.autoInstallJava')) { clearJavaCache(); diagnostics.reset(); }
      if (event.affectsConfiguration('umjoonsic')) for (const document of vscode.workspace.textDocuments) diagnostics.schedule(document);
      updateStatus();
    }),
    onDidChangeProjects(() => {
      for (const document of vscode.workspace.textDocuments) diagnostics.schedule(document);
      updateStatus();
    }),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.debug.onDidChangeActiveDebugSession(() => {
      updateStatus();
      for (const document of vscode.workspace.textDocuments) diagnostics.schedule(document);
    }),
    vscode.debug.onDidTerminateDebugSession(session => { seenSessions.delete(session.id); views.terminate(session); updateStatus(); }),
    vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
      if (event.session.type === 'umjoonsic' && event.event === 'umjoonsic.devices') { views.captureDevices(event.session, event.body); return; }
      if (event.session.type !== 'umjoonsic' || event.event !== 'umjoonsic.state') return;
      const snapshot = event.body as Snapshot;
      let assembly: Promise<AssemblyResult> | undefined;
      if (!seenSessions.has(event.session.id)) {
        seenSessions.add(event.session.id);
        assembly = Promise.resolve(event.session.customRequest('umjoonsic.listing'));
        void assembly.then(async result => {
          if (disposed || !seenSessions.has(event.session.id)) return;
          await writeArtifacts(result, event.session.configuration.programs ?? [], event.session.workspaceFolder, event.session.configuration.projectFile);
        }).catch(error);
      }
      void views.state(event.session, snapshot, assembly).catch(error);
      updateStatus();
    }),
    vscode.debug.registerDebugAdapterDescriptorFactory('umjoonsic', {
      createDebugAdapterDescriptor() {
        // Reserve the single runtime before Java starts; release on every adapter disposal path.
        requireIdle();
        const adapter: UmJoonDebugSession = new UmJoonDebugSession({
          createClient: () => createEngine(context, output),
          onDispose: () => { if (activeAdapter === adapter) activeAdapter = undefined; },
        });
        activeAdapter = adapter;
        return new vscode.DebugAdapterInlineImplementation(adapter);
      },
    }),
    vscode.debug.registerDebugConfigurationProvider('umjoonsic', {
      async provideDebugConfigurations(folder) {
        await refreshProjects();
        const project = getProject(folder);
        return [project?.data ? projectConfiguration(project) : { type: 'umjoonsic', request: 'launch', name: vscode.l10n.t("Current SIC file"), programs: ['${file}'], stopOnEntry: true }];
      },
      resolveDebugConfiguration(folder, config) {
        return captureDelaySource(folder, { ...config, type: 'umjoonsic', request: 'launch', name: config.name || vscode.l10n.t("Current SIC file") });
      },
      async resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
        try {
          requireIdle();
          const owner = folder ?? currentFolder();
          const resolved = await prepareLaunch(owner, config);
          const connected = new Set(resolved.fileDevices?.map(device => device.index));
          const missing = getDeviceUsage(resolved.sources.map(source => source.text), resolved.mode).filter(device => !connected.has(device.index));
          if (missing.length) {
            const proceed = vscode.l10n.t('Run anyway'), configure = vscode.l10n.t('Connect devices');
            const choice = await vscode.window.showWarningMessage(vscode.l10n.t('Devices {0} have no files. Reads return 0 and output is discarded.', missing.map(device => `0x${device.index.toString(16).toUpperCase().padStart(2, '0')}`).join(', ')), proceed, configure);
            if (choice === configure) await configureDevices(owner?.uri);
            if (choice !== proceed) return undefined;
          }
          if (config.noDebug) resolved.stopOnEntry = false;
          return resolved;
        } catch (problem) { error(problem); return undefined; }
      },
    }),
    command('selectJava', selectJava),
    command('javaInstallGuide', () => vscode.env.openExternal(vscode.Uri.parse('https://adoptium.net/temurin/releases/?version=17'))),
    command('configureFiles', configureFiles),
    command('chooseMain', chooseMain),
    command('configureDevices', configureDevices),
    command('newProject', newProject),
    command('reorderFiles', reorderFiles),
    command('importProject', importProject),
    command('showListing', () => views.showListing()),
    command('showMemory', () => views.showDebugger()),
    command('showDebugger', () => views.showDebugger()),
    command('revealInListing', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await views.revealSource(editor.document.uri, editor.selection.active.line);
    }),
    command('revealMemory', context => views.revealVariable(context)),
    command('revealPC', () => views.revealPC()),
    command('checkSyntax', async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (document?.languageId === 'umjoonsic') await diagnostics.analyze(document);
    }),
    command('assemble', async (target?: ProjectTarget) => {
      requireIdle();
      assembling = true;
      try {
        const choice = await chooseConfiguration(target);
        if (!choice) return;
        const args = await prepareLaunch(choice.folder, choice.config);
        const result = await (await diagnostics.engine()).request<AssemblyResult>('assemble', args);
        const documents = await Promise.all(args.sources.map(source => vscode.workspace.openTextDocument(vscode.Uri.parse(source.uri))));
        diagnostics.publish(result.diagnostics, documents.filter((document, index) => document.getText() === args.sources[index].text));
        if (!result.success) {
          output.appendLine(result.diagnostics.map(item => item.message).join('\n'));
          await vscode.commands.executeCommand('workbench.actions.view.problems');
          return;
        }
        await writeArtifacts(result, args.programs!, choice.folder, args.projectFile);
        views.setAssembly(result, args.sources, choice.folder, args.mode);
        await views.showListing();
      } finally {
        assembling = false;
      }
    }),
    command('run', async (target?: ProjectTarget) => {
      const choice = await chooseConfiguration(target);
      if (choice) await vscode.debug.startDebugging(choice.folder, { ...choice.config, stopOnEntry: false }, { suppressDebugView: true });
    }),
    command('debug', async (target?: ProjectTarget) => {
      const choice = await chooseConfiguration(target);
      if (choice) await vscode.debug.startDebugging(choice.folder, { ...choice.config, stopOnEntry: true }, { suppressDebugView: true });
    }),
    command('setDelay', async (target?: ProjectTarget, displayedSession?: vscode.DebugSession, requested?: number) => {
      await refreshProjects();
      if (displayedSession && (displayedSession.type !== 'umjoonsic' || !seenSessions.has(displayedSession.id))) throw new Error(vscode.l10n.t("The displayed session has ended."));
      const active = displayedSession ?? (vscode.debug.activeDebugSession?.type === 'umjoonsic' ? vscode.debug.activeDebugSession : undefined);
      const folder = target ? currentFolder(target) : active?.workspaceFolder ?? currentFolder();
      const session = !target || active?.workspaceFolder?.uri.toString() === folder?.uri.toString() ? active : undefined;
      const project = getProject(folder);
      if (project?.error) throw new Error(project.error);
      const previous = session?.configuration.stepDelayMs ?? project?.data?.stepDelayMs ?? vscode.workspace.getConfiguration('umjoonsic', folder?.uri).get('stepDelayMs', 250);
      const input = requested === undefined ? await vscode.window.showInputBox({ title: vscode.l10n.t("Execution interval (ms)"), value: String(previous), prompt: vscode.l10n.t("0 = full speed, up to 60000 ms."), validateInput: value => /^\d+$/.test(value) && Number(value) <= 60000 ? undefined : vscode.l10n.t("Enter an integer from 0 to 60000.") }) : requested;
      if (input === undefined) return;
      const value = Number(input);
      if (!Number.isInteger(value) || value < 0 || value > 60000) throw new Error(vscode.l10n.t('Enter an integer from 0 to 60000.'));
      if (session) { await session.customRequest('umjoonsic.setDelay', { delayMs: value }); session.configuration.stepDelayMs = value; }
      try { await saveStepDelay(folder, session?.configuration, value); }
      finally { updateStatus(); }
    }),
  );
  for (const document of vscode.workspace.textDocuments) diagnostics.schedule(document);
}
