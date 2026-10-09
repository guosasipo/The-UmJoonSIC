package umjoonsic;

import java.io.StringWriter;
import java.io.StringReader;
import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Compiler facade; source buffers and generated artifacts never replace workspace files. */
public final class AssemblyService {
    public static final class Source {
        public String uri;
        public String text;
        public Source() {}
        public Source(String uri, String text) { this.uri = uri; this.text = text; }
    }
    public static final class Diagnostic {
        public String uri, message, severity;
        public int offset, length;
    }
    private record DiagnosticKey(String uri, int offset, int length, String message, String severity) {}
    public static final class Row {
        public String uri, bytes, source, section, instruction, operand, label, nixbpe;
        public int line, column, length, address, size;
        public boolean executable;
        // Build-only metadata: never serialized to the editor protocol.
        private transient int relocationAddressBits;
        private transient boolean requiresFixedPlacement;
        private transient String format4Reference;
    }
    public static final class Symbol {
        public String name, uri, type, section;
        public int line, address, size, elementSize, count;
    }
    public static final class Artifact {
        public String name, content;
        Artifact(String name, String content) { this.name = name; this.content = content; }
    }
    public static final class Segment {
        public int address;
        public String bytes;
        Segment(int address, String bytes) { this.address = address; this.bytes = bytes; }
    }
    public static final class Result {
        public boolean success;
        public int entry;
        public List<Diagnostic> diagnostics = new ArrayList<>();
        private final transient Set<DiagnosticKey> diagnosticKeys = new HashSet<>();
        public List<Row> rows = new ArrayList<>();
        public List<Symbol> symbols = new ArrayList<>();
        public List<Artifact> artifacts = new ArrayList<>();
        public List<Segment> segments = new ArrayList<>();
    }
    private static final class Unit {
        final Source source;
        final String stem;
        final boolean build;
        final int[] lineStarts;
        final List<Row> rows = new ArrayList<>();
        final List<Symbol> symbols = new ArrayList<>();
        final Map<String, Integer> sectionStarts = new HashMap<>();
        final Map<String, Integer> sectionSizes = new HashMap<>();
        String name, object, log;
        int entry;
        boolean external;
        Unit(Source source, String stem, boolean build) {
            this.source = source; this.stem = stem; this.build = build;
            lineStarts = build ? new int[1 + (int) source.text.chars().filter(c -> c == '\n').count()] : null;
            if (build) {
                int line = 1;
                for (int i = 0; i < source.text.length(); i++)
                    if (source.text.charAt(i) == '\n') lineStarts[line++] = i + 1;
            }
        }
        int line(int offset) {
            int index = Arrays.binarySearch(lineStarts, Math.max(0, Math.min(offset, source.text.length())));
            return index >= 0 ? index : -index - 2;
        }
    }
    private static final HexFormat HEX = HexFormat.of().withUpperCase();

    public Result analyze(String mode, List<Source> sources) {
        return compile(mode, sources, null, false);
    }

    public Result assemble(String mode, List<Source> sources, String mainSection) {
        return compile(mode, sources, mainSection, true);
    }

    private Result compile(String mode, List<Source> sources, String mainSection, boolean build) {
        Result result = new Result();
        Source fallback = new Source("", "");
        if (!"sic".equals(mode) && !"sicxe".equals(mode)) {
            diagnostic(result, fallback, 0, 0, "Mode must be sic or sicxe", false);
            return result;
        }
        if (sources == null || sources.isEmpty()) {
            diagnostic(result, fallback, 0, 0, "No source files", false);
            return result;
        }
        List<Unit> units = new ArrayList<>();
        Set<String> uris = new HashSet<>();
        int limit = "sic".equals(mode) ? 0x8000 : 0x100000;
        for (int i = 0; i < sources.size(); i++) {
            Source source = sources.get(i);
            if (source == null || source.uri == null || source.text == null) {
                diagnostic(result, fallback, 0, 0, "Each source needs uri and text", false);
                continue;
            }
            if (!uris.add(source.uri)) {
                diagnostic(result, source, 0, 0, "Duplicate source URI", false);
                continue;
            }
            Unit unit = new Unit(source, build ? stem(source.uri, i) : null, build);
            try {
                if ("sic".equals(mode)) compileSic(unit, result, i, build);
                else compileXe(unit, result, i, build);
                units.add(unit);
            } catch (RuntimeException | StackOverflowError e) {
                diagnostic(result, source, 0, 1, "Cannot assemble: " + message(e), false);
            }
        }
        for (Unit unit : units) {
            result.rows.addAll(unit.rows);
            result.symbols.addAll(unit.symbols);
        }
        if (hasErrors(result)) return result;
        if (!build) { result.success = true; return result; }
        try {
            boolean link = "sicxe".equals(mode) && (units.size() > 1 || units.get(0).sectionStarts.size() > 1 || units.get(0).external);
            if (link) {
                link(units, mainSection, result);
                if (hasErrors(result)) return result;
            }
            else {
                Unit main = units.get(0);
                if (mainSection != null && !mainSection.isBlank()) {
                    main = units.stream().filter(u -> u.name.equals(mainSection)).findFirst()
                            .orElseThrow(() -> new IllegalArgumentException("Unknown main program: " + mainSection));
                }
                result.entry = main.entry;
                // SIC inputs keep their absolute START placement, including reserved storage.
                for (int i = 0; i < units.size(); i++) {
                    Unit a = units.get(i);
                    int start = a.sectionStarts.get(a.name), end = start + a.sectionSizes.get(a.name);
                    for (int j = 0; j < i; j++) {
                        Unit b = units.get(j);
                        int other = b.sectionStarts.get(b.name), otherEnd = other + b.sectionSizes.get(b.name);
                        if (start < end && other < otherEnd && start < otherEnd && other < end)
                            throw new IllegalArgumentException("Overlapping programs: " + b.name + " and " + a.name);
                    }
                    for (Row row : a.rows)
                        if (!row.bytes.isEmpty()) result.segments.add(new Segment(row.address, row.bytes));
                }
            }
            validateSegments(result.segments, limit);
            if (result.entry < 0 || result.entry >= limit)
                throw new IllegalArgumentException("Entry address outside machine memory");
            for (Unit unit : units) {
                result.artifacts.add(new Artifact(unit.stem + ".obj", unit.object));
                result.artifacts.add(new Artifact(unit.stem + ".lst", listing(unit)));
                result.artifacts.add(new Artifact(unit.stem + ".log", unit.log));
            }
            result.success = true;
        } catch (Exception | sicxe.link.LinkerError e) {
            diagnostic(result, units.isEmpty() ? fallback : units.get(0).source, 0, 1, message(e), false);
            result.segments.clear();
            result.artifacts.clear();
            result.entry = 0;
        }
        return result;
    }

    private static void compileSic(Unit unit, Result result, int index, boolean build) {
        sic.asm.Assembler assembler = new sic.asm.Assembler();
        sic.ast.Program program = assembler.assemble(unit.source.text);
        unit.name = program.name() == null ? String.format("P%05d", index + 1) : program.name();
        program.setName(unit.name);
        unit.entry = program.first();
        for (sic.asm.AsmError error : assembler.errorCatcher.errs)
            diagnostic(result, unit.source, error.loc == null ? 0 : error.loc.pos, error.length, error.getMessage(), !error.isBreaking());
        if (assembler.errorCatcher.shouldEnd()) return;
        unit.sectionStarts.put(unit.name, program.start());
        unit.sectionSizes.put(unit.name, program.sections.get(0).size());
        var errorsBeforeRows = List.copyOf(assembler.errorCatcher.errs);
        new SicRows(program, assembler.errorCatcher, unit, result).visitByStructure();
        assembler.errorCatcher.errs.sort(null);
        for (sic.asm.AsmError error : assembler.errorCatcher.errs) {
            if (errorsBeforeRows.contains(error)) continue;
            diagnostic(result, unit.source, error.loc == null ? 0 : error.loc.pos, error.length, error.getMessage(), !error.isBreaking());
        }
        if (build) for (sic.ast.Symbol symbol : program.sections.get(0).symbols.asSortedList()) {
            Symbol value = symbol(unit, symbol.name, symbol.loc == null ? 0 : symbol.loc.pos,
                    symbol.value(), unit.name, false);
            if (symbol instanceof sic.ast.StorageSymbol storage) {
                value.type = storage.getDataType().name();
                value.elementSize = storage.getElementSize(); value.count = storage.getElementCount();
                value.size = value.elementSize * value.count;
            }
            if (!symbol.name.startsWith("*")) unit.symbols.add(value);
        }
        if (build && !hasErrors(result)) {
            StringWriter object = new StringWriter(), log = new StringWriter();
            assembler.generateObj(program, object, false); assembler.generateLog(program, log);
            unit.object = object.toString(); unit.log = log.toString();
        }
    }

    private static void compileXe(Unit unit, Result result, int index, boolean build) {
        sicxe.asm.Assembler assembler = new sicxe.asm.Assembler();
        sicxe.ast.Program program = assembler.assemble(unit.source.text);
        unit.name = program.name() == null ? String.format("P%05d", index + 1) : program.name();
        program.setName(unit.name);
        unit.entry = program.first();
        for (sicxe.asm.AsmError error : assembler.errorCatcher.errs)
            diagnostic(result, unit.source, error.loc == null ? 0 : error.loc.pos, error.length, error.getMessage(), !error.isBreaking());
        if (assembler.errorCatcher.shouldEnd()) return;
        for (sicxe.ast.Section section : program.sections) {
            String name = section.isDefault() ? unit.name : section.name;
            if (unit.sectionStarts.putIfAbsent(name, section.isDefault() ? program.start() : 0) != null)
                diagnostic(result, unit.source, 0, 1, "Duplicate control section: " + name, false);
            unit.sectionSizes.put(name, section.size());
            if (build) for (sicxe.ast.Symbol symbol : section.symbols.asSortedList()) {
                if (symbol.isImported()) { unit.external = true; continue; }
                Symbol value = symbol(unit, symbol.name, symbol.loc == null ? 0 : symbol.loc.pos,
                        symbol.value(), name, symbol.isAbsolute());
                if (symbol instanceof sicxe.ast.StorageSymbol storage) {
                    value.type = storage.getDataType().name();
                    value.elementSize = storage.getElementSize(); value.count = storage.getElementCount();
                    value.size = value.elementSize * value.count;
                }
                if (!symbol.name.startsWith("*")) unit.symbols.add(value);
            }
        }
        var errorsBeforeRows = List.copyOf(assembler.errorCatcher.errs);
        new XeRows(program, assembler.errorCatcher, unit, result).visitByStructure();
        assembler.errorCatcher.errs.sort(null);
        for (sicxe.asm.AsmError error : assembler.errorCatcher.errs) {
            if (errorsBeforeRows.contains(error)) continue;
            diagnostic(result, unit.source, error.loc == null ? 0 : error.loc.pos, error.length, error.getMessage(), !error.isBreaking());
        }
        if (build && !hasErrors(result)) {
            StringWriter object = new StringWriter(), log = new StringWriter();
            assembler.generateObj(program, object, false); assembler.generateLog(program, log);
            unit.object = object.toString(); unit.log = log.toString();
        }
    }

    /** Public visitor class allows the inherited reflective dispatcher to invoke its methods. */
    public static final class SicRows extends sic.asm.visitors.Visitor {
        private final Unit unit;
        private final Result result;
        SicRows(sic.ast.Program program, sic.asm.ErrorCatcher errors, Unit unit, Result result) {
            super(program, errors); this.unit = unit; this.result = result;
        }
        public void visit(sic.ast.Program value) { visitSections(value.sections); }
        public void visit(sic.ast.Section value) { visitBlocks(value.blocks); }
        public void visit(sic.ast.Block value) { visitCommands(value.commands); }
        public void visit(sic.ast.Command command) {
            if (command instanceof sic.ast.Comment) {
                if (unit.build) addRow(unit, command.loc.pos, command.loc.length, program.locctr(), 0, new byte[0], unit.name,
                        "", "", "", false, true);
                return;
            }
            int size = command.size(), address = program.locctr();
            if (!range(unit, result, command.loc.pos, address, size, 0x8000)) return;
            byte[] bytes = command instanceof sic.ast.storage.StorageRes ? new byte[0] : command.emitRawCode();
            if (unit.build) addRow(unit, command.loc.pos, command.loc.length, address, size, bytes, unit.name,
                    command.nameToString(), command.operandToString(), command.label(),
                    command instanceof sic.ast.instructions.Instruction, true);
        }
    }
    public static final class XeRows extends sicxe.asm.visitors.Visitor {
        private final Unit unit;
        private final Result result;
        XeRows(sicxe.ast.Program program, sicxe.asm.ErrorCatcher errors, Unit unit, Result result) {
            super(program, errors); this.unit = unit; this.result = result;
        }
        public void visit(sicxe.ast.Program value) { visitSections(value.sections); }
        public void visit(sicxe.ast.Section value) { visitBlocks(value.blocks); }
        public void visit(sicxe.ast.Block value) { visitCommands(value.commands); }
        public void visit(sicxe.ast.Command command) {
            if (command instanceof sicxe.ast.Comment) {
                if (unit.build) addRow(unit, command.loc.pos, command.loc.length, program.locctr(), 0, new byte[0],
                        program.section().isDefault() ? unit.name : program.section().name, "", "", "", false, false);
                return;
            }
            int size = command.size(), address = program.locctr();
            if (!range(unit, result, command.loc.pos, address, size, 0x100000)) return;
            byte[] bytes = command instanceof sicxe.ast.storage.StorageRes ? new byte[0] : command.emitRawCode();
            if (unit.build) {
                Row row = addRow(unit, command.loc.pos, command.loc.length, address, size, bytes,
                        program.section().isDefault() ? unit.name : program.section().name,
                        command.nameToString(), command.operandToString(), command.label(),
                        command instanceof sicxe.ast.instructions.Instruction, false);
                var instruction = command instanceof sicxe.ast.instructions.InstructionLiteral literal ? literal.command : command;
                if (instruction instanceof sicxe.ast.instructions.InstructionF3m format3) {
                    row.relocationAddressBits = format3.relocationAddressBits();
                    row.requiresFixedPlacement = format3.requiresFixedPlacement();
                } else if (instruction instanceof sicxe.ast.instructions.InstructionF4m format4)
                    row.format4Reference = format4.relocationSymbol(row.section);
            }
        }
    }

    private static Row addRow(Unit unit, int offset, int length, int address, int size, byte[] bytes,
                               String section, String instruction, String operand, String label, boolean executable, boolean sic) {
        Row row = new Row();
        offset = Math.min(Math.max(offset, 0), unit.source.text.length());
        row.line = unit.line(offset);
        int start = unit.lineStarts[row.line];
        int end = row.line + 1 < unit.lineStarts.length ? unit.lineStarts[row.line + 1] - 1 : unit.source.text.length();
        if (end > start && unit.source.text.charAt(end - 1) == '\r') end--;
        row.uri = unit.source.uri; row.column = offset - start;
        row.length = Math.max(0, Math.min(length < 1 ? end - offset : length, end - offset));
        row.source = unit.source.text.substring(start, end);
        row.address = address; row.size = size; row.bytes = HEX.formatHex(bytes);
        row.section = section; row.instruction = instruction; row.operand = operand; row.label = label;
        row.executable = executable; row.nixbpe = flags(row.bytes, executable, sic);
        unit.rows.add(row);
        return row;
    }

    private static Symbol symbol(Unit unit, String name, int offset, int address, String section, boolean absolute) {
        Symbol value = new Symbol();
        value.name = name; value.uri = unit.source.uri; value.line = unit.line(offset);
        value.address = address; value.section = section; value.type = absolute ? "ABSOLUTE" : "CODE";
        return value;
    }

    private static boolean range(Unit unit, Result result, int offset, int address, int size, int limit) {
        if (address < 0 || size < 0 || (long) address + size > limit || (size > 0 && address >= limit)) {
            diagnostic(result, unit.source, offset, 1, "Address or storage size outside machine memory", false);
            return false;
        }
        return true;
    }

    private static void link(List<Unit> units, String main, Result result) throws Exception, sicxe.link.LinkerError {
        sicxe.link.Options options = new sicxe.link.Options();
        options.setMain(main == null || main.isBlank() ? null : main);
        options.setOutputName("linked.obj");
        sicxe.link.section.Sections sections = new sicxe.link.section.Sections();
        for (Unit unit : units)
            sections.addSections(new sicxe.link.utils.Parser(unit.source.uri).parse(new StringReader(unit.object)));
        sicxe.link.Linker linker = new sicxe.link.Linker(sections, options);
        sicxe.link.section.Section output = linker.link();
        Map<String, Integer> bases = new HashMap<>();
        for (sicxe.asm.ujs.Relocations.ControlSectionInfo section : linker.relocations.getControlSections()) {
            if (section.start < 0 || section.start + section.length > 0x100000L)
                throw new IllegalArgumentException("Linked sections exceed machine memory");
            bases.put(section.name, Math.toIntExact(section.start));
        }
        // Validate instruction address fields, not general M-record arithmetic (e.g. WORD).
        for (Unit unit : units) for (Row row : unit.rows) {
            int base = bases.get(row.section);
            if (row.format4Reference != null) {
                long target = Long.parseLong(row.bytes.substring(3, 8), 16) + linker.symbolAddress(row.format4Reference);
                if (target < 0 || target > 0xFFFFF)
                    diagnostic(result, unit.source, unit.lineStarts[row.line] + row.column, row.length,
                            "Relocated address outside the 20-bit format-4 field", false);
            }
            boolean fixedSic = row.relocationAddressBits == 15 && base != 0;
            boolean fixedDisplacement = row.requiresFixedPlacement && base != 0;
            boolean overflow = row.relocationAddressBits == 12 && Integer.parseInt(row.bytes.substring(3, 6), 16) + base > 0xFFF;
            if (fixedDisplacement)
                diagnostic(result, unit.source, unit.lineStarts[row.line] + row.column, row.length,
                        "Cannot relocate this PC/base-relative displacement safely; use +" + row.instruction, false);
            else if (fixedSic || overflow)
                diagnostic(result, unit.source, unit.lineStarts[row.line] + row.column, row.length,
                        (fixedSic ? "Cannot relocate a SIC-format address" : "Relocated address exceeds the 12-bit instruction field") +
                        "; use +" + row.instruction + " or BASE", false);
        }
        if (hasErrors(result)) return;
        StringWriter object = new StringWriter();
        new sicxe.link.utils.Writer(output).write(object);
        result.artifacts.add(new Artifact("linked.obj", object.toString()));
        result.entry = Math.toIntExact(output.getERecord().getStartAddr());
        for (sicxe.link.section.TRecord record : output.getTRecords())
            result.segments.add(new Segment(Math.toIntExact(record.getStartAddr()), record.getText()));
        validateSegments(result.segments, 0x100000);
        for (Unit unit : units) {
            for (Row row : unit.rows) {
                row.address += bases.get(row.section);
                if (!row.bytes.isEmpty()) row.bytes = linkedBytes(result.segments, row.address, row.size);
                row.nixbpe = flags(row.bytes, row.executable, false);
            }
            for (Symbol symbol : unit.symbols)
                if (!"ABSOLUTE".equals(symbol.type)) symbol.address += bases.get(symbol.section);
        }
    }

    private static String linkedBytes(List<Segment> segments, int address, int count) {
        StringBuilder bytes = new StringBuilder(count * 2);
        int low = 0, high = segments.size();
        while (low < high) {
            int middle = (low + high) >>> 1;
            if (segments.get(middle).address <= address) low = middle + 1;
            else high = middle;
        }
        int index = low - 1;
        for (int current = address; current < address + count;) {
            Segment found = index >= 0 && index < segments.size() ? segments.get(index) : null;
            if (found == null || current < found.address || current >= found.address + found.bytes.length() / 2)
                throw new IllegalArgumentException("Linked bytes missing at " + current);
            int take = Math.min(address + count - current, found.address + found.bytes.length() / 2 - current);
            bytes.append(found.bytes, (current - found.address) * 2, (current - found.address + take) * 2);
            current += take;
            index++;
        }
        return bytes.toString();
    }

    private static void validateSegments(List<Segment> segments, int limit) {
        segments.sort(Comparator.comparingInt(s -> s.address));
        int end = 0;
        for (Segment segment : segments) {
            int count = segment.bytes.length() / 2;
            if (segment.address < 0 || (long) segment.address + count > limit || segment.address < end)
                throw new IllegalArgumentException("Loaded code overlaps or exceeds machine memory");
            HEX.parseHex(segment.bytes);
            end = segment.address + count;
        }
    }

    private static String flags(String bytes, boolean executable, boolean sic) {
        if (!executable || bytes.length() < 6) return "";
        int first = Integer.parseInt(bytes.substring(0, 2), 16), second = Integer.parseInt(bytes.substring(2, 4), 16);
        if (sic || (first & 3) == 0) return "00" + ((second >>> 7) & 1) + "---";
        return "" + ((first >>> 1) & 1) + (first & 1) + ((second >>> 7) & 1) + ((second >>> 6) & 1) + ((second >>> 5) & 1) + ((second >>> 4) & 1);
    }
    private static String stem(String uri, int index) {
        String name;
        try { name = URI.create(uri).getPath(); } catch (IllegalArgumentException e) { name = uri; }
        if (name == null) name = "source";
        name = name.substring(name.lastIndexOf('/') + 1).replaceFirst("\\.[^.]*$", "").replaceAll("[^a-zA-Z0-9_-]", "_");
        return String.format("%02d-%s", index + 1, name.isEmpty() ? "source" : name);
    }
    private static String listing(Unit unit) {
        StringBuilder text = new StringBuilder("Source: " + unit.source.uri + "\n");
        for (Row row : unit.rows)
            text.append(String.format("%05X  %-8s  %s\n", row.address, row.bytes, row.source));
        return text.toString();
    }
    private static boolean hasErrors(Result result) {
        return result.diagnostics.stream().anyMatch(diagnostic -> "error".equals(diagnostic.severity));
    }
    private static String message(Throwable error) {
        return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    }
    private static void diagnostic(Result result, Source source, int offset, int length, String message, boolean warning) {
        Diagnostic diagnostic = new Diagnostic();
        diagnostic.uri = source.uri; diagnostic.offset = Math.max(0, Math.min(offset, source.text.length()));
        diagnostic.length = Math.max(0, Math.min(Math.max(1, length), source.text.length() - diagnostic.offset));
        diagnostic.message = message; diagnostic.severity = warning ? "warning" : "error";
        if (result.diagnosticKeys.add(new DiagnosticKey(diagnostic.uri, diagnostic.offset, diagnostic.length,
                diagnostic.message, diagnostic.severity))) result.diagnostics.add(diagnostic);
    }
}
