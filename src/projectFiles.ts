import * as vscode from 'vscode';
import * as path from 'node:path';
import { readlink, realpath, writeFile } from 'node:fs/promises';
import { sourceFileKey } from './sourceFiles';
import { isDeepStrictEqual } from 'node:util';

export interface ProjectData {
  asm: string[];
  main?: string;
  filedevices?: { index: number; filename: string }[];
  mode?: 'sic' | 'sicxe';
  stepDelayMs?: number;
  [key: string]: unknown;
}

export interface ProjectRecord {
  folder: vscode.WorkspaceFolder;
  hasMarker?: boolean;
  uri?: vscode.Uri;
  data?: ProjectData;
  error?: string;
}

const changed = new vscode.EventEmitter<void>();
export const onDidChangeProjects = changed.event;
let projects = new Map<string, ProjectRecord>();
let refreshing: Promise<void> | undefined;
let refreshAgain = false;
let projectState: unknown;
let projectRootPaths: string[] | undefined;
let initialized: Promise<void> | undefined;
const assignedLanguages = new Map<string, string>();
const changingLanguages = new Set<string>();
const uriKey = (uri: vscode.Uri): string => process.platform === 'win32' ? uri.toString().toLowerCase() : uri.toString();
export function isForeignProjectPath(base: vscode.Uri, filename: string): boolean {
  return base.scheme === 'file' && process.platform === 'win32'
    ? /^[\\/](?![\\/])/.test(filename) || /^[A-Za-z]:(?![\\/])/.test(filename)
    : /^(?:[A-Za-z]:|\\|\/\/)/.test(filename);
}

export function projectFileUri(base: vscode.Uri, filename: string): vscode.Uri {
  if (isForeignProjectPath(base, filename)) throw new Error(vscode.l10n.t('Choose a path on this system instead of {0}.', filename));
  const paths = base.scheme === 'file' ? path : path.posix;
  const value = paths.isAbsolute(filename) ? filename : filename.replace(/\\/g, '/');
  return base.scheme === 'file' ? vscode.Uri.file(paths.resolve(base.fsPath, value))
    : base.with({ path: paths.resolve(base.path, value) });
}

function projectPathForUri(base: vscode.Uri, uri: vscode.Uri): string {
  if (base.scheme !== uri.scheme || (base.scheme !== 'file' && base.authority !== uri.authority)) throw new Error(vscode.l10n.t('Choose a file on the same filesystem as the project.'));
  const paths = base.scheme === 'file' ? path : path.posix;
  const filename = base.scheme === 'file' ? uri.fsPath : uri.path;
  const relative = paths.relative(base.scheme === 'file' ? base.fsPath : base.path, filename);
  // Absolute native paths preserve literal backslashes and drive-like POSIX filenames.
  return (paths.sep === '/' && relative.includes('\\')) || isForeignProjectPath(base, relative)
    ? filename : relative.split(paths.sep).join('/');
}
const runningModes = new Map<string, { sessionId: string; mode: 'sic' | 'sicxe' }>();
const snapshotModes = new Map<string, { sessionId: string; mode: 'sic' | 'sicxe' }>();
const liveSessions = new Set<string>();
let registeredSources = new Map<string, { folderName: string; order: number }[]>();
const decorationsChanged = new vscode.EventEmitter<vscode.Uri[] | undefined>();
const createdSources = new Map<string, vscode.Uri>();
let registeringSources: Promise<void> | undefined;
type ProjectPatch = Partial<ProjectData> | ((latest: ProjectData) => Partial<ProjectData> | Promise<Partial<ProjectData>>);
const projectSaves = new Map<string, Promise<void>>();

export async function fileKey(uri: vscode.Uri): Promise<string> {
  return sourceFileKey(uri.toString(), uri.fsPath);
}

export async function uniqueSourcePaths(base: vscode.Uri, filenames: readonly string[]): Promise<string[]> {
  const keys = await Promise.all(filenames.map(filename => isForeignProjectPath(base, filename)
    ? `foreign:${filename}` : fileKey(projectFileUri(base, filename))));
  const seen = new Set<string>();
  return filenames.filter((_, index) => { if (seen.has(keys[index])) return false; seen.add(keys[index]); return true; });
}

export function executionModeFor(uri: vscode.Uri): 'sic' | 'sicxe' | undefined {
  return (uri.scheme === 'debug' ? snapshotModes : runningModes).get(uriKey(uri))?.mode;
}

export function projectFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
  const entries = registeredSources.get(uriKey(uri));
  if (!entries?.length) return;
  return { badge: entries.length === 1 && entries[0].order < 100 ? String(entries[0].order) : 'S',
    tooltip: entries.map(entry => vscode.l10n.t('{0}: assembly order {1}', entry.folderName, entry.order)).join('\n'),
    color: new vscode.ThemeColor('charts.blue') };
}

function rememberExecution(session: vscode.DebugSession): void {
  if (session.type !== 'umjoonsic') return;
  liveSessions.add(session.id);
  const info = { sessionId: session.id, mode: session.configuration.mode === 'sicxe' ? 'sicxe' as const : 'sic' as const };
  (session.configuration.sources ?? []).forEach((source: { uri: string }, index: number) => {
    const uri = vscode.Uri.parse(source.uri);
    runningModes.set(uriKey(uri), info);
    snapshotModes.set(uriKey(vscode.debug.asDebugSourceUri({ path: uri.fsPath, sourceReference: index + 1 }, session)), info);
  });
  changed.fire();
}

export function addCreatedSources(files: readonly vscode.Uri[]): Promise<void> {
  for (const uri of files) if (/\.asm$/i.test(uri.path)) createdSources.set(uriKey(uri), uri);
  if (!registeringSources) {
    registeringSources = (async () => {
      const errors: string[] = [];
      while (createdSources.size) {
        const batch = [...createdSources.values()];
        createdSources.clear();
        if (!vscode.workspace.isTrusted) continue;
        await refreshProjects();
        const additions = new Map<ProjectRecord, string[]>();
        for (const uri of batch) {
          const project = projectForUri(uri);
          if (!project?.hasMarker || !vscode.workspace.getConfiguration('umjoonsic', project.folder.uri).get('autoAddNewAsmFiles', true)) continue;
          if (registeredSources.has(uriKey(uri))) continue;
          const relative = path.posix.relative(project.folder.uri.path, uri.path);
          if (relative.split('/').some(part => ['.git', 'node_modules', '.out', 'out'].includes(part))) continue;
          try {
            if (project.error || !project.data) throw new Error(project.error || vscode.l10n.t('Could not read project settings.'));
            if (!((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File)) continue;
            const filename = await relativeProjectPath(project.folder.uri, uri);
            if (!additions.has(project)) additions.set(project, []);
            additions.get(project)!.push(filename);
          } catch (error) { errors.push(`${project.folder.name}: ${error instanceof Error ? error.message : String(error)}`); }
        }
        for (const [project, names] of additions) {
          try {
            await saveProject(project, async data => ({ asm: await uniqueSourcePaths(project.folder.uri, [...data.asm, ...names]) }));
          } catch (error) { errors.push(`${project.folder.name}: ${error instanceof Error ? error.message : String(error)}`); }
        }
      }
      if (errors.length) void vscode.window.showWarningMessage(vscode.l10n.t('Could not add new assembly files: {0}', [...new Set(errors)].join(' ')));
    })().finally(() => { registeringSources = undefined; if (createdSources.size) return addCreatedSources([]); });
  }
  return registeringSources;
}

type FileChange = { oldUri: vscode.Uri; newUri?: vscode.Uri };
type ProjectPathEdit = {
  document: vscode.TextDocument; uri: vscode.Uri; version: number; expected: string;
  paths: { before: string; after?: string; device: boolean; required: boolean }[];
  patch(data: ProjectData): ProjectData;
};
const pathEdits = new WeakMap<vscode.WorkspaceEdit, ProjectPathEdit[]>();

async function optionalStat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try { return await vscode.workspace.fs.stat(uri); }
  catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'FileNotFound' || code === 'ENOENT') return;
    throw error;
  }
}

function projectText(document: vscode.TextDocument, original: string, data: ProjectData): string {
  const newline = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  return (original.startsWith('\uFEFF') ? '\uFEFF' : '')
    + JSON.stringify(data, null, original.match(/\n([\t ]+)\S/)?.[1] ?? '  ').replace(/\n/g, newline) + newline;
}

/** Let VS Code undo the project references together with the file operation. */
async function projectFileEdits(changes: readonly FileChange[], token: vscode.CancellationToken): Promise<vscode.WorkspaceEdit> {
  const edit = new vscode.WorkspaceEdit();
  const originals = new Map<vscode.TextDocument, { text: string; version: number }>();
  const records: ProjectPathEdit[] = [];
  pathEdits.set(edit, records);
  if (!vscode.workspace.isTrusted || token.isCancellationRequested) return edit;
  // A just-created source must reach the project before its path is changed or removed.
  await registeringSources;
  if (token.isCancellationRequested) return edit;
  await refreshProjects();
  const physicalPaths = new Map<string, Promise<string>>();
  const physicalPath = (filename: string): Promise<string> => {
    let pending = physicalPaths.get(filename);
    if (!pending) { pending = realpath(filename).catch(() => filename); physicalPaths.set(filename, pending); }
    return pending;
  };
  // Resolve the parent, not the selected entry: moving a symlink does not move its target.
  const entryUri = async (uri: vscode.Uri): Promise<vscode.Uri> => uri.scheme === 'file'
    ? vscode.Uri.file(path.join(await physicalPath(path.dirname(uri.fsPath)), path.basename(uri.fsPath))) : uri;
  const ordered = [...changes].sort((a, b) => b.oldUri.path.length - a.oldUri.path.length);
  const physicalChanges = (await Promise.all(ordered.map(async change => ({ change, old: await entryUri(change.oldUri) }))))
    .sort((a, b) => b.old.path.length - a.old.path.length);
  const suffix = (uri: vscode.Uri, parent: vscode.Uri): string | undefined => {
    if (uri.scheme !== parent.scheme || uri.authority !== parent.authority) return;
    const old = parent.path.replace(/\/$/, ''), value = uri.path;
    const key = process.platform === 'win32' ? value.toLowerCase() : value;
    const prefix = process.platform === 'win32' ? old.toLowerCase() : old;
    return key === prefix || key.startsWith(`${prefix}/`) ? value.slice(old.length) : undefined;
  };
  const linkTargets = new Map<string, Promise<string | undefined>>();
  const linkTarget = (filename: string): Promise<string | undefined> => {
    let pending = linkTargets.get(filename);
    if (!pending) {
      pending = readlink(filename).catch(error => { if (error.code === 'EINVAL') return undefined; throw error; });
      linkTargets.set(filename, pending);
    }
    return pending;
  };
  const move = async (uri: vscode.Uri): Promise<vscode.Uri | undefined> => {
    let selected: FileChange | undefined, replacement: vscode.Uri | undefined, movedRoot: vscode.Uri | undefined;
    let shortestTail = Infinity;
    for (const change of ordered) {
      const tail = suffix(uri, change.oldUri);
      if (tail === undefined) continue;
      replacement = change.newUri && vscode.Uri.joinPath(change.newUri, tail);
      if (!replacement || !tail || uri.scheme !== 'file') return replacement;
      try { if (await linkTarget(change.oldUri.fsPath) === undefined) return replacement; }
      catch { return replacement; }
      selected = change;
      break;
    }
    if (uri.scheme !== 'file') return uri;
    let physical = uri;
    const visited = new Set<string>();
    // Follow entries in traversal order, before they disappear into realpath's final target.
    // Bound expansion for broken/cyclic links; repeated links with a shorter suffix are valid.
    for (let depth = 0; depth < 64; depth++) {
      const key = uriKey(physical);
      if (token.isCancellationRequested) return uri;
      if (visited.has(key)) return replacement ?? uri;
      visited.add(key);
      for (const { change, old } of physicalChanges) {
        if (selected && change !== selected) continue;
        const tail = suffix(physical, old);
        if (tail === undefined) continue;
        if (!change.newUri) return;
        let candidate = vscode.Uri.joinPath(change.newUri, tail);
        if (change.newUri.scheme === 'file' && (!tail || uri.path.endsWith(tail))) {
          const reference = tail ? uri.with({ path: uri.path.slice(0, -tail.length) }) : uri;
          // Keep a directly named entry's alias parent when it remains valid after the move.
          if (!tail || suffix(await entryUri(reference), old) === '') {
            const parent = await physicalPath(path.dirname(reference.fsPath));
            const nextParent = await physicalPath(path.dirname(change.newUri.fsPath));
            if (uriKey(vscode.Uri.file(parent)) === uriKey(vscode.Uri.file(nextParent)))
              candidate = vscode.Uri.joinPath(vscode.Uri.file(path.join(path.dirname(reference.fsPath), path.basename(change.newUri.fsPath))), tail);
          }
        }
        try { if (!tail || await linkTarget(old.fsPath) === undefined) return candidate; }
        catch { return replacement ?? uri; }
        selected = change;
        movedRoot ??= candidate.with({ path: candidate.path.slice(0, -tail.length) });
        // A link to '.' can traverse the same moved entry again with a shorter suffix.
        if (tail.length < shortestTail) { shortestTail = tail.length; replacement = vscode.Uri.joinPath(movedRoot, tail); }
        break;
      }
      if (await physicalPath(physical.fsPath) === physical.fsPath && (await entryUri(physical)).fsPath === physical.fsPath) return replacement ?? uri;
      const ancestors = [physical.fsPath];
      for (let parent = path.dirname(physical.fsPath); parent !== ancestors[0]; parent = path.dirname(parent)) ancestors.unshift(parent);
      let next: vscode.Uri | undefined;
      try {
        for (const ancestor of ancestors) {
          const target = await linkTarget(ancestor);
          if (target === undefined) continue;
          next = vscode.Uri.file(path.resolve(path.dirname(ancestor), target, path.relative(ancestor, physical.fsPath)));
          break;
        }
      } catch { return replacement ?? uri; } // Keep only an already established match.
      if (!next) return replacement ?? uri;
      physical = next;
    }
    return replacement ?? uri;
  };
  for (const project of projects.values()) {
    if (!project.uri) continue;
    const nextMarker = await move(project.uri);
    if (!nextMarker) continue;
    try {
      const document = await vscode.workspace.openTextDocument(project.uri);
      if (token.isCancellationRequested) return new vscode.WorkspaceEdit();
      const original = document.getText(), version = document.version, data = parseProject(original);
      const base = vscode.Uri.joinPath(project.uri, '..'), nextBase = vscode.Uri.joinPath(nextMarker, '..');
      const remap = async (filename: string, removeDeleted: boolean): Promise<string | undefined> => {
        if (isForeignProjectPath(base, filename)) return filename;
        const uri = projectFileUri(base, filename), target = await move(uri);
        if (!target) return removeDeleted ? undefined : filename;
        if (uri.toString() === target.toString() && base.toString() === nextBase.toString()) return filename;
        return target.scheme === 'file' && path.isAbsolute(filename) ? target.fsPath : projectPathForUri(nextBase, target);
      };
      const mappedSources = (await Promise.all(data.asm.map(filename => remap(filename, true))))
        .map(filename => filename && /\.asm$/i.test(filename) ? filename : undefined);
      const seen = new Set<string>();
      const asm = mappedSources.flatMap(mapped => {
        if (!mapped || !/\.asm$/i.test(mapped)) return [];
        const key = isForeignProjectPath(nextBase, mapped) ? `foreign:${mapped}` : uriKey(projectFileUri(nextBase, mapped));
        if (seen.has(key)) return [];
        seen.add(key);
        return [mapped];
      });
      const filedevices = data.filedevices && await Promise.all(data.filedevices.map(async device => ({ ...device, filename: (await remap(device.filename, false))! })));
      if (isDeepStrictEqual(asm, data.asm) && isDeepStrictEqual(filedevices, data.filedevices)) continue;
      const updated = parseProject(JSON.stringify({ ...data, asm, ...(filedevices && { filedevices }) }));
      const text = projectText(document, original, updated);
      edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(original.length)), text);
      originals.set(document, { text: original, version });
      const sourceChanges = new Map(data.asm.map((filename, index) => [filename, mappedSources[index]]));
      const deviceChanges = new Map((data.filedevices ?? []).map((device, index) => [device.filename, filedevices![index].filename]));
      const replacements = [...sourceChanges].filter(([before, after]) => before !== after).map(([before, after]) => ({ before, after, device: false }))
        .concat([...deviceChanges].filter(([before, after]) => before !== after).map(([before, after]) => ({ before, after, device: true })));
      const paths = await Promise.all(replacements.map(async replacement => ({ ...replacement,
        required: await optionalStat(projectFileUri(base, replacement.before)).then(stat => !!stat, () => true) })));
      records.push({ document, uri: nextMarker, version, expected: text, paths, patch(current) {
        const names = new Set<string>();
        const sources = current.asm.flatMap(filename => {
          const value = sourceChanges.has(filename) ? sourceChanges.get(filename) : filename;
          if (!value || !/\.asm$/i.test(value)) return [];
          const key = isForeignProjectPath(nextBase, value) ? `foreign:${value}` : uriKey(projectFileUri(nextBase, value));
          if (names.has(key)) return [];
          names.add(key);
          return [value];
        });
        return { ...current, asm: sources, ...(current.filedevices && { filedevices: current.filedevices.map(device =>
          ({ ...device, filename: deviceChanges.get(device.filename) ?? device.filename })) }) };
      } });
    } catch (error) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Could not update project paths. {0}: {1}', project.folder.name, error instanceof Error ? error.message : String(error)));
    }
  }
  if ([...originals].some(([document, original]) => document.isClosed || document.version !== original.version || document.getText() !== original.text)) {
    void vscode.window.showWarningMessage(vscode.l10n.t('Project settings are being edited. Check the assembly paths before continuing.'));
    return new vscode.WorkspaceEdit();
  }
  return token.isCancellationRequested ? new vscode.WorkspaceEdit() : edit;
}

function registerFileOperations(context: vscode.ExtensionContext): void {
  type Plan = { edits: ProjectPathEdit[]; ambiguous: boolean };
  const pending = new Map<string, Plan>();
  const ownVersions = new WeakMap<vscode.TextDocument, number>();
  const applying = new Map<vscode.TextDocument, string>();
  let preparing = Promise.resolve();
  let disposed = false;
  const key = (changes: readonly FileChange[]) => JSON.stringify(changes.map(change =>
    [uriKey(change.oldUri), change.newUri && uriKey(change.newUri)]).sort((a, b) => String(a).localeCompare(String(b))));
  const warn = (): void => {
    if (!disposed) void vscode.window.showWarningMessage(vscode.l10n.t('Project settings are being edited. Check the assembly paths before continuing.'));
  };
  const participate = (changes: readonly FileChange[], token: vscode.CancellationToken): Promise<vscode.WorkspaceEdit> => {
    const next = preparing.then(async () => {
      if (disposed || token.isCancellationRequested) return new vscode.WorkspaceEdit();
      const edit = await projectFileEdits(changes, token);
      if (disposed || token.isCancellationRequested) return new vscode.WorkspaceEdit();
      const records = pathEdits.get(edit) ?? [];
      if (records.length) {
        const id = key(changes), ambiguous = pending.has(id);
        pending.delete(id);
        // ponytail: retain at most 64 unapplied proposals in one extension host.
        // Failed/skipped IO has no completion event; warn on overflow instead of waiting.
        if (pending.size >= 64) { pending.delete(pending.keys().next().value!); warn(); }
        pending.set(id, { edits: records, ambiguous });
      }
      return edit;
    });
    // The native API owns approval, application and grouped undo after preparation.
    preparing = next.then(() => {}, () => {});
    return next;
  };
  const completed = async (changes: readonly FileChange[]): Promise<void> => {
    const id = key(changes), plan = pending.get(id);
    pending.delete(id);
    if (!plan || disposed) return;
    const remaining: { record: ProjectPathEdit; document: vscode.TextDocument }[] = [];
    for (const record of plan.edits) {
      const document = await vscode.workspace.openTextDocument(record.uri);
      const data = parseProject(document.getText());
      if (!isDeepStrictEqual(record.patch(data), data)) remaining.push({ record, document });
    }
    if (!remaining.length) return;
    const collided = remaining.some(({ record }) => plan.ambiguous ||
      (record.document.version !== record.version && ownVersions.get(record.document) === record.document.version));
    if (!collided) {
      if (remaining.some(({ record }) => record.document.version !== record.version)) warn();
      return; // A normal, explicitly skipped refactoring must stay skipped.
    }
    const update = vscode.l10n.t('Update project paths');
    const choice = await vscode.window.showWarningMessage(vscode.l10n.t('Project paths changed during overlapping file operations. Update the remaining paths as a separate Undo step?'), update);
    if (choice !== update || disposed) return;
    const repair = new vscode.WorkspaceEdit();
    const snapshots = new Map<vscode.TextDocument, { text: string; version: number; expected: string }>();
    for (const { record } of remaining) {
      const document = await vscode.workspace.openTextDocument(record.uri);
      if (document.isClosed) { warn(); return; }
      const original = document.getText(), version = document.version;
      const current = parseProject(original), data = record.patch(current);
      if (isDeepStrictEqual(data, current)) continue;
      parseProject(JSON.stringify(data));
      const base = vscode.Uri.joinPath(document.uri, '..');
      // Revalidate both ends: the notification may outlive Undo, recreation or another move.
      for (const replacement of record.paths) {
        const active = replacement.device ? current.filedevices?.some(device => device.filename === replacement.before)
          : current.asm.includes(replacement.before);
        if (!active) continue;
        const before = projectFileUri(base, replacement.before);
        const after = replacement.after === undefined ? undefined : projectFileUri(base, replacement.after);
        const existing = await optionalStat(before);
        if (existing && (!after || await fileKey(before) !== await fileKey(after))) { warn(); return; }
        if (after) {
          const target = await optionalStat(after);
          if (target ? !(target.type & vscode.FileType.File) : replacement.required) { warn(); return; }
          if (!target && !((await vscode.workspace.fs.stat(vscode.Uri.joinPath(after, '..'))).type & vscode.FileType.Directory)) { warn(); return; }
        }
      }
      const text = projectText(document, original, data);
      repair.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(original.length)), text);
      snapshots.set(document, { text: original, version, expected: text });
    }
    try {
      if (disposed || [...snapshots].some(([document, snapshot]) => document.isClosed || document.version !== snapshot.version || document.getText() !== snapshot.text)) { warn(); return; }
      for (const [document, snapshot] of snapshots) applying.set(document, snapshot.expected);
      if (repair.size && !await vscode.workspace.applyEdit(repair)) warn();
    } finally { for (const document of snapshots.keys()) applying.delete(document); }
  };
  context.subscriptions.push(
    { dispose: () => { disposed = true; pending.clear(); applying.clear(); } },
    vscode.workspace.onWillDeleteFiles(event => { event.waitUntil(participate(event.files.map(oldUri => ({ oldUri })), event.token)); }),
    vscode.workspace.onWillRenameFiles(event => { event.waitUntil(participate(event.files, event.token)); }),
    vscode.workspace.onDidChangeTextDocument(event => {
      const document = event.document, text = document.getText();
      const expected = applying.get(document) === text || [...pending.values()].some(plan =>
        plan.edits.some(record => record.document === document && record.expected === text));
      if (!event.reason && (expected || ownVersions.get(document) === document.version)) ownVersions.set(document, document.version);
      else ownVersions.delete(document);
      for (const [id, plan] of pending) if (plan.edits.every(record => record.document.getText() === record.expected)) pending.delete(id);
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      const moving = [...pending.values()].some(plan => plan.edits.some(record => record.document === document && uriKey(record.uri) !== uriKey(document.uri)));
      if (moving) return; // A successful marker move replaces its native TextDocument.
      ownVersions.delete(document);
      applying.delete(document);
      for (const [id, plan] of pending) {
        if (plan.edits.some(record => record.document === document)) warn();
        plan.edits = plan.edits.filter(record => record.document !== document);
        if (!plan.edits.length) pending.delete(id);
      }
    }),
    vscode.workspace.onDidRenameFiles(event => { void completed(event.files).catch(warn); }),
    vscode.workspace.onDidDeleteFiles(event => { void completed(event.files.map(oldUri => ({ oldUri }))).catch(warn); }),
  );
}

export function parseProject(text: string): ProjectData {
  const data: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(vscode.l10n.t('Project settings must be a JSON object.'));
  const value = data as ProjectData;
  const validPath = (entry: unknown): entry is string => typeof entry === 'string' && !!entry.trim() && !entry.includes('\0') && !entry.includes('${');
  if (!Array.isArray(value.asm) || !value.asm.every(entry => validPath(entry) && /\.asm$/i.test(entry))) throw new Error(vscode.l10n.t('asm must contain an array of .asm file paths.'));
  const paths = value.asm.map(entry => {
    const normalized = path.normalize(path.isAbsolute(entry) ? entry : entry.replace(/\\/g, '/'));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  });
  if (new Set(paths).size !== paths.length) throw new Error(vscode.l10n.t('The asm list contains duplicate paths.'));
  if (value.main !== undefined && typeof value.main !== 'string') throw new Error(vscode.l10n.t('main must be a program name string.'));
  if (value.mode !== undefined) {
    const mode = typeof value.mode === 'string' ? value.mode.toLowerCase() : '';
    if (mode !== 'sic' && mode !== 'sicxe' && mode !== 'sic/xe') throw new Error(vscode.l10n.t('mode must be sic or sicxe.'));
    value.mode = mode === 'sic/xe' ? 'sicxe' : mode;
  }
  if (value.stepDelayMs !== undefined && (!Number.isInteger(value.stepDelayMs) || value.stepDelayMs < 0 || value.stepDelayMs > 60000)) throw new Error(vscode.l10n.t('stepDelayMs must be an integer from 0 to 60000.'));
  if (value.filedevices !== undefined) {
    if (!Array.isArray(value.filedevices)) throw new Error(vscode.l10n.t('filedevices must be an array of device mappings.'));
    const indices = new Set<number>();
    for (const device of value.filedevices) {
      if (!device || !Number.isInteger(device.index) || device.index < 0 || device.index > 255 || indices.has(device.index) || !validPath(device.filename)) throw new Error(vscode.l10n.t('File devices require unique numbers from 0 to 255 and file paths.'));
      indices.add(device.index);
    }
  }
  return value;
}

function markerNames(entries: [string, vscode.FileType][]): string[] {
  return entries.filter(([name, type]) => (type & vscode.FileType.File) && /\.sic$/i.test(name)).map(([name]) => name).sort();
}

async function readProject(folder: vscode.WorkspaceFolder): Promise<ProjectRecord> {
  const project: ProjectRecord = { folder };
  try {
    const names = markerNames(await vscode.workspace.fs.readDirectory(folder.uri));
    project.hasMarker = names.length > 0;
    const canonical = names.find(name => name === 'project.sic');
    if (!canonical && names.length > 1) throw new Error(vscode.l10n.t('Multiple .sic files exist in the root. Name the settings file to use project.sic.'));
    const name = canonical ?? names[0];
    if (!name) return project;
    project.uri = vscode.Uri.joinPath(folder.uri, name);
    project.data = parseProject(Buffer.from(await vscode.workspace.fs.readFile(project.uri)).toString('utf8'));
  } catch (error) {
    project.error = error instanceof Error ? error.message : String(error);
  }
  return project;
}

export function getProject(folder?: vscode.WorkspaceFolder): ProjectRecord | undefined {
  const activeUri = activeDocumentUri();
  const selected = folder ?? (activeUri && vscode.workspace.getWorkspaceFolder(activeUri)) ?? vscode.workspace.workspaceFolders?.[0];
  return selected && projects.get(selected.uri.toString());
}

export function activeDocumentUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom ? input.uri : vscode.window.activeTextEditor?.document.uri;
}

export async function relativeProjectPath(base: vscode.Uri, uri: vscode.Uri): Promise<string> {
  const filename = projectPathForUri(base, uri);
  if (base.scheme === 'file') await Promise.all([realpath(base.fsPath), realpath(uri.fsPath)]);
  return filename;
}

export function projectForUri(uri: vscode.Uri): ProjectRecord | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder ? projects.get(folder.uri.toString()) : undefined;
}

async function updateLanguage(document: vscode.TextDocument): Promise<void> {
  const key = document.uri.toString();
  if (document.isClosed || changingLanguages.has(key) || !/\.asm$/i.test(document.uri.path)) return;
  const project = projectForUri(document.uri);
  const previous = assignedLanguages.get(key);
  let language: string | undefined;
  if (project?.data) {
    if (document.languageId !== 'umjoonsic') {
      if (!previous) assignedLanguages.set(key, document.languageId);
      language = 'umjoonsic';
    }
  } else if (previous) {
    assignedLanguages.delete(key);
    if (document.languageId === 'umjoonsic') language = previous;
  }
  if (!language) return;
  changingLanguages.add(key);
  try {
    await vscode.languages.setTextDocumentLanguage(document, language);
  } finally {
    changingLanguages.delete(key);
  }
}

export function refreshProjects(): Promise<void> {
  refreshAgain = true;
  if (!refreshing) {
    refreshing = (async () => {
      while (refreshAgain) {
        refreshAgain = false;
        const records = await Promise.all((vscode.workspace.workspaceFolders ?? []).map(readProject));
        const state = records.map(project => [project.folder.uri.toString(), project.folder.name, project.folder.index,
          project.hasMarker, project.uri?.toString(), project.data, project.error]);
        const rootPaths = records.filter(project => project.hasMarker).map(project => project.folder.uri.fsPath);
        projects = new Map(records.map(project => [project.folder.uri.toString(), project]));
        if (!isDeepStrictEqual(rootPaths, projectRootPaths)) {
          await vscode.commands.executeCommand('setContext', 'umjoonsic.projectRootPaths', rootPaths);
          projectRootPaths = rootPaths;
        }
        if (!isDeepStrictEqual(state, projectState)) {
          registeredSources = new Map();
          for (const project of records) for (const [index, name] of (project.data?.asm ?? []).entries()) {
            if (isForeignProjectPath(project.folder.uri, name)) continue;
            const key = uriKey(projectFileUri(project.folder.uri, name));
            const entries = registeredSources.get(key) ?? [];
            entries.push({ folderName: project.folder.name, order: index + 1 });
            registeredSources.set(key, entries);
          }
          decorationsChanged.fire(undefined);
          await Promise.all(vscode.workspace.textDocuments.map(updateLanguage));
          projectState = state;
          changed.fire();
        }
      }
    })().finally(() => {
      refreshing = undefined;
      if (refreshAgain) return refreshProjects();
    });
  }
  return refreshing;
}

export async function initializeProjects(context: vscode.ExtensionContext): Promise<void> {
  if (initialized) return initialized;
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.[sS][iI][cC]');
  const rootMarkerChanged = (uri: vscode.Uri): void => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder && /\.sic$/i.test(uri.path) && path.posix.dirname(uri.path) === path.posix.resolve(folder.uri.path)) void refreshProjects();
  };
  context.subscriptions.push(
    changed, decorationsChanged, watcher,
    vscode.window.registerFileDecorationProvider({ onDidChangeFileDecorations: decorationsChanged.event, provideFileDecoration: projectFileDecoration }),
    vscode.workspace.onDidCreateFiles(event => { void addCreatedSources(event.files).catch(error => { void vscode.window.showWarningMessage(String(error)); }); }),
    vscode.debug.onDidStartDebugSession(rememberExecution),
    vscode.debug.onDidTerminateDebugSession(session => {
      liveSessions.delete(session.id);
      for (const [key, value] of runningModes) if (value.sessionId === session.id) runningModes.delete(key);
      const open = new Set(vscode.workspace.textDocuments.filter(document => !document.isClosed).map(document => uriKey(document.uri)));
      for (const [key, value] of snapshotModes) if (value.sessionId === session.id && !open.has(key)) snapshotModes.delete(key);
      if (session.type === 'umjoonsic') changed.fire();
    }),
    watcher.onDidCreate(rootMarkerChanged), watcher.onDidChange(rootMarkerChanged), watcher.onDidDelete(rootMarkerChanged),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void refreshProjects(); }),
    vscode.workspace.onDidSaveTextDocument(document => rootMarkerChanged(document.uri)),
    vscode.workspace.onDidOpenTextDocument(document => { void updateLanguage(document); }),
    vscode.workspace.onDidCloseTextDocument(document => {
      if (!changingLanguages.has(document.uri.toString())) assignedLanguages.delete(document.uri.toString());
      const key = uriKey(document.uri), snapshot = snapshotModes.get(key);
      if (snapshot && !liveSessions.has(snapshot.sessionId)) snapshotModes.delete(key);
    }),
  );
  registerFileOperations(context);
  if (vscode.debug.activeDebugSession) rememberExecution(vscode.debug.activeDebugSession);
  initialized = refreshProjects();
  return initialized;
}

export function projectConfiguration(project: ProjectRecord): vscode.DebugConfiguration {
  if (!project.uri || !project.data || project.error) throw new Error(project.error || vscode.l10n.t('No UmJoonSIC project file exists in the folder root.'));
  if (project.folder.uri.scheme !== 'file') throw new Error(vscode.l10n.t('Open a local or Remote workspace folder first.'));
  const data = project.data;
  const filename = (value: string): string => projectFileUri(project.folder.uri, value).fsPath;
  const settings = vscode.workspace.getConfiguration('umjoonsic', project.folder.uri);
  return {
    type: 'umjoonsic', request: 'launch', name: project.folder.name,
    projectFile: project.uri.toString(),
    programs: data.asm.map(filename), mainSection: data.main || undefined,
    fileDevices: (data.filedevices ?? []).map(device => ({ index: device.index, filename: filename(device.filename) })),
    mode: data.mode ?? settings.get('mode', 'sic'), stepDelayMs: data.stepDelayMs ?? settings.get('stepDelayMs', 250),
    stopOnEntry: true,
  };
}

export function saveProject(project: ProjectRecord, patch: ProjectPatch): Promise<void> {
  if (!project.uri) return Promise.reject(new Error(project.error || vscode.l10n.t('No UmJoonSIC project is available to save.')));
  const key = uriKey(project.uri);
  const pending = (projectSaves.get(key) ?? Promise.resolve()).catch(() => {}).then(() => writeProject(project, patch));
  projectSaves.set(key, pending);
  void pending.finally(() => { if (projectSaves.get(key) === pending) projectSaves.delete(key); }).catch(() => {});
  return pending;
}

async function writeProject(project: ProjectRecord, patch: ProjectPatch): Promise<void> {
  if (!project.uri || !project.data || project.error) throw new Error(project.error || vscode.l10n.t('No UmJoonSIC project is available to save.'));
  const document = await vscode.workspace.openTextDocument(project.uri);
  if (document.isDirty) throw new Error(vscode.l10n.t('The project file has unsaved changes. Save or discard them first.'));
  const version = document.version;
  const diskText = Buffer.from(await vscode.workspace.fs.readFile(project.uri)).toString('utf8');
  if (document.isDirty || document.version !== version) throw new Error(vscode.l10n.t('The project file is being edited. Save it first.'));
  const latest = parseProject(diskText);
  const update = typeof patch === 'function' ? await patch(latest) : patch;
  if (document.isClosed || document.isDirty || document.version !== version) throw new Error(vscode.l10n.t('The project file is being edited. Save it first.'));
  const data = parseProject(JSON.stringify({ ...latest, ...update }));
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (!isDeepStrictEqual(data, latest) && text !== document.getText()) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(project.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    if (!await vscode.workspace.applyEdit(edit) || !await document.save()) throw new Error(vscode.l10n.t('Could not save project settings.'));
  }
  await refreshProjects();
}

export async function createProjectFiles(folderUri: vscode.Uri): Promise<vscode.Uri> {
  if (folderUri.scheme !== 'file') throw new Error(vscode.l10n.t('Choose a folder on a local or Remote filesystem.'));
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(folderUri)?.uri;
  if (workspaceRoot && workspaceRoot.toString() !== folderUri.toString() && markerNames(await vscode.workspace.fs.readDirectory(workspaceRoot)).length) {
    throw new Error(vscode.l10n.t('This workspace already contains a .sic project. Open the existing project.'));
  }
  const entries = await vscode.workspace.fs.readDirectory(folderUri);
  if (markerNames(entries).length) throw new Error(vscode.l10n.t('This folder already contains a .sic project. Open the existing project.'));
  const sources = await uniqueSourcePaths(folderUri, entries.filter(([name, type]) => (type & vscode.FileType.File) && /\.asm$/i.test(name))
    .map(([name]) => projectPathForUri(folderUri, vscode.Uri.joinPath(folderUri, name))).sort());
  if (!sources.length) {
    await writeFile(vscode.Uri.joinPath(folderUri, 'main.asm').fsPath, 'MAIN     START 0\nFIRST    LDA VALUE\n         STA RESULT\nHALT     J HALT\nVALUE    WORD 7\nRESULT   RESW 1\n         END FIRST\n', { encoding: 'utf8', flag: 'wx' });
    sources.push('main.asm');
  }
  const projectUri = vscode.Uri.joinPath(folderUri, 'project.sic');
  const data: ProjectData = { asm: sources, filedevices: [], mode: 'sic' };
  await writeFile(projectUri.fsPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await refreshProjects();
  return projectUri;
}
