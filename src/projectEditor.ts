import * as vscode from 'vscode';
import * as path from 'node:path';
import { realpath, writeFile } from 'node:fs/promises';
import { getSymbols } from './language';
import { getDeviceUsage, type DeviceUsage } from './deviceUsage';
import { isForeignProjectPath, parseProject, projectFileUri, relativeProjectPath, uniqueSourcePaths, type ProjectData } from './projectFiles';
import { projectEditorHtml } from './projectEditorHtml';

export type ProjectChange =
  | { type: 'main'; value: string }
  | { type: 'mode'; value: 'sic' | 'sicxe' }
  | { type: 'delay'; value: number }
  | { type: 'addSource'; path: string }
  | { type: 'removeSource'; path: string }
  | { type: 'moveSource'; path: string; direction: -1 | 1 }
  | { type: 'reorderSource'; path: string; before?: string }
  | { type: 'setDevice'; index: number; path: string }
  | { type: 'removeDevice'; index: number };

const queues = new WeakMap<vscode.TextDocument, Promise<void>>();
const editing = new WeakSet<vscode.TextDocument>();

function enqueue(document: vscode.TextDocument, operation: () => Promise<void>): Promise<void> {
  const pending = (queues.get(document) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (document.isClosed) throw new Error(vscode.l10n.t('The project file was closed. Open it again.'));
    await operation();
  });
  queues.set(document, pending);
  void pending.finally(() => { if (queues.get(document) === pending) queues.delete(document); }).catch(() => {});
  return pending;
}

function validPath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.includes('${')) throw new Error(vscode.l10n.t('Enter a file path.'));
}

function validIndex(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) throw new Error(vscode.l10n.t('Device numbers must be integers from 0 to 255.'));
}

function validateChange(value: unknown): asserts value is ProjectChange {
  if (!value || typeof value !== 'object') throw new Error(vscode.l10n.t('Invalid project edit request.'));
  const change = value as Record<string, unknown>;
  switch (change.type) {
    case 'main':
      if (typeof change.value !== 'string' || change.value.includes('\0')) throw new Error(vscode.l10n.t('Main must be a program name string.'));
      return;
    case 'mode':
      if (change.value !== 'sic' && change.value !== 'sicxe') throw new Error(vscode.l10n.t('Choose SIC or SIC/XE mode.'));
      return;
    case 'delay':
      if (typeof change.value !== 'number' || !Number.isInteger(change.value) || change.value < 0 || change.value > 60000) throw new Error(vscode.l10n.t('The step interval must be an integer from 0 to 60000 ms.'));
      return;
    case 'addSource': case 'removeSource': case 'moveSource': case 'reorderSource':
      validPath(change.path);
      if (!/\.asm$/i.test(change.path)) throw new Error(vscode.l10n.t('Only .asm files can be added to the assembly list.'));
      if (change.type === 'moveSource' && change.direction !== -1 && change.direction !== 1) throw new Error(vscode.l10n.t('Invalid file move direction.'));
      if (change.type === 'reorderSource' && change.before !== undefined) {
        validPath(change.before);
        if (!/\.asm$/i.test(change.before)) throw new Error(vscode.l10n.t('Choose an assembly file as the drop position.'));
      }
      return;
    case 'setDevice':
      validPath(change.path);
      validIndex(change.index);
      return;
    case 'removeDevice':
      validIndex(change.index);
      return;
    default: throw new Error(vscode.l10n.t('Unsupported project edit request.'));
  }
}

function directory(document: vscode.TextDocument): vscode.Uri {
  return vscode.Uri.joinPath(document.uri, '..');
}

function fileUri(document: vscode.TextDocument, filename: string): vscode.Uri {
  return projectFileUri(directory(document), filename);
}

async function applyChange(document: vscode.TextDocument, change: ProjectChange): Promise<void> {
  validateChange(change);
  if (document.isClosed) throw new Error(vscode.l10n.t('The project file was closed. Open it again.'));
  let filename: string | undefined;
  if (change.type === 'addSource' || change.type === 'setDevice') {
    const uri = fileUri(document, change.path);
    if (!((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File)) throw new Error(vscode.l10n.t('Choose a file. Folders cannot be added.'));
    filename = await relativeProjectPath(directory(document), uri);
  }
  // Read after asynchronous validation so another editor's latest fields survive.
  const original = document.getText();
  const data = parseProject(original);
  switch (change.type) {
    case 'main': data.main = change.value; break;
    case 'mode': data.mode = change.value; break;
    case 'delay': data.stepDelayMs = change.value; break;
    case 'addSource': {
      data.asm = await uniqueSourcePaths(directory(document), [...data.asm, filename!]);
      break;
    }
    case 'removeSource': case 'moveSource': {
      const index = data.asm.indexOf(change.path);
      if (index < 0) throw new Error(vscode.l10n.t('The file is not in the assembly list.'));
      if (change.type === 'removeSource') data.asm.splice(index, 1);
      else {
        const target = index + change.direction;
        if (target >= 0 && target < data.asm.length) [data.asm[index], data.asm[target]] = [data.asm[target], data.asm[index]];
      }
      break;
    }
    case 'reorderSource': {
      if (!data.asm.includes(change.path)) throw new Error(vscode.l10n.t('The assembly file is no longer in the list.'));
      if (change.before === change.path) break;
      const ordered = data.asm.filter(filename => filename !== change.path);
      const target = change.before === undefined ? ordered.length : ordered.indexOf(change.before);
      if (target < 0) throw new Error(vscode.l10n.t('The drop position is no longer in the list.'));
      ordered.splice(target, 0, change.path);
      data.asm = ordered;
      break;
    }
    case 'setDevice': {
      const devices = data.filedevices ??= [];
      const index = devices.findIndex(device => device.index === change.index);
      if (index < 0) devices.push({ index: change.index, filename: filename! });
      else devices[index] = { ...devices[index], filename: filename! };
      break;
    }
    case 'removeDevice':
      if (!data.filedevices?.some(device => device.index === change.index)) throw new Error(vscode.l10n.t('The device is not connected.'));
      data.filedevices = data.filedevices.filter(device => device.index !== change.index);
      break;
  }
  if (document.isClosed || document.getText() !== original) throw new Error(vscode.l10n.t('Project settings changed in another editor. Try again.'));
  parseProject(JSON.stringify(data));
  if (JSON.stringify(data) === JSON.stringify(parseProject(original))) return;
  const indent = original.match(/\n([\t ]+)\S/)?.[1] ?? '  ';
  const newline = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const text = (original.startsWith('\uFEFF') ? '\uFEFF' : '') + JSON.stringify(data, null, indent).replace(/\n/g, newline) + newline;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(original.length)), text);
  editing.add(document);
  try {
    if (!await vscode.workspace.applyEdit(edit)) throw new Error(vscode.l10n.t('Could not edit project settings. Try again.'));
  } finally {
    editing.delete(document);
  }
}

export function updateProjectDocument(document: vscode.TextDocument, change: ProjectChange): Promise<void> {
  return enqueue(document, () => applyChange(document, change));
}

async function projectSources(document: vscode.TextDocument, data: ProjectData, mode: 'sic' | 'sicxe') {
  const base = directory(document);
  const root = base.scheme === 'file' ? await realpath(base.fsPath) : base.path;
  const sections: Record<string, string[]> = Object.create(null), missing: string[] = [], texts: string[] = [];
  for (const filename of data.asm) {
    try {
      const uri = fileUri(document, filename);
      const open = vscode.workspace.textDocuments.find(source => !source.isClosed && source.uri.toString() === uri.toString());
      const stat = await vscode.workspace.fs.stat(uri);
      if (!(stat.type & vscode.FileType.File)) { missing.push(filename); continue; }
      if (!open && stat.size > 1_000_000) continue;
      const target = uri.scheme === 'file' ? await realpath(uri.fsPath) : uri.path;
      const relative = (uri.scheme === 'file' ? path : path.posix).relative(root, target);
      const paths = uri.scheme === 'file' ? path : path.posix;
      if (!vscode.workspace.isTrusted && (relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))) continue;
      const text = open?.getText() ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      if (text.length > 1_000_000) continue;
      sections[filename] = getSymbols(text, mode).filter(symbol => symbol.kind === 'section').map(symbol => symbol.name);
      texts.push(text);
    } catch { missing.push(filename); }
  }
  return { sections, missing, devices: getDeviceUsage(texts, mode) };
}

async function devicePaths(document: vscode.TextDocument, data: ProjectData): Promise<Record<number, { exists: boolean; usable: boolean }>> {
  const paths = await Promise.all((data.filedevices ?? []).map(async device => {
    if (isForeignProjectPath(directory(document), device.filename)) return [device.index, { exists: false, usable: false }] as const;
    const uri = fileUri(document, device.filename);
    const stat = await vscode.workspace.fs.stat(uri).then(stat => stat, () => undefined);
    const exists = !!(stat && (stat.type & vscode.FileType.File));
    const parent = !stat ? await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, '..')).then(stat => stat, () => undefined) : undefined;
    return [device.index, { exists, usable: exists || !!(parent && (parent.type & vscode.FileType.Directory)) }] as const;
  }));
  return Object.fromEntries(paths);
}

function deviceName(index: number, devices: DeviceUsage[]): string {
  const symbol = devices.find(device => device.index === index)?.labels[0];
  return symbol && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(symbol) ? symbol.toLowerCase() : `dev${index.toString(16).toUpperCase().padStart(2, '0')}`;
}

async function createDevice(document: vscode.TextDocument, index: number, devices: DeviceUsage[], selected?: vscode.Uri): Promise<void> {
  validIndex(index);
  const base = directory(document);
  if (base.scheme !== 'file' || (selected && selected.scheme !== 'file')) throw new Error(vscode.l10n.t('Creating a device file requires a local or Remote folder.'));
  parseProject(document.getText());
  const name = deviceName(index, devices);
  for (let suffix = 1; ; suffix++) {
    if (document.isClosed) throw new Error(vscode.l10n.t('The project file was closed. Open it again.'));
    const uri = selected ?? vscode.Uri.joinPath(base, `${name}${suffix === 1 ? '' : suffix}.txt`);
    try { await writeFile(uri.fsPath, '', { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!selected) continue;
    }
    // Undo disconnects the device; a file may already contain execution output, so keep it.
    await applyChange(document, { type: 'setDevice', index, path: await relativeProjectPath(base, uri) });
    return;
  }
}

export function registerProjectEditor(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('umjoonsic.project', {
    resolveCustomTextEditor(document, panel) {
      const base = directory(document);
      let disposed = false, ready = false, running = false, pending = false, forceNext = false, visible = panel.visible;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let candidates: string[] = [];
      let sources: Awaited<ReturnType<typeof projectSources>> = { sections: {}, missing: [], devices: [] };
      let paths: Awaited<ReturnType<typeof devicePaths>> = {};
      let candidatesDirty = true, namesRevision = 0, cachedRevision = -1, namesKey = '';
      let pathsDirty = true, pathsKey = '';
      let deviceSession = '';
      let relatedSources = new Set<string>();
      let relatedDevices = new Set<string>();
      let requestError: string | undefined;
      const uriKey = (uri: vscode.Uri) => process.platform === 'win32' ? uri.toString().toLowerCase() : uri.toString();
      panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
      const fileChoices = async (files: vscode.Uri[]) => (await Promise.all(files.map(uri =>
        relativeProjectPath(base, uri).then(label => ({ label, uri }), () => undefined))))
        .filter((file): file is { label: string; uri: vscode.Uri } => !!file);
      const refreshCandidates = async (): Promise<void> => {
        try {
          const files = await vscode.workspace.findFiles(new vscode.RelativePattern(base, '**/*.[aA][sS][mM]'), '**/{.git,node_modules,.out,out}/**');
          candidates = [...new Set((await fileChoices(files)).map(file => file.label))].sort();
        } catch { candidates = []; }
      };
      const flushState = async (): Promise<void> => {
        running = true;
        try {
          while (pending && ready && panel.visible && !disposed) {
            pending = false;
            const force = forceNext;
            forceNext = false;
            const settings = vscode.workspace.getConfiguration('umjoonsic', document.uri);
            let data: ProjectData | null = null, error = requestError;
            let mode: 'sic' | 'sicxe' = settings.get('mode') === 'sicxe' ? 'sicxe' : 'sic';
            let stepDelayMs = settings.get('stepDelayMs', 250);
            try {
              data = parseProject(document.getText());
              mode = data.mode ?? mode;
              stepDelayMs = data.stepDelayMs ?? stepDelayMs;
              relatedSources = new Set(data.asm.filter(filename => !isForeignProjectPath(base, filename)).map(filename => uriKey(fileUri(document, filename))));
              relatedDevices = new Set((data.filedevices ?? []).filter(device => !isForeignProjectPath(base, device.filename)).map(device => uriKey(fileUri(document, device.filename))));
              if (candidatesDirty) { candidatesDirty = false; await refreshCandidates(); }
              const key = JSON.stringify([data.asm, mode]);
              const revision = namesRevision;
              if (key !== namesKey || revision !== cachedRevision) {
                sources = await projectSources(document, data, mode);
                namesKey = key;
                cachedRevision = revision;
              }
              const deviceKey = JSON.stringify(data.filedevices);
              if (pathsDirty || deviceKey !== pathsKey) {
                pathsDirty = false;
                paths = await devicePaths(document, data);
                pathsKey = deviceKey;
              }
            } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
            if (pending || !panel.visible) { forceNext ||= force; continue; }
            if (!disposed) await panel.webview.postMessage({ type: 'state', data, dirty: document.isDirty, fileName: document.uri.fsPath, error, candidates,
              mainCandidates: data ? [...new Set(Object.values(sources.sections).flat())] : [], sections: sources.sections, missingSources: sources.missing,
              deviceUsage: sources.devices, devicePaths: paths, autoSave: vscode.workspace.getConfiguration('files', document.uri).get('autoSave', 'off') !== 'off', mode, stepDelayMs, force });
          }
        } finally { running = false; }
      };
      const sendState = (force = false): void => {
        pending = true;
        forceNext ||= force;
        if (disposed || !ready || !panel.visible || running || timer) return;
        // Coalesce document and file events; a single in-flight scan always finishes before the next.
        timer = setTimeout(() => { timer = undefined; void flushState(); }, 25);
      };
      const sourceChanged = (uri: vscode.Uri, filesChanged = false): void => {
        if (filesChanged) candidatesDirty = true;
        const key = uriKey(uri), prefix = `${key.replace(/\/$/, '')}/`;
        const affects = (files: Set<string>) => files.has(key) || (filesChanged && [...files].some(file => file.startsWith(prefix)));
        const related = affects(relatedSources);
        if (related) namesRevision++;
        if (filesChanged && affects(relatedDevices)) pathsDirty = true;
        if (related || filesChanged) sendState();
      };
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, '**/*'));
      const listeners = [
        watcher,
        watcher.onDidCreate(uri => sourceChanged(uri, true)),
        watcher.onDidDelete(uri => sourceChanged(uri, true)),
        watcher.onDidChange(uri => sourceChanged(uri)),
        vscode.workspace.onDidOpenTextDocument(source => sourceChanged(source.uri)),
        vscode.workspace.onDidCloseTextDocument(source => sourceChanged(source.uri)),
        vscode.workspace.onDidChangeTextDocument(event => {
          if (event.document === document) sendState(!editing.has(document));
          else sourceChanged(event.document.uri);
        }),
        vscode.workspace.onDidSaveTextDocument(saved => { if (saved === document) sendState(); }),
        vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('umjoonsic', document.uri) || event.affectsConfiguration('files.autoSave', document.uri)) sendState(true); }),
        vscode.workspace.onDidGrantWorkspaceTrust(() => { namesRevision++; sendState(); }),
        vscode.window.onDidChangeWindowState(state => {
          if (state.focused) { namesRevision++; pathsDirty = true; candidatesDirty = true; sendState(); }
        }),
        vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
          if (event.session.type === 'umjoonsic' && event.event === 'umjoonsic.state' && (deviceSession !== event.session.id || event.body?.reason === 'entry')) {
            deviceSession = event.session.id; pathsDirty = true; sendState();
          }
        }),
        panel.onDidChangeViewState(() => {
          if (panel.visible && !visible) { candidatesDirty = true; pathsDirty = true; namesRevision++; sendState(true); }
          visible = panel.visible;
        }),
        panel.webview.onDidReceiveMessage((message: unknown) => {
          const handle = async (): Promise<void> => {
            if (!message || typeof message !== 'object') throw new Error(vscode.l10n.t('Invalid settings request.'));
            const request = message as Record<string, unknown>;
            requestError = undefined;
            switch (request.type) {
              case 'ready': ready = true; candidatesDirty = true; pathsDirty = true; namesRevision++; sendState(true); return;
              case 'edit': validateChange(request.change); await updateProjectDocument(document, request.change); sendState(); return;
              case 'pickSources':
                await enqueue(document, async () => {
                  const files = await vscode.window.showOpenDialog({ defaultUri: base, canSelectMany: true, canSelectFiles: true, canSelectFolders: false, filters: { 'Assembly source': ['asm'] }, title: vscode.l10n.t('Choose assembly files') });
                  for (const uri of files ?? []) await applyChange(document, { type: 'addSource', path: await relativeProjectPath(base, uri) });
                });
                return;
              case 'pickDevice':
                validIndex(request.index);
                await enqueue(document, async () => {
                  const files = await vscode.workspace.findFiles(new vscode.RelativePattern(base, '**/*'), '**/{.git,.vscode,node_modules,.out,out}/**');
                  const mapped = parseProject(document.getText()).filedevices?.find(device => device.index === request.index);
                  const available = files.filter(uri => !/\.(?:asm|sic|lst|obj)$/i.test(uri.path)).sort((a, b) => a.path.localeCompare(b.path));
                  if (mapped && !isForeignProjectPath(base, mapped.filename)) available.unshift(fileUri(document, mapped.filename));
                  const choices = (await fileChoices([...new Map(available.map(uri => [uri.toString(), uri])).values()])).map(file => ({ ...file, action: 'file' }));
                  const usage = sources.devices.find(device => device.index === request.index);
                  const choice = await vscode.window.showQuickPick([
                    ...choices,
                    { label: vscode.l10n.t('Create a new device file'), action: 'new', uri: undefined },
                    ...(usage?.write && !usage.read ? [{ label: vscode.l10n.t('Choose an output file…'), action: 'output', uri: undefined }] : []),
                    { label: vscode.l10n.t('Browse for an existing file…'), action: 'browse', uri: undefined },
                  ], { title: vscode.l10n.t('Connect device 0x{0}', (request.index as number).toString(16).toUpperCase().padStart(2, '0')) });
                  if (!choice) return;
                  if (choice.action === 'new') { await createDevice(document, request.index as number, sources.devices); return; }
                  if (choice.action === 'output') {
                    const selected = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(base, `${deviceName(request.index as number, sources.devices)}.txt`),
                      title: vscode.l10n.t('Connect an output file'), saveLabel: vscode.l10n.t('Connect') });
                    if (selected) await createDevice(document, request.index as number, sources.devices, selected);
                    return;
                  }
                  const selected = choice.uri ?? (await vscode.window.showOpenDialog({ defaultUri: base, canSelectMany: false, canSelectFiles: true, canSelectFolders: false, title: vscode.l10n.t('Connect a device file') }))?.[0];
                  if (selected) await applyChange(document, { type: 'setDevice', index: request.index as number, path: await relativeProjectPath(base, selected) });
                });
                return;
              case 'newDevice':
                validIndex(request.index);
                await enqueue(document, () => createDevice(document, request.index as number, sources.devices));
                return;
              case 'openDevice':
                validIndex(request.index);
                await enqueue(document, async () => {
                  const device = parseProject(document.getText()).filedevices?.find(device => device.index === request.index);
                  if (!device) throw new Error(vscode.l10n.t('This device is no longer connected.'));
                  await vscode.commands.executeCommand('vscode.open', fileUri(document, device.filename));
                });
                return;
              case 'save':
                await enqueue(document, async () => { if (!await document.save()) throw new Error(vscode.l10n.t('Could not save project settings.')); });
                sendState();
                return;
              case 'undo': case 'redo':
                await enqueue(document, async () => {
                  if (!panel.active) return;
                  await vscode.commands.executeCommand(request.type as string);
                });
                sendState(true);
                return;
              case 'openText':
                await enqueue(document, async () => { await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', panel.viewColumn); });
                return;
              default: throw new Error(vscode.l10n.t('Unsupported settings request.'));
            }
          };
          void handle().catch(cause => {
            if (disposed) return;
            requestError = cause instanceof Error ? cause.message : String(cause);
            sendState(true);
          });
        }),
      ];
      panel.onDidDispose(() => { disposed = true; clearTimeout(timer); for (const listener of listeners) listener.dispose(); });
      panel.webview.html = projectEditorHtml(panel.webview, context.extensionUri);
    },
  }));
}
