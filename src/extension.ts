import * as vscode from 'vscode';
import { alignField, commentStart, formatDocument, getCompletions, getDefinition, getHover, getSymbols, insideFormattingString, moveField, previousFieldStart, type Mode } from './language';
import { currentFolder, modeFor, type ProjectTarget } from './projects';
import { registerSimulator } from './simulator';
import { getProject, initializeProjects, onDidChangeProjects, refreshProjects, saveProject } from './projectFiles';
import { registerProjectEditor } from './projectEditor';

const language = 'umjoonsic';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerSimulator(context);
  registerProjectEditor(context);
  const selector = { language };
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 110);
  status.command = 'umjoonsic.selectMode';
  status.name = vscode.l10n.t('UmJoonSIC machine mode');
  status.tooltip = vscode.l10n.t('Select SIC / SIC XE Mode');

  async function navigateField(backward: boolean): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const position = editor.selection.active, document = editor.document;
    const result = document.languageId === language && editor.selections.length === 1 && editor.selection.isEmpty &&
      vscode.workspace.getConfiguration('editor', document).get('formatOnType')
      ? moveField(document, position.line, position.character, modeFor(document), backward) : undefined;
    if (!result) { await vscode.commands.executeCommand(backward ? 'outdent' : 'tab'); return; }
    const line = document.lineAt(position.line), changed = line.text !== result.text, version = document.version;
    if (changed && !await editor.edit(edit => edit.replace(line.range, result.text))) return;
    if (vscode.window.activeTextEditor === editor && document.version === version + (changed ? 1 : 0)) {
      const target = new vscode.Position(position.line, result.character);
      editor.selection = new vscode.Selection(target, target);
    }
  }

  function updateStatus(): void {
    const document = vscode.window.activeTextEditor?.document;
    if (document?.languageId !== language) {
      status.hide();
      return;
    }
    status.text = modeFor(document) === 'sicxe' ? 'SIC/XE' : 'SIC';
    status.show();
  }

  context.subscriptions.push(
    status,
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.debug.onDidChangeActiveDebugSession(updateStatus),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('umjoonsic.mode')) updateStatus();
    }),
    vscode.workspace.onDidOpenTextDocument(updateStatus),
    onDidChangeProjects(updateStatus),
    vscode.languages.registerDocumentFormattingEditProvider(selector, {
      provideDocumentFormattingEdits(document) {
        const text = document.getText(), formatted = formatDocument(document, modeFor(document));
        return formatted === text ? [] : [vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(text.length)), formatted)];
      },
    }),
    vscode.languages.registerDocumentRangeFormattingEditProvider(selector, {
      provideDocumentRangeFormattingEdits(document, range) {
        const last = range.end.character === 0 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line;
        const lines = new vscode.Range(range.start.line, 0, last, document.lineAt(last).text.length);
        const text = document.getText(lines), formatted = formatDocument(document, modeFor(document), { startLine: range.start.line, endLine: last });
        return formatted === text ? [] : [vscode.TextEdit.replace(lines, formatted)];
      },
    }),
    vscode.languages.registerOnTypeFormattingEditProvider(selector, {
      provideOnTypeFormattingEdits(document, position, character) {
        const editor = vscode.window.activeTextEditor;
        if (editor?.document === document && (editor.selections.length !== 1 || !editor.selection.isEmpty)) return [];
        if (character === '\n') {
          if (!position.line) return [];
          const previous = document.lineAt(position.line - 1), current = document.lineAt(position.line);
          const mode = modeFor(document);
          const splitComment = commentStart(document, previous.lineNumber, mode) !== undefined && !!current.text.trim();
          if (!splitComment && (insideFormattingString(document, previous.lineNumber, previous.text.length, mode) ||
              insideFormattingString(document, position.line, position.character, mode))) return [];
          const formatted = formatDocument(document, mode, { startLine: previous.lineNumber, endLine: previous.lineNumber });
          const edits = formatted === previous.text ? [] : [vscode.TextEdit.replace(previous.range, formatted)];
          if (splitComment) {
            edits.push(vscode.TextEdit.replace(new vscode.Range(position.line, 0, position.line, current.firstNonWhitespaceCharacterIndex), '. '));
            return edits;
          }
          if (!current.text.trim() && current.text !== ' '.repeat(9)) edits.push(vscode.TextEdit.replace(current.range, ' '.repeat(9)));
          return edits;
        }
        const prefix = document.lineAt(position.line).text;
        if (position.character !== prefix.length) return [];
        if (insideFormattingString(document, position.line, position.character, modeFor(document))) return [];
        const aligned = alignField(prefix, modeFor(document), document, position.line);
        return aligned === undefined || aligned === prefix ? []
          : [vscode.TextEdit.replace(new vscode.Range(position.line, 0, position.line, position.character), aligned)];
      },
    }, ' ', '\n', '\t'),
    vscode.commands.registerCommand('umjoonsic.nextField', () => navigateField(false)),
    vscode.commands.registerCommand('umjoonsic.previousColumn', () => navigateField(true)),
    vscode.commands.registerTextEditorCommand('umjoonsic.previousField', (editor, edit) => {
      const position = editor.selection.active;
      const start = editor.document.languageId === language && vscode.workspace.getConfiguration('editor', editor.document).get('formatOnType') && editor.selections.length === 1 && editor.selection.isEmpty &&
        !insideFormattingString(editor.document, position.line, position.character, modeFor(editor.document))
        ? previousFieldStart(editor.document.lineAt(position.line).text, position.character, modeFor(editor.document)) : undefined;
      if (start === undefined) { void vscode.commands.executeCommand('deleteLeft'); return; }
      edit.delete(new vscode.Range(position.line, start, position.line, position.character));
    }),
    vscode.commands.registerCommand('umjoonsic.selectMode', async (target?: ProjectTarget) => {
      try {
        await refreshProjects();
        const folder = currentFolder(target);
        const project = getProject(folder);
        if (project?.error) throw new Error(project.error);
        const editor = vscode.window.activeTextEditor;
        if (!editor && !project?.data) {
          await vscode.window.showInformationMessage(vscode.l10n.t('Open a SIC assembly file first.'));
          return;
        }
        if (!target && editor?.document.uri.scheme === 'debug') {
          await vscode.window.showInformationMessage(vscode.l10n.t('Change the mode in the launch configuration, then start a new run.'));
          return;
        }
        const choice = await vscode.window.showQuickPick([
          { label: 'SIC', description: vscode.l10n.t('Basic SIC instructions'), mode: 'sic' as Mode },
          { label: 'SIC/XE', description: vscode.l10n.t('Extended instructions and addressing'), mode: 'sicxe' as Mode },
        ], { title: vscode.l10n.t('UmJoonSIC machine mode'), placeHolder: vscode.l10n.t('Mode for completion and instruction documentation') });
        if (!choice || (!target && editor?.document.isClosed)) return;
        if (project?.data) await saveProject(project, { mode: choice.mode });
        else {
          const configurationTarget = folder
            ? vscode.ConfigurationTarget.WorkspaceFolder
            : vscode.workspace.workspaceFolders?.length
              ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
          await vscode.workspace.getConfiguration('umjoonsic', folder?.uri ?? editor?.document)
            .update('mode', choice.mode, configurationTarget);
        }
        if (!target && editor && editor.document.languageId !== language) {
          await vscode.languages.setTextDocumentLanguage(editor.document, language);
        }
        updateStatus();
      } catch (error) { await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
    }),
    vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems(document, position) {
        const kinds = {
          instruction: vscode.CompletionItemKind.Keyword,
          directive: vscode.CompletionItemKind.Keyword,
          register: vscode.CompletionItemKind.Variable,
          symbol: vscode.CompletionItemKind.Reference,
          value: vscode.CompletionItemKind.Value,
        };
        return getCompletions(document, position.line, position.character, modeFor(document))
          .map(suggestion => {
            const item = new vscode.CompletionItem(suggestion.label, kinds[suggestion.kind]);
            item.insertText = suggestion.insertText ?? suggestion.label;
            item.range = new vscode.Range(position.line, suggestion.start, position.line, suggestion.end);
            item.detail = suggestion.detail;
            if (suggestion.documentation) item.documentation = new vscode.MarkdownString(suggestion.documentation);
            return item;
          });
      },
    }, ' ', '\t', '+', '#', '@', ','),
    vscode.languages.registerHoverProvider(selector, {
      provideHover(document, position) {
        const info = getHover(document, position.line, position.character, modeFor(document));
        if (!info) return undefined;
        return new vscode.Hover(new vscode.MarkdownString(info.markdown),
          new vscode.Range(position.line, info.start, position.line, info.end));
      },
    }),
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition(document, position) {
        const location = getDefinition(document, position.line, position.character, modeFor(document));
        if (!location) return undefined;
        return new vscode.Location(document.uri,
          new vscode.Range(location.line, location.start, location.line, location.end));
      },
    }),
    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols(document) {
        const kinds = {
          data: vscode.SymbolKind.Variable,
          constant: vscode.SymbolKind.Constant,
          label: vscode.SymbolKind.Function,
          section: vscode.SymbolKind.Namespace,
        };
        return getSymbols(document, modeFor(document)).map(symbol => {
          const range = new vscode.Range(symbol.line, symbol.start, symbol.line, symbol.end);
          return new vscode.DocumentSymbol(symbol.name, symbol.section, kinds[symbol.kind], range, range);
        });
      },
    }),
  );
  await initializeProjects(context);
  updateStatus();
}
