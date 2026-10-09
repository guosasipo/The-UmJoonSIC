import { scanText, type Mode } from './language';

export type DeviceUsage = { index: number; read: boolean; write: boolean; test: boolean; labels: string[] };

function integer(text: string): number | undefined {
  if (!/^-?(?:0x[\da-fA-F]+|0b[01]+|0o[0-7]+|\d+)$/.test(text)) return;
  const value = text.startsWith('-') ? -Number(text.slice(1)) : Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

function firstByte(op: string, operand: string, mode: Mode): number | undefined {
  if (mode === 'sic' && op === 'WORD' && integer(operand) === undefined) return;
  const hex = /^X'((?:[\da-fA-F]{2})+)'$/.exec(operand);
  if (hex) return parseInt(hex[1].slice(0, 2), 16);
  const text = /^C'([^']*)'$/.exec(operand);
  if (text) return Buffer.from(text[1], 'utf8')[0];
  const escaped = /^C"((?:[^"\\]|\\(?:["\\nrtbf0]|x[\da-fA-F]{2}))*)"$/.exec(operand);
  if (escaped) {
    const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '0': '\0', '"': '"', '\\': '\\' };
    return Buffer.from(escaped[1].replace(/\\(x[\da-fA-F]{2}|["\\nrtbf0])/g,
      (_, value: string) => value[0] === 'x' ? String.fromCharCode(parseInt(value.slice(1), 16)) : escapes[value]), 'utf8')[0];
  }
  const value = integer(operand);
  if (value === undefined) return;
  if (op === 'BYTE' && mode === 'sicxe' && value >= -128 && value <= 255) return value & 255;
  if (op === 'WORD' && value >= -0x800000 && value <= 0xFFFFFF) return (value >>> 16) & 255;
}

/** Declared device bytes only; indexed, indirect and computed addresses need the running machine. */
export function getDeviceUsage(sources: readonly string[], mode: Mode): DeviceUsage[] {
  const models = sources.map(text => scanText(text, mode));
  const scope = (file: number, section: string, name: string) => `${file}\0${section}\0${name}`;
  const definitions = new Map<string, { byte?: number; constant?: string } | undefined>();
  const accesses: { key: string; operand: string; access: 'read' | 'write' | 'test'; section: string; file: number }[] = [];
  models.forEach((model, file) => {
    const raw = sources[file].split(/\r?\n/);
    let pending: string | undefined;
    model.rows.forEach((row, line) => {
      if (row.continued) { pending = row.label?.value; return; }
      if (!row.op) { if (row.code.trim()) pending = undefined; return; }
      const label = row.label?.value ?? pending;
      pending = undefined;
      const op = row.op.value, operand = raw[line].slice(row.op.end, row.comment).trim();
      if (label) {
        const key = scope(file, row.section, label);
        const value = op === 'EQU' && mode === 'sicxe' ? { constant: operand }
          : { byte: /^(BYTE|WORD)$/.test(op) ? firstByte(op, operand, mode) : undefined };
        definitions.set(key, definitions.has(key) ? undefined : value);
      }
      const access = ({ RD: 'read', WD: 'write', TD: 'test' } as const)[op.replace(/^\+/, '') as 'RD' | 'WD' | 'TD'];
      if (access && !(mode === 'sic' && op.startsWith('+'))) accesses.push({ key: scope(file, row.section, operand), operand, access, section: row.section, file });
    });
  });
  const exported = new Map<string, string | undefined>();
  const imported = new Set<string>();
  models.forEach((model, file) => {
    for (const symbol of model.exports) exported.set(symbol.name, exported.has(symbol.name) ? undefined : scope(file, symbol.section, symbol.name));
    for (const symbol of model.imports) imported.add(scope(file, symbol.section, symbol.name));
  });
  const found = new Map<number, DeviceUsage>();
  for (const use of accesses) {
    if (/[, @]/.test(use.operand) && !use.operand.startsWith('=')) continue;
    let index: number | undefined, label: string | undefined;
    if (use.operand.startsWith('=')) {
      const literal = use.operand.slice(1).trim();
      const spec = /^(BYTE|WORD|B|W)\s*/.exec(literal);
      const op = spec ? (/^(BYTE|B)$/.test(spec[1]) ? 'BYTE' : 'WORD') : mode === 'sic' ? 'BYTE' : 'WORD';
      if (mode === 'sic' && op !== 'BYTE') continue;
      index = firstByte(op, literal.slice(spec?.[0].length ?? 0).trim(), mode);
    } else if (use.operand.startsWith('#') && mode === 'sicxe') {
      let value = use.operand.slice(1), key = scope(use.file, use.section, value);
      const seen = new Set<string>();
      // ponytail: simple EQU aliases only; use assembled symbols if full expressions are needed.
      while (definitions.get(key)?.constant !== undefined && !seen.has(key)) {
        seen.add(key);
        value = definitions.get(key)!.constant!;
        key = scope(use.file, use.section, value);
      }
      index = integer(value);
      if (index !== undefined && seen.size) label = use.operand.slice(1);
    } else {
      const key = definitions.has(use.key) ? use.key : imported.has(use.key) ? exported.get(use.operand) : undefined;
      index = key ? definitions.get(key)?.byte : undefined;
      if (index !== undefined) label = use.operand;
    }
    if (index === undefined || index < 0 || index > 255) continue;
    const entry = found.get(index) ?? { index, read: false, write: false, test: false, labels: [] };
    entry[use.access] = true;
    if (label && !entry.labels.includes(label)) entry.labels.push(label);
    found.set(index, entry);
  }
  return [...found.values()].sort((a, b) => a.index - b.index);
}
