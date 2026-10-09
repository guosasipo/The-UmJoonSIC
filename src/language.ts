import instructions from './instructions.json';

export type Mode = 'sic' | 'sicxe';
export type Completion = {
  label: string; insertText?: string; kind: 'instruction' | 'directive' | 'register' | 'symbol' | 'value';
  detail?: string; documentation?: string; start: number; end: number;
};
export type SourceSymbol = {
  name: string; line: number; start: number; end: number; section: string;
  kind: 'data' | 'constant' | 'label' | 'section';
};
type Entry = (typeof instructions.sicxe)[number];
type Token = { value: string; start: number; end: number };
type Row = {
  code: string; comment: number; strings: { start: number; end: number; closed: boolean }[];
  label?: Token; op?: Token; section: string; continued?: boolean; literalContinuation?: boolean;
};
type NamedLocation = Omit<SourceSymbol, 'kind'>;
type SourceDocument = { readonly version: number; getText(): string };
type SourceInput = string | SourceDocument;
const analyses = new WeakMap<SourceDocument, { version: number; mode: Mode; model: ReturnType<typeof scanText> }>();
const registers = ['A', 'X', 'L', 'B', 'S', 'T', 'F'];
const wordPattern = /\+?[\p{L}\p{N}_]+|\+/gu;
const identifierPattern = /^[\p{L}_][\p{L}\p{N}_]*$/u;

function entryFor(name: string, mode: Mode): Entry | undefined {
  const key = name.replace(/^\+/, '').toUpperCase();
  const entry = instructions[mode].find(item => item.name === key);
  return name.startsWith('+') && !entry?.extended ? undefined : entry;
}

function scanLine(raw: string, mode: Mode): Row {
  let code = raw;
  const strings: Row['strings'] = [];
  let comment = raw.length + 1;
  // Only XE FLOT data (including =FLOT literals) consumes an unquoted decimal point.
  // In WORD 1.5, the assembler reads integer 1 followed by comment .5 instead.
  const operation = /^(?:[\p{L}_][\p{L}\p{N}_]*[ \t]+)?[ \t]*(\+?[\p{L}_][\p{L}\p{N}_]*)[ \t]+/u.exec(raw);
  const entry = operation && entryFor(operation[1], mode);
  const literal = entry?.format === 'F3m' && /^=FLOT[ \t]*/.exec(raw.slice(operation![0].length));
  const dataStart = operation ? operation[0].length + (literal ? literal[0].length : 0) : 0;
  const number = mode === 'sicxe' && (entry?.name === 'FLOT' || literal) && /^-?\d+\.\d*/.exec(raw.slice(dataStart));
  const decimal = number ? dataStart + number[0].indexOf('.') : -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '.' && i !== decimal) { comment = i; code = code.slice(0, i); break; }
    if (raw[i] !== "'" && raw[i] !== '"') continue;
    const start = i, quote = raw[i++];
    while (i < raw.length && raw[i] !== quote) {
      if (quote === '"' && raw[i] === '\\') i++;
      i++;
    }
    const closed = i < raw.length, end = closed ? i + 1 : raw.length;
    strings.push({ start, end, closed });
    code = code.slice(0, start) + ' '.repeat(end - start) + code.slice(end);
  }
  const tokens = [...code.matchAll(wordPattern)].map(match => ({ value: match[0], start: match.index!, end: match.index! + match[0].length }));
  const label = tokens[0]?.start === 0 && identifierPattern.test(tokens[0].value) ? tokens.shift() : undefined;
  const op = tokens[0];
  return { code, strings, comment, label, op, section: '' };
}

function scan(source: SourceInput, mode: Mode) {
  if (typeof source === 'string') return scanText(source, mode);
  const cached = analyses.get(source);
  if (cached?.version === source.version && cached.mode === mode) return cached.model;
  const model = scanText(source.getText(), mode);
  analyses.set(source, { version: source.version, mode, model });
  return model;
}

export function scanText(text: string, mode: Mode) {
  const lines = text.split(/\r?\n/), rows = lines.map(raw => scanLine(raw, mode));
  let characterData = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (characterData) {
      row.literalContinuation = true;
      characterData = !lines[i].includes("'");
      // This physical line belongs to the earlier BYTE/WORD/FLOT, not a new statement.
      row.code = ' '.repeat(lines[i].length); row.label = row.op = undefined;
      row.comment = 0; row.strings = [];
    } else characterData = opensCharacterString(lines[i], row);
  }
  const symbols: SourceSymbol[] = [], imports: NamedLocation[] = [], blocks: NamedLocation[] = [], exports: NamedLocation[] = [];
  const symbolByLine = new Map<number, number>();
  let section = '', defaultSection = '', pending: number | undefined;
  for (let line = 0; line < rows.length; line++) {
    const row = rows[line];
    let labelLine = line;
    if (pending !== undefined && row.code.trim()) {
      // Java permits a label on its own line, followed by comments and its instruction.
      // The first word after that label is the opcode, even when its operand is also an opcode name.
      if (entryFor((row.label ?? row.op)?.value ?? '', mode)) {
        labelLine = pending;
        rows[labelLine].continued = true;
        if (row.label) { row.op = row.label; row.label = undefined; }
      }
      pending = undefined;
    }
    const label = rows[labelLine].label;
    const name = entryFor(row.op?.value ?? '', mode)?.name;
    if (label && name === 'START') defaultSection = label.value;
    if (label && (name === 'START' || name === 'CSECT')) section = label.value;
    if (name === 'END') section = defaultSection;
    row.section = section;
    rows[labelLine].section = section;
    if (label) {
      const symbol: SourceSymbol = {
        name: label.value, line: labelLine, start: label.start, end: label.end, section,
        kind: name === 'START' || name === 'CSECT' ? 'section' : name === 'EQU' ? 'constant' : name && /^(RES[BWF]|BYTE|WORD|FLOT)$/.test(name) ? 'data' : 'label',
      };
      const previous = symbolByLine.get(labelLine);
      if (previous === undefined) { symbolByLine.set(labelLine, symbols.length); symbols.push(symbol); }
      else symbols[previous] = symbol;
    }
    if (row.label && !row.op) pending = line;
    if (row.op && (name === 'EXTREF' || name === 'EXTDEF' || name === 'USE')) {
      for (const match of row.code.slice(row.op.end).matchAll(/[\p{L}_][\p{L}\p{N}_]*/gu)) {
        const start = row.op.end + match.index!;
        const location = { name: match[0], line, start, end: start + match[0].length, section };
        (name === 'EXTREF' ? imports : name === 'EXTDEF' ? exports : blocks).push(location);
      }
    }
  }
  return { text, rows, symbols, imports, blocks, exports };
}

function blocked(row: Row, character: number): boolean {
  return character >= row.comment || row.strings.some(string => character > string.start && (character < string.end || (!string.closed && character === string.end)));
}

function wordAt(row: Row, character: number): Token {
  return [...row.code.matchAll(wordPattern)].map(match => {
    const operator = match[0].startsWith('+') && match.index !== row.op?.start;
    return { value: operator ? match[0].slice(1) : match[0], start: match.index! + (operator ? 1 : 0), end: match.index! + match[0].length };
  })
    .find(token => token.start <= character && character <= token.end) ?? { value: '', start: character, end: character };
}

function describe(entry: Entry, mode: Mode, extended = false): string {
  const opcode = entry.opcode === null ? '' : ` · opcode \`${entry.opcode.toString(16).toUpperCase().padStart(2, '0')}\``;
  const format = entry.format.startsWith('F') ? `Format ${extended ? '4' : entry.extended ? '3/4' : entry.format[1]}` : 'Directive';
  const notes = entry.name === 'START'
    ? mode === 'sic' ? '\n\nSIC: `START 1000` = 0x1000 (4096). The address uses hexadecimal digits without a prefix.' : '\n\nSIC/XE: `START 1000` = 1000 (decimal). Use `START 0x1000` for hexadecimal 4096.'
    : '';
  return `**${extended ? '+' : ''}${entry.name}** — ${format}${opcode}\n\n${entry.description}\n\nOperand: \`${entry.operand || '(none)'}\`${entry.effect ? `\n\n${entry.effect}` : ''}${entry.implemented ? '' : '\n\n⚠ The original VM does not implement this instruction.'}${notes}`;
}

export function getSymbols(text: SourceInput, mode: Mode): SourceSymbol[] {
  return scan(text, mode).symbols;
}

export function getExportedSymbols(text: SourceInput, mode: Mode): SourceSymbol[] {
  const model = scan(text, mode);
  const exported = new Set(model.exports.map(symbol => `${symbol.section}::${symbol.name}`));
  return model.symbols.filter(symbol => exported.has(`${symbol.section}::${symbol.name}`));
}

function layoutLine(raw: string, row: Row, mode: Mode, partial = false): string | undefined {
  const op = row.op;
  const entry = op && entryFor(op.value, mode);
  if (!op || !entry || op.value !== op.value.toUpperCase() || row.strings.some(string => !string.closed)) return undefined;
  if (!/^[ \t]+$/.test(raw.slice(row.label?.end ?? 0, op.start))) return undefined;
  const operand = raw.slice(op.end, row.comment).trim();
  if (operand && !/^[ \t]/.test(raw.slice(op.end))) return undefined;
  const emptyOperand = /^(F1|F3|D)$/.test(entry.format);
  const optionalOperand = entry.format === 'De0' || entry.format === 'Ds0' || (mode === 'sic' && entry.name === 'END');
  if (emptyOperand ? !!operand : !partial && !optionalOperand && !operand) return undefined;
  // Keep uncertain or unfinished fields intact; the assembler owns semantic validation.
  const field = row.code.slice(op.end).trim().replace(/^=(?:BYTE|B|WORD|W|FLOT)\s+/, '=');
  const compact = field.replace(/\s*([+\-*/%,#@=])\s*/g, '$1');
  if (/\s/.test(compact) || /[^\p{L}\p{N}_.+\-*/%,#@=]/u.test(compact) || /[,+\-/%#@=]$/.test(compact)) return undefined;
  if (compact.endsWith('*') && compact !== '*') return undefined;
  let formatted = row.label?.value ?? '';
  const append = (value: string, column: number) => {
    formatted += ' '.repeat(Math.max(1, column - 1 - formatted.length)) + value;
  };
  append(op.value, 10);
  if (operand) append(operand, 18);
  if (row.comment < raw.length) append(raw.slice(row.comment), 36);
  return formatted;
}

function opensCharacterString(raw: string, row: Row): boolean {
  return row.strings.some(string => !string.closed && raw[string.start] === "'" &&
    raw[string.start - 1]?.toUpperCase() === 'C');
}

/** Lines spanning a single-quoted character constant are source bytes, including indentation. */
function quotedLines(lines: string[], rows: Row[]): Set<number> {
  const protectedLines = new Set<number>();
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    if (open) {
      protectedLines.add(i);
      if (lines[i].includes("'")) open = false;
    } else if (opensCharacterString(lines[i], rows[i])) {
      protectedLines.add(i);
      open = true;
    }
  }
  return protectedLines;
}

function formattingBlock(lines: string[], mode: Mode): string[] {
  const nonblank = lines.filter(line => line.trim());
  if (nonblank.length < 2) return lines;
  if (nonblank.every(line => /^[ \t]*\d+(?:[ \t]|$)/.test(line)))
    lines = lines.map(line => line.replace(/^[ \t]*\d+(?:[ \t]+|$)/, ''));
  const code = lines.filter(line => line.trim() && !/^[ \t]*\./.test(line));
  const indentation = code.reduce((least, line) => Math.min(least, /^[ \t]*/.exec(line)![0].length), code[0]?.length ?? 0);
  // Already valid indented instructions must not become opcode-named labels.
  const hiddenLabel = code.some(line => {
    const words = line.trim().split(/[ \t]+/);
    return !entryFor(words[0], mode) && identifierPattern.test(words[0]) &&
      (words.length === 1 || !!entryFor(words[1], mode));
  });
  return indentation && hiddenLabel
    ? lines.map(line => line.slice(Math.min(indentation, /^[ \t]*/.exec(line)![0].length))) : lines;
}

function formattingFields(original: Row, mode: Mode): { label?: Token; op: Token } | undefined {
  let label = original.label, op = original.op;
  if (!op || !entryFor(op.value, mode)) {
    const words = [...original.code.matchAll(wordPattern)].map(match =>
      ({ value: match[0], start: match.index!, end: match.index! + match[0].length }));
    if (words[0] && entryFor(words[0].value, mode)) { op = words[0]; label = undefined; }
    else if (words[1] && identifierPattern.test(words[0].value) && entryFor(words[1].value, mode)) {
      label = words[0]; op = words[1];
    } else return undefined;
  }
  return { label, op };
}

function formatLine(raw: string, original: Row, mode: Mode, partial = false): string {
  if (original.continued || original.strings.some(string => !string.closed)) return raw;
  if (!raw.trim()) return '';
  if (/^[ \t]*\./.test(raw)) return raw.trim();
  const fields = formattingFields(original, mode);
  if (!fields) return raw;
  const { label, op } = fields;
  const entry = entryFor(op.value, mode)!;
  let tail = raw.slice(op.end);
  if (entry.format === 'F3m') tail = tail.replace(/^([ \t]*=)(byte|word|flot|b|w)(?=[ \t]|[cxf]['"]|[-\d])/i,
    (_, before: string, type: string) => before + type.toUpperCase());
  if (entry.format.startsWith('Sd') || entry.format === 'F3m' && /^[ \t]*=/.test(tail))
    tail = tail.replace(/^([ \t]*(?:=(?:(?:BYTE|WORD|FLOT|B|W)[ \t]*)?)?)([cxf])(?=['"])/i,
      (_, before: string, type: string) => before + (mode === 'sic' && type.toUpperCase() === 'F' ? type : type.toUpperCase()));
  let candidate = `${label?.value ?? ''} ${op.value.toUpperCase()}${tail}`;
  let row = scanLine(candidate, mode);
  if (row.strings.some(string => !string.closed)) return raw;
  const operand = candidate.slice(row.op!.end, row.comment);
  let normalized = operand;
  if (entry.format.startsWith('F2r')) normalized = operand.split(',').map((part, index) => {
    if (index > 0 && entry.format !== 'F2rr') return part;
    return part.replace(/^([ \t]*)([axlbstf])([ \t]*)$/i, (_, left: string, register: string, right: string) => left + register.toUpperCase() + right);
  }).join(',');
  else if (entry.format === 'F3m' && !row.strings.length) normalized = operand.replace(/,([ \t]*)x([ \t]*)$/, ',X$2');
  candidate = candidate.slice(0, row.op!.end) + normalized + candidate.slice(row.comment);
  row = scanLine(candidate, mode);
  const aligned = layoutLine(candidate, row, mode, partial);
  if (aligned !== undefined) return aligned;
  if (row.comment <= candidate.length) return raw;
  for (const match of candidate.matchAll(/[ \t]+/g)) {
    const start = match.index!, end = start + match[0].length;
    if (start < row.op!.end || blocked(row, start)) continue;
    const comment = candidate.slice(end).trimEnd();
    // Keep ambiguous extra operands visible; recover only a comment gap or prose.
    if (!comment || /^[,+\-*/%#@='"\d]|^[CXF]['"]/i.test(comment) ||
        !(start >= 35 || match[0].length >= 2 || /[\p{L}].*[ \t]+[\p{L}]/u.test(comment) ||
          /^(F1|F3|D)$/.test(entry.format) && /^[a-z\p{Script=Hangul}]/u.test(comment))) continue;
    const prefix = candidate.slice(0, start), prefixRow = scanLine(prefix, mode);
    const formatted = layoutLine(prefix, prefixRow, mode);
    if (formatted !== undefined) return formatted + ' '.repeat(Math.max(1, 35 - formatted.length)) + '. ' + comment;
  }
  return raw;
}

/** Format a document or complete selected lines with the surrounding label/string context. */
export function formatDocument(source: SourceInput, mode: Mode, range?: { startLine: number; endLine: number }): string {
  const model = scan(source, mode), parts = model.text.split(/(\r?\n)/);
  const lines = parts.filter((_, index) => index % 2 === 0);
  const start = range?.startLine ?? 0, end = Math.min(range?.endLine ?? lines.length - 1, lines.length - 1);
  const protectedLines = quotedLines(lines, model.rows);
  let block = lines.slice(start, end + 1);
  if (![...protectedLines].some(line => line >= start && line <= end)) block = formattingBlock(block, mode);
  const working = [...lines]; working.splice(start, block.length, ...block);
  const rows = block.some((line, index) => line !== lines[start + index]) ? scanText(working.join('\n'), mode).rows : model.rows;
  return block.map((raw, index) => {
    const line = start + index;
    const formatted = protectedLines.has(line) ? lines[line] : formatLine(raw, rows[line], mode);
    return (index ? parts[line * 2 - 1] : '') + formatted;
  }).join('');
}

export function insideFormattingString(source: SourceInput, line: number, character: number, mode: Mode): boolean {
  const model = scan(source, mode), row = model.rows[line];
  return !!row && (quotedLines(model.text.split(/\r?\n/), model.rows).has(line) ||
    row.strings.some(string => character > string.start && (character < string.end || !string.closed)));
}

/** A real comment may follow the closing quote of a physical multiline character constant. */
export function commentStart(source: SourceInput, line: number, mode: Mode): number | undefined {
  const model = scan(source, mode), row = model.rows[line], raw = model.text.split(/\r?\n/)[line];
  if (!row) return undefined;
  if (row.literalContinuation) {
    const end = raw.indexOf("'");
    if (end < 0) return undefined;
    const tail = raw.slice(end + 1), comment = scanLine(tail, mode).comment;
    return comment < tail.length ? end + 1 + comment : undefined;
  }
  return row.comment < raw.length ? row.comment : undefined;
}

/** Complete the typed field, leaving quoted data and unfinished operands intact. */
export function alignField(prefix: string, mode: Mode, source?: SourceInput, line = 0): string | undefined {
  if (!/[ \t]$/.test(prefix)) return undefined;
  const row = (source && scan(source, mode).rows[line]) || scanLine(prefix, mode), trimmed = prefix.trimEnd();
  if (row.comment < prefix.length || row.strings.some(string => !string.closed)) return undefined;
  if (!trimmed) return ' '.repeat(9);
  const pad = (text: string, column: number) => text + ' '.repeat(Math.max(1, column - text.length));
  const continued = row.continued;
  if (row.label && !row.op && (continued || !entryFor(row.label.value, mode)) && trimmed === row.label.value)
    return pad(trimmed, 9);
  const formatted = formatLine(trimmed, row, mode, true), formattedRow = scanLine(formatted, mode);
  const entry = formattedRow.op && entryFor(formattedRow.op.value, mode);
  if (!entry) {
    const bare = !continued && row.label && !row.op && entryFor(row.label.value, mode);
    return bare ? pad(' '.repeat(9) + row.label!.value.toUpperCase(), /^(F1|F3|D)$/.test(bare.format) ? 35 : 17) : undefined;
  }
  const operand = formatted.slice(formattedRow.op!.end, formattedRow.comment).trim();
  if (!operand) return pad(formatted, /^(F1|F3|D)$/.test(entry.format) ? 35 : 17);
  return layoutLine(formatted, formattedRow, mode) === undefined ? undefined : pad(formatted, 35);
}

/** Backspace collapses an empty aligned field, without joining existing tokens. */
export function previousFieldStart(line: string, character: number, mode: Mode): number | undefined {
  if (character !== line.length || !/[ \t]{2,}$/.test(line) || alignField(line, mode) !== line) return undefined;
  return line.trimEnd().length;
}

export function moveField(source: SourceInput, line: number, character: number, mode: Mode, backward = false): { text: string; character: number } | undefined {
  const model = scan(source, mode), raw = model.text.split(/\r?\n/)[line], row = model.rows[line];
  if (!row || insideFormattingString(source, line, character, mode) || character >= row.comment) return undefined;
  if (!backward && !raw.slice(character).trim()) {
    const aligned = alignField(raw.slice(0, character) + ' ', mode, source, line);
    return aligned === undefined ? undefined : { text: aligned, character: aligned.length };
  }
  const fields = row.continued ? undefined : formattingFields(row, mode);
  const current = fields ? { ...row, ...fields } : row;
  const noOperand = current.op && /^(F1|F3|D)$/.test(entryFor(current.op.value, mode)?.format ?? '');
  const stops = (text: string, value: Row) => {
    const operand = value.op && /\S/.exec(text.slice(value.op.end, value.comment));
    return [0, value.op?.start ?? 9,
      ...(!noOperand ? [operand && value.op ? value.op.end + operand.index : Math.max(17, (value.op?.end ?? 0) + 1)] : []),
      value.comment <= text.length ? value.comment : Math.max(35, text.trimEnd().length + 1)];
  };
  const starts = stops(raw, current);
  if (backward) return { text: raw, character: [...new Set(starts)].filter(start => start < character).sort((a, b) => b - a)[0] ?? 0 };
  const next = starts.findIndex(start => start > character);
  if (next < 0) return undefined;
  const text = formatDocument(source, mode, { startLine: line, endLine: line });
  const target = stops(text, scanLine(text, mode))[next];
  return { text: text.padEnd(target), character: target };
}

export function getCompletions(text: SourceInput, line: number, character: number, mode: Mode): Completion[] {
  const model = scan(text, mode), row = model.rows[line];
  if (!row || blocked(row, character)) return [];
  const word = wordAt(row, character), prefix = word.value.slice(0, character - word.start);
  const position = { start: word.start, end: word.end };
  const finish = (items: Omit<Completion, 'start' | 'end'>[]) => {
    const seen = new Set<string>();
    return items
      .filter(item => item.kind === 'symbol' ? item.label.startsWith(prefix) : item.label.toUpperCase().startsWith(prefix.toUpperCase()))
      .filter(item => { if (seen.has(item.label)) return false; seen.add(item.label); return true; })
      .map(item => ({ ...item, ...position }));
  };
  const bareOpcode = row.label && !row.op && !row.continued && character <= row.label.end && row.label.start === 0;
  const opcodePosition = bareOpcode || (row.op ? character >= row.op.start && character <= row.op.end : !row.label || character > row.label.end);
  if (opcodePosition) {
    const extended = prefix.startsWith('+');
    const indent = (bareOpcode || (!row.label && word.start === 0)) ? '\t' : '';
    return finish(instructions[mode].filter(entry => !extended || entry.extended).map(entry => {
      const label = `${extended ? '+' : ''}${entry.name}`;
      return { label, insertText: indent + label, kind: entry.format.startsWith('F') ? 'instruction' : 'directive', detail: entry.operand, documentation: describe(entry, mode, extended) };
    }));
  }
  if (!row.op || character <= row.op.end) return [];
  const entry = entryFor(row.op.value, mode);
  if (!entry || entry.format === 'F1' || entry.format === 'F3' || entry.format === 'D') return [];
  const operand = row.code.slice(row.op.end, character), beforeWord = row.code.slice(row.op.end, word.start);
  const parts = operand.split(','), segmentBeforeWord = beforeWord.slice(beforeWord.lastIndexOf(',') + 1);
  const values = (names: string[], kind: 'register' | 'value' = 'value', detail?: string) => finish(names.map(label => ({ label, kind, detail })));
  const local = model.symbols.filter(symbol => symbol.section === row.section);
  const visible = (includeImports: boolean) => [...local, ...(includeImports ? model.imports.filter(symbol => symbol.section === row.section) : [])];
  const symbolItems = (symbols: NamedLocation[]) => symbols.map(symbol => ({ label: symbol.name, kind: 'symbol' as const, detail: `${symbol.section || '(default)'} · line ${symbol.line + 1}` }));
  if (entry.format.startsWith('F2')) {
    if (segmentBeforeWord.trim()) return [];
    if (parts.length === 1) return entry.format === 'F2n' ? values(Array.from({ length: 16 }, (_, i) => String(i)), 'value', 'SVC number: 0–15') : values(registers, 'register');
    if (parts.length !== 2 || !registers.includes(parts[0].trim().toUpperCase())) return [];
    if (entry.format === 'F2rr') return values(registers, 'register');
    return entry.format === 'F2rn' ? values(Array.from({ length: 16 }, (_, i) => String(i + 1)), 'value', 'Shift count: 1–16') : [];
  }
  if (entry.format === 'F3m') {
    if (parts.length > 1) {
      if (parts.length !== 2 || segmentBeforeWord.trim() || !/^(?:[\p{L}_][\p{L}\p{N}_]*|\d[\da-fxob]*)$/iu.test(parts[0].trim())) return [];
      return values(['X'], 'register', 'Indexed addressing');
    }
    if (/^\s*=\s*$/.test(beforeWord)) return values(mode === 'sic' ? ["C''", "X''"] : ["C''", "X''", 'WORD 0', "BYTE C''", "FLOT F'0.0'"]);
    if (!(mode === 'sicxe' ? /^\s*[#@]?$/ : /^\s*$/).test(beforeWord)) return [];
    const items: Omit<Completion, 'start' | 'end'>[] = symbolItems(visible(row.op.value.startsWith('+')));
    if (!operand.trim()) {
      items.push(...(mode === 'sicxe' ? ['#', '@'] : []).map(label => ({ label, kind: 'value' as const, detail: label === '#' ? 'Immediate addressing' : 'Indirect addressing' })));
    }
    return finish(items);
  }
  if (entry.name === 'USE') return beforeWord.trim() ? [] : values(model.blocks.filter(block => block.section === row.section && block.line !== line).map(block => block.name), 'value', 'Program block (same symbol scope)');
  if (entry.name === 'EXTDEF' || entry.name === 'EXTREF') {
    if (segmentBeforeWord.trim()) return [];
    const used = parts.slice(0, -1).map(part => part.trim());
    const candidates = entry.name === 'EXTDEF' ? local : [...model.exports.filter(symbol => symbol.section !== row.section), ...model.imports.filter(symbol => symbol.section === row.section)];
    return finish(symbolItems(candidates.filter(symbol => symbol.name.length <= 6 && !used.includes(symbol.name) && (symbol.line !== line || symbol.start !== word.start))));
  }
  if (entry.format.startsWith('Sd')) {
    if (beforeWord.trim()) return [];
    return values(mode === 'sic' ? entry.name === 'BYTE' ? ["C''", "X''"] : ['0'] : ["C''", "X''", "F'0.0'", '0']);
  }
  if (mode === 'sic' && entry.name !== 'END') return beforeWord.trim() ? [] : values(entry.name === 'START' ? ['0', '1000'] : ['0', '1']);
  // Only XE expression directives accept operators; instruction operands and WORD do not.
  if (mode === 'sic' ? beforeWord.trim() : !/^\s*(?:[^#@,]*[+\-*/%]\s*)?$/.test(beforeWord)) return [];
  return finish(symbolItems(local));
}

export function reference(text: SourceInput, line: number, character: number, mode: Mode) {
  const model = scan(text, mode), row = model.rows[line];
  if (!row || blocked(row, character)) return undefined;
  const word = wordAt(row, character);
  if (!word.value) return undefined;
  const entry = row.op ? entryFor(row.op.value, mode) : undefined;
  if (row.op && word.start === row.op.start) return { word, entry, extended: row.op.value.startsWith('+') };
  if (!identifierPattern.test(word.value)) return undefined;
  if (row.label?.start === word.start) return { word, symbol: model.symbols.find(symbol => symbol.line === line), external: false, block: false };
  const operandPrefix = row.op ? row.code.slice(row.op.end, word.start) : '';
  if (entry && row.op && word.start > row.op.end && registers.includes(word.value)) {
    if ((entry.format.startsWith('F2r') && /^\s*$/.test(operandPrefix)) ||
        (entry.format === 'F2rr' && /^\s*[AXLBSTF]\s*,\s*$/.test(operandPrefix)) ||
        (entry.format === 'F3m' && word.value === 'X' && /^\s*[^,=]+,\s*$/.test(operandPrefix)))
      return { word, register: word.value };
  }
  if (!entry || !row.op || word.start <= row.op.end || /^(F1|F2|F3$|D$|Sd)/.test(entry.format)) return undefined;
  if (entry.format === 'F3m' && /[,=]/.test(operandPrefix)) return undefined;
  if (mode === 'sic' && entry.name !== 'END' && entry.format !== 'F3m') return undefined;
  const block = entry.name === 'USE';
  const symbol = (block ? model.blocks : [...model.symbols, ...model.imports])
    .find(symbol => symbol.name === word.value && symbol.section === row.section);
  return { word, symbol, external: !!symbol && model.imports.includes(symbol), block };
}

export function getDefinition(text: SourceInput, line: number, character: number, mode: Mode): { line: number; start: number; end: number } | undefined {
  const symbol = reference(text, line, character, mode)?.symbol;
  return symbol && { line: symbol.line, start: symbol.start, end: symbol.end };
}

export function getHover(text: SourceInput, line: number, character: number, mode: Mode): { markdown: string; start: number; end: number } | undefined {
  const target = reference(text, line, character, mode);
  if (!target) return undefined;
  const { word, symbol, entry } = target;
  const markdown = entry ? describe(entry, mode, target.extended) : symbol
    ? `**${symbol.name}** — ${target.block ? 'Program block' : target.external ? 'External reference' : 'kind' in symbol ? symbol.kind : 'Symbol'}\n\nSection: \`${symbol.section || '(default)'}\` · line ${symbol.line + 1}${target.external ? '\n\nDeclared with EXTREF; the definition is resolved by the linker. Memory instructions require format 4 (`+`).' : ''}`
    : undefined;
  return markdown ? { markdown, start: word.start, end: word.end } : undefined;
}
