import * as vscode from 'vscode';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Mode } from './language';
import type { LaunchArguments } from './protocol';
import { getSymbols } from './language';
import { activeDocumentUri, createProjectFiles, executionModeFor, fileKey, getProject, isForeignProjectPath, parseProject, projectConfiguration, projectFileUri, projectForUri, refreshProjects, relativeProjectPath, saveProject, uniqueSourcePaths, type ProjectData } from './projectFiles';

export type ProjectTarget = vscode.Uri;

const configurationKey = (config: vscode.DebugConfiguration): string => createHash('sha256').update(JSON.stringify(config)).digest('hex');
type LaunchSource = { target: vscode.ConfigurationTarget; key: string };
const launchWrites = new Map<string, Promise<void>>();

function saveLaunchScope(folder: vscode.WorkspaceFolder | undefined, target: vscode.ConfigurationTarget, operation: () => Promise<void>): Promise<void> {
  const key = target === vscode.ConfigurationTarget.WorkspaceFolder ? `folder:${folder?.uri.toString()}` : String(target);
  const pending = (launchWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  launchWrites.set(key, pending);
  void pending.finally(() => { if (launchWrites.get(key) === pending) launchWrites.delete(key); }).catch(() => {});
  return pending;
}

function launchScopes(folder?: vscode.WorkspaceFolder): { target: vscode.ConfigurationTarget; configs: vscode.DebugConfiguration[] }[] {
  const inspection = vscode.workspace.getConfiguration('launch', folder?.uri).inspect<vscode.DebugConfiguration[]>('configurations');
  return [
    { target: vscode.ConfigurationTarget.WorkspaceFolder, configs: inspection?.workspaceFolderValue },
    { target: vscode.ConfigurationTarget.Workspace, configs: folder && !vscode.workspace.workspaceFile && inspection?.workspaceFolderValue ? undefined : inspection?.workspaceValue },
    { target: vscode.ConfigurationTarget.Global, configs: inspection?.globalValue },
  ].filter((scope): scope is { target: vscode.ConfigurationTarget; configs: vscode.DebugConfiguration[] } => !!scope.configs);
}

async function writeLaunchConfigurations(folder: vscode.WorkspaceFolder | undefined, target: vscode.ConfigurationTarget, configurations: vscode.DebugConfiguration[]): Promise<void> {
  if (target === vscode.ConfigurationTarget.Global) {
    const settings = vscode.workspace.getConfiguration();
    const launch = settings.inspect<Record<string, unknown>>('launch')?.globalValue ?? {};
    await settings.update('launch', { ...launch, configurations }, target);
  } else {
    await vscode.workspace.getConfiguration('launch', folder?.uri).update('configurations', configurations, target);
  }
}

// Capture the persisted configuration before VS Code substitutes path variables.
export function captureDelaySource(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): vscode.DebugConfiguration {
  const { __umjoonsicDelaySource: _source, ...original } = config;
  if (original.stepDelayMs === undefined || original.projectFile) return original;
  const comparable = (value: vscode.DebugConfiguration) => Object.fromEntries(Object.entries(value)
    .filter(([key]) => !key.startsWith('__') && key !== 'noDebug' && key !== 'stopOnEntry'));
  const matches = launchScopes(folder).flatMap(({ target, configs }) => configs
    .filter(candidate => isDeepStrictEqual(comparable(candidate), comparable(original)))
    .map(candidate => ({ target, key: configurationKey(candidate) })));
  return { ...original, __umjoonsicDelaySource: matches.length === 1 ? matches[0] : null };
}

export async function saveStepDelay(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration | undefined, value: number): Promise<void> {
  const project = getProject(folder);
  if (config?.projectFile && (!project?.data || config.projectFile !== project.uri?.toString())) throw new Error(vscode.l10n.t('The project file used for this session has changed.'));
  if ((!config || config.projectFile) && project?.data) {
    await saveProject(project, { stepDelayMs: value });
  } else if (config && config.__umjoonsicDelaySource !== undefined) {
    const source = config.__umjoonsicDelaySource;
    if (!source) throw new Error(vscode.l10n.t('Cannot identify the launch configuration for saving the interval. Check launch settings.'));
    await saveLaunchScope(folder, source.target, async () => {
      const launch = vscode.workspace.getConfiguration('launch', folder?.uri);
      const inspection = launch.inspect<vscode.DebugConfiguration[]>('configurations');
      const configs = source.target === vscode.ConfigurationTarget.WorkspaceFolder ? inspection?.workspaceFolderValue
        : source.target === vscode.ConfigurationTarget.Workspace ? inspection?.workspaceValue : inspection?.globalValue;
      const matches = configs?.map((candidate, index) => configurationKey(candidate) === source.key ? index : -1).filter(index => index >= 0) ?? [];
      if (!configs || matches.length !== 1) throw new Error(vscode.l10n.t('The launch configuration changed after starting. Check launch settings before saving the interval.'));
      const updated = configs.map((candidate, index) => index === matches[0] ? { ...candidate, stepDelayMs: value } : candidate);
      await writeLaunchConfigurations(folder, source.target, updated);
      source.key = configurationKey(updated[matches[0]]);
    });
  } else {
    await vscode.workspace.getConfiguration('umjoonsic', folder?.uri).update('stepDelayMs', value, folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global);
  }
}

export function modeFor(document: vscode.TextDocument | vscode.Uri): Mode {
  const uri = document instanceof vscode.Uri ? document : document.uri;
  const executionMode = executionModeFor(uri);
  if (executionMode) return executionMode;
  const project = projectForUri(uri);
  if (project?.data?.mode) return project.data.mode;
  return vscode.workspace.getConfiguration('umjoonsic', document).get('mode') === 'sicxe' ? 'sicxe' : 'sic';
}

export function requireTrusted(): void {
  if (!vscode.workspace.isTrusted) throw new Error(vscode.l10n.t('Execution and file devices require a trusted workspace.'));
}

export function currentFolder(target?: ProjectTarget): vscode.WorkspaceFolder | undefined {
  if (target) {
    const folder = vscode.workspace.getWorkspaceFolder(target);
    if (!folder) throw new Error(vscode.l10n.t('Open the target project folder first.'));
    return folder;
  }
  const uri = activeDocumentUri();
  return (uri && vscode.workspace.getWorkspaceFolder(uri)) || vscode.debug.activeDebugSession?.workspaceFolder || vscode.workspace.workspaceFolders?.[0];
}

function resolvePath(value: unknown, folder?: vscode.WorkspaceFolder): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(vscode.l10n.t('File paths must be nonempty strings.'));
  const active = vscode.window.activeTextEditor?.document;
  const expanded = value.replace(/\$\{workspaceFolder\}/g, () => {
    if (folder?.uri.scheme !== 'file') throw new Error(vscode.l10n.t('Open a local or Remote workspace folder first.'));
    return folder.uri.fsPath;
  }).replace(/\$\{file\}/g, () => {
    if (active?.uri.scheme !== 'file') throw new Error(vscode.l10n.t('Save the source file before running it.'));
    return active.uri.fsPath;
  });
  if (/\$\{/.test(expanded)) throw new Error(vscode.l10n.t('Unresolved path variable: {0}', value));
  if (isForeignProjectPath(folder?.uri ?? vscode.Uri.file(process.cwd()), expanded)) throw new Error(vscode.l10n.t('Choose a path on this system instead of {0}.', value));
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  if (folder?.uri.scheme !== 'file') throw new Error(vscode.l10n.t('Relative paths require a workspace folder.'));
  return path.resolve(folder.uri.fsPath, expanded);
}

export async function prepareLaunch(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration & LaunchArguments> {
  requireTrusted();
  await refreshProjects();
  const project = getProject(folder);
  if (project?.error) throw new Error(project.error);
  if (project?.data && (config.projectFile || (!config.programs && !config.program))) {
    config = { ...config, ...projectConfiguration(project), stopOnEntry: config.stopOnEntry !== false };
  }
  const active = vscode.window.activeTextEditor?.document;
  const programs = config.programs ?? (config.program ? [config.program] : active?.uri.scheme === 'file' ? [active.uri.fsPath] : []);
  if (!Array.isArray(programs) || !programs.length) throw new Error(vscode.l10n.t('Open an assembly file or configure the assembly file list.'));
  const paths = programs.map(value => resolvePath(value, folder));
  if (new Set(await Promise.all(paths.map(value => fileKey(vscode.Uri.file(value))))).size !== paths.length) throw new Error(vscode.l10n.t('The assembly list contains the same file more than once.'));
  const marker = config.projectFile && vscode.workspace.textDocuments.find(document => document.uri.toString() === config.projectFile && document.isDirty);
  if (marker && project?.data) {
    let pending: ProjectData | undefined;
    try { pending = parseProject(marker.getText()); } catch { /* Ordinary unsaved settings still use their last saved version. */ }
    if (pending) {
      const references = (data: ProjectData) => [...data.asm, ...(data.filedevices ?? []).map(device => device.filename)]
        .filter(name => !isForeignProjectPath(project!.folder.uri, name))
        .map(name => projectFileUri(project!.folder.uri, name).fsPath);
      const next = new Set(references(pending));
      for (const filename of references(project.data).filter(name => !next.has(name))) {
        if (!await vscode.workspace.fs.stat(vscode.Uri.file(filename)).then(stat => !!(stat.type & vscode.FileType.File), () => false)) {
          throw new Error(vscode.l10n.t('Save the project settings for moved or deleted files before running.'));
        }
      }
    }
  }
  const mode = config.mode ?? vscode.workspace.getConfiguration('umjoonsic', folder?.uri ?? vscode.Uri.file(paths[0])).get('mode', 'sic');
  if (mode !== 'sic' && mode !== 'sicxe') throw new Error(vscode.l10n.t('mode must be sic or sicxe.'));
  const stepDelayMs = config.stepDelayMs ?? vscode.workspace.getConfiguration('umjoonsic', folder?.uri).get('stepDelayMs', 250);
  if (!Number.isInteger(stepDelayMs) || stepDelayMs < 0 || stepDelayMs > 60000) throw new Error(vscode.l10n.t('The step interval must be an integer from 0 to 60000 ms.'));
  if (config.mainSection !== undefined && typeof config.mainSection !== 'string') throw new Error(vscode.l10n.t('mainSection must be a string.'));
  const sources = [];
  for (const filename of paths) {
    if (!/\.asm$/i.test(filename)) throw new Error(vscode.l10n.t('Only .asm files can run: {0}', filename));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filename));
    if (document.getText().length > 1_000_000) throw new Error(vscode.l10n.t('Split source files into parts no larger than 1 MB.'));
    sources.push({ uri: document.uri.toString(), text: document.getText() });
    if (document.languageId !== 'umjoonsic') await vscode.languages.setTextDocumentLanguage(document, 'umjoonsic');
  }
  const devices = config.fileDevices ?? [];
  if (!Array.isArray(devices)) throw new Error(vscode.l10n.t('fileDevices must be an array.'));
  const indices = new Set<number>();
  const fileDevices = devices.map(device => {
    if (!device || !Number.isInteger(device.index) || device.index < 0 || device.index > 255 || indices.has(device.index)) throw new Error(vscode.l10n.t('Device numbers must be unique integers from 0 to 255.'));
    indices.add(device.index);
    return { index: device.index, filename: resolvePath(device.filename, folder) };
  });
  return { ...config, type: 'umjoonsic', request: 'launch', name: config.name || 'UmJoonSIC', mode, sources, programs: paths, fileDevices, stepDelayMs, stopOnEntry: config.stopOnEntry !== false };
}

export async function chooseConfiguration(target?: ProjectTarget): Promise<{ folder?: vscode.WorkspaceFolder; config: vscode.DebugConfiguration } | undefined> {
  await refreshProjects();
  const folder = currentFolder(target);
  const project = getProject(folder);
  if (project?.error) throw new Error(project.error);
  if (project?.data) return { folder, config: projectConfiguration(project) };
  const configs = vscode.workspace.getConfiguration('launch', folder?.uri).get<vscode.DebugConfiguration[]>('configurations', []).filter(config => config.type === 'umjoonsic');
  if (!configs.length) return { folder, config: { type: 'umjoonsic', request: 'launch', name: vscode.l10n.t('Current SIC file') } };
  if (configs.length === 1) return { folder, config: configs[0] };
  const choice = await vscode.window.showQuickPick(configs.map(config => ({ label: config.name, description: (config.programs ?? [config.program]).filter(Boolean).join(', '), config })), { title: vscode.l10n.t('UmJoonSIC launch configuration') });
  return choice && { folder, config: choice.config };
}

async function editableConfiguration(target?: ProjectTarget, openSettings = true): Promise<{ folder: vscode.WorkspaceFolder; config: vscode.DebugConfiguration; source?: LaunchSource } | undefined> {
  requireTrusted();
  const choice = await chooseConfiguration(target);
  if (!choice) return undefined;
  const folder = choice.folder;
  if (folder?.uri.scheme !== 'file') throw new Error(vscode.l10n.t('Open your project folder first.'));
  const project = getProject(folder);
  if (openSettings && project?.uri) {
    await vscode.commands.executeCommand('vscode.openWith', project.uri, 'umjoonsic.project');
    return;
  }
  const matches = launchScopes(folder).flatMap(({ target, configs }) => configs
    .filter(item => isDeepStrictEqual(item, choice.config)).map(item => ({ target, key: configurationKey(item) })));
  if (matches.length > 1) throw new Error(vscode.l10n.t('Multiple identical launch configurations exist. Give them distinct settings.'));
  const source = matches[0];
  const config = { ...choice.config };
  if (config.programs == null && config.program) config.programs = [config.program];
  delete config.program;
  if (!config.projectFile && !source) {
    config.name = vscode.l10n.t('SIC project');
    config.mode = vscode.workspace.getConfiguration('umjoonsic', folder.uri).get('mode', 'sic');
    config.stopOnEntry = true;
  }
  return { folder, config, source };
}

async function saveConfiguration(folder: vscode.WorkspaceFolder, config: vscode.DebugConfiguration, source?: LaunchSource): Promise<void> {
  const target = source?.target ?? vscode.ConfigurationTarget.WorkspaceFolder;
  await saveLaunchScope(folder, target, async () => {
    const all = launchScopes(folder).find(scope => scope.target === target)?.configs ?? [];
    const matches = source ? all.map((item, index) => configurationKey(item) === source.key ? index : -1).filter(index => index >= 0) : [];
    if (source && matches.length !== 1) throw new Error(vscode.l10n.t('The selected launch configuration changed. Select it again.'));
    const index = matches[0] ?? -1, updated = [...all];
    if (index < 0) {
      if (config.importedProject && all.some(item => item.importedProject === config.importedProject)) throw new Error(vscode.l10n.t('Another request already imported this project. Import it again.'));
      const baseName = config.name;
      for (let suffix = 2; updated.some(item => item.name === config.name); suffix++) config = { ...config, name: `${baseName} (${suffix})` };
      updated.push(config);
    } else updated[index] = config;
    await writeLaunchConfigurations(folder, target, updated);
  });
}

function launchPath(relative: string): string {
  const filename = relative.split(path.sep).join('/');
  return path.isAbsolute(relative) ? filename : `\${workspaceFolder}/${filename}`;
}

export async function configureFiles(addUri?: vscode.Uri, target?: ProjectTarget): Promise<void> {
  const edit = await editableConfiguration(target ?? (addUri && vscode.workspace.getWorkspaceFolder(addUri)?.uri), !addUri);
  if (!edit) return;
  const { folder, config, source } = edit;
  const existing = (Array.isArray(config.programs) ? config.programs : []).map(value => resolvePath(value, folder));
  let chosen: string[];
  if (addUri) {
    if (addUri.scheme !== 'file' || !/\.asm$/i.test(addUri.fsPath)) throw new Error(vscode.l10n.t('Choose an .asm file.'));
    if (!((await vscode.workspace.fs.stat(addUri)).type & vscode.FileType.File)) throw new Error(vscode.l10n.t('Only files can be added to the assembly list.'));
    if (config.projectFile) {
      const project = getProject(folder);
      if (!project?.data) throw new Error(project?.error || vscode.l10n.t('The project file no longer exists.'));
      const filename = await relativeProjectPath(folder.uri, addUri);
      await saveProject(project, async data => ({ asm: await uniqueSourcePaths(folder.uri, [...data.asm, filename]) }));
      return;
    }
    chosen = [...existing, addUri.fsPath];
  } else {
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.[aA][sS][mM]'), '**/{.out,node_modules,.git}/**');
    const available = await uniqueSourcePaths(folder.uri, [...existing, ...files.map(uri => uri.fsPath)]);
    const existingPaths = new Set(existing);
    const options = available.map(filename => ({ label: path.relative(folder.uri.fsPath, filename), value: filename, picked: existingPaths.has(filename) }));
    const selected = await vscode.window.showQuickPick(options, { canPickMany: true, title: vscode.l10n.t('Find and select assembly files'), matchOnDescription: true });
    if (!selected) return;
    const selectedPaths = selected.map(item => item.value);
    const selectedSet = new Set(selectedPaths);
    chosen = [...existing.filter(value => selectedSet.has(value)), ...selectedPaths.filter(value => !existingPaths.has(value))];
  }
  config.programs = (await uniqueSourcePaths(folder.uri, chosen)).map(filename => launchPath(path.relative(folder.uri.fsPath, filename)));
  await saveConfiguration(folder, config, source);
}

export async function reorderFiles(target?: ProjectTarget): Promise<void> {
  const edit = await editableConfiguration(target);
  if (!edit) return;
  const programs: string[] = edit.config.programs ?? [];
  const selected = await vscode.window.showQuickPick(programs.map((label, index) => ({ label, index })), { title: vscode.l10n.t('Choose a file to move') });
  if (!selected) return;
  const before = await vscode.window.showQuickPick([...programs.filter((_, index) => index !== selected.index).map(label => ({ label })), { label: vscode.l10n.t('(Last)') }], { title: vscode.l10n.t('Move before this file') });
  if (!before) return;
  const ordered = programs.filter((_, index) => index !== selected.index);
  const position = ordered.indexOf(before.label);
  ordered.splice(position < 0 ? ordered.length : position, 0, programs[selected.index]);
  edit.config.programs = ordered;
  await saveConfiguration(edit.folder, edit.config, edit.source);
}

export async function importProject(uri?: vscode.Uri): Promise<void> {
  requireTrusted();
  const selected = uri ?? (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'UmJoonSIC project': ['sic'] }, title: vscode.l10n.t('Import project.sic') }))?.[0];
  if (!selected) return;
  const folder = vscode.workspace.getWorkspaceFolder(selected);
  if (!folder || selected.scheme !== 'file') throw new Error(vscode.l10n.t('Open the folder containing the project in VS Code first.'));
  await refreshProjects();
  const rootProject = getProject(folder);
  if (rootProject?.uri?.toString() === selected.toString()) {
    if (rootProject.error) throw new Error(rootProject.error);
    await vscode.commands.executeCommand('vscode.openWith', selected, 'umjoonsic.project');
    return;
  }
  const data = parseProject(Buffer.from(await vscode.workspace.fs.readFile(selected)).toString('utf8'));
  const base = vscode.Uri.joinPath(selected, '..');
  const importedProject = await relativeProjectPath(folder.uri, selected);
  const all = launchScopes(folder).find(scope => scope.target === vscode.ConfigurationTarget.WorkspaceFolder)?.configs ?? [];
  const previous = all.filter(item => item.type === 'umjoonsic' && item.importedProject === importedProject);
  if (previous.length > 1) throw new Error(vscode.l10n.t('Multiple launch configurations import this project. Give them distinct settings.'));
  const source = previous[0] && { target: vscode.ConfigurationTarget.WorkspaceFolder, key: configurationKey(previous[0]) };
  const baseName = vscode.l10n.t('Imported {0}', importedProject);
  let name = previous[0]?.name ?? baseName, suffix = 2;
  while (!source && all.some(item => item.name === name)) name = `${baseName} (${suffix++})`;
  const makePath = (value: string) => launchPath(path.relative(folder.uri.fsPath, projectFileUri(base, value).fsPath));
  const config: vscode.DebugConfiguration = {
    stopOnEntry: true, ...previous[0],
    type: 'umjoonsic', request: 'launch', name, importedProject,
    mode: data.mode ?? vscode.workspace.getConfiguration('umjoonsic', folder.uri).get('mode', 'sic'),
    ...(data.stepDelayMs !== undefined ? { stepDelayMs: data.stepDelayMs } : {}),
    programs: data.asm.map(makePath), mainSection: data.main || undefined,
    fileDevices: (data.filedevices ?? []).map((device: { index: number; filename: string }) => ({ index: device.index, filename: makePath(device.filename) })),
  };
  delete config.program;
  if (data.stepDelayMs === undefined) delete config.stepDelayMs;
  await prepareLaunch(folder, config); // Validate before updating an existing configuration.
  await saveConfiguration(folder, config, source);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, '.vscode/launch.json')));
}

export async function chooseMain(target?: ProjectTarget): Promise<void> {
  const edit = await editableConfiguration(target);
  if (!edit) return;
  const args = await prepareLaunch(edit.folder, edit.config);
  const names = [...new Set(args.sources.flatMap(source => getSymbols(source.text, args.mode).filter(symbol => symbol.kind === 'section').map(symbol => symbol.name)))];
  const selected = await vscode.window.showQuickPick([{ label: vscode.l10n.t('(Use file order)'), value: '' }, ...names.map(name => ({ label: name, value: name }))], { title: vscode.l10n.t('Main program / first control section') });
  if (!selected) return;
  if (selected.value) edit.config.mainSection = selected.value; else delete edit.config.mainSection;
  await saveConfiguration(edit.folder, edit.config, edit.source);
}

export async function configureDevices(target?: ProjectTarget): Promise<void> {
  const edit = await editableConfiguration(target);
  if (!edit) return;
  const devices: { index: number; filename: string }[] = edit.config.fileDevices ?? [];
  const selected = await vscode.window.showQuickPick([{ label: vscode.l10n.t('Add a file device'), index: -1 }, ...devices.map(device => ({ label: `0x${device.index.toString(16).toUpperCase().padStart(2, '0')}`, description: device.filename, index: device.index }))], { title: vscode.l10n.t('Configure file devices') });
  if (!selected) return;
  let index = selected.index;
  if (index < 0) {
    const value = await vscode.window.showInputBox({ title: vscode.l10n.t('Device number'), prompt: vscode.l10n.t('0–255 or 0x00–0xFF'), validateInput: text => /^(?:0x[0-9a-f]{1,2}|\d{1,3})$/i.test(text) && Number(text) <= 255 && !devices.some(device => device.index === Number(text)) ? undefined : vscode.l10n.t('Enter an unused device number from 0 to 255.') });
    if (value === undefined) return;
    index = Number(value);
  } else {
    const action = await vscode.window.showQuickPick([vscode.l10n.t('Change connected file'), vscode.l10n.t('Disconnect device')], { title: vscode.l10n.t('Device {0}', selected.label) });
    if (!action) return;
    if (action === vscode.l10n.t('Disconnect device')) {
      edit.config.fileDevices = devices.filter(device => device.index !== index);
      await saveConfiguration(edit.folder, edit.config, edit.source);
      return;
    }
  }
  const files = await vscode.window.showOpenDialog({ canSelectMany: false, defaultUri: edit.folder.uri, title: vscode.l10n.t('Choose a device file') });
  if (!files) return;
  const filename = launchPath(await relativeProjectPath(edit.folder.uri, files[0]));
  edit.config.fileDevices = [...devices.filter(device => device.index !== index), { index, filename }];
  await saveConfiguration(edit.folder, edit.config, edit.source);
}

export async function newProject(target?: ProjectTarget): Promise<void> {
  requireTrusted();
  let folder = target ?? currentFolder()?.uri ?? (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: vscode.l10n.t('Choose a folder for the SIC project') }))?.[0];
  if (!folder) return;
  if (!((await vscode.workspace.fs.stat(folder)).type & vscode.FileType.Directory)) folder = vscode.Uri.joinPath(folder, '..');
  const projectUri = await createProjectFiles(folder);
  if (vscode.workspace.getWorkspaceFolder(folder)?.uri.toString() !== folder.toString()) await vscode.commands.executeCommand('vscode.openFolder', folder, { forceNewWindow: true });
  else await vscode.commands.executeCommand('vscode.openWith', projectUri, 'umjoonsic.project');
}
