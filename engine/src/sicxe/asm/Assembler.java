package sicxe.asm;

import sicxe.asm.parsing.Parser;
import sicxe.asm.visitors.*;
import sicxe.ast.Program;
import sicxe.common.Mnemonics;

import java.io.Writer;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class Assembler {

    public final ErrorCatcher errorCatcher;
    public final Mnemonics mnemonics;
    public final Parser parser;

    public Assembler() {
        this.errorCatcher = new ErrorCatcher();
        this.mnemonics = new Mnemonics();
        this.parser = new Parser(mnemonics, errorCatcher);
    }

    public Program assemble(String input) {
        errorCatcher.clear();

        // phase zero: parse the source code
        parser.begin(input);
        Program program = parser.parseProgram();

        // phase one: absolute expressions
        new DefineEQUs(program, errorCatcher).visitCommands();             // define EQUs
        new EvalEQUs(program, errorCatcher, false).visitCommands();        // EQUs: resolve absolute expressions
        new ResolveAbsolute(program, errorCatcher).visitCommands();        // resolve START and RESx

        // phase two: relative expressions
        new ResolveBlocks(program, errorCatcher).visitByStructure();       // define labels, resolve block sizes, resolve ORGs
        new EvalEQUs(program, errorCatcher, true).visitCommands();         // resolve also relative EQUs
        new ResolveRelative(program, errorCatcher).visitCommands();        // resolve BASE and import/export
        new ResolveSymbols(program, errorCatcher).visitCommands();         // resolve instructions
        for (sicxe.ast.Section section : program.sections)
            for (sicxe.ast.Symbol symbol : section.symbols.asSortedList())
                if (!symbol.isImported() && !symbol.isEvaluated())
                    errorCatcher.add(new AsmError(symbol.loc, symbol.name.length(),
                            "Unresolved or cyclic expression for '%s'", symbol.name));

        errorCatcher.errs.sort(null);
        return program;
    }

    public void generateLog(Program program, Writer writer) {
        new WriteSections(program, errorCatcher, writer).visitByStructure();
        errorCatcher.errs.sort(null);
    }

    public void generateObj(Program program, Writer writer, boolean addSpaceInObj) {
        new WriteText(program, errorCatcher, writer, addSpaceInObj).visitByStructure();
        errorCatcher.errs.sort(null);
    }

}
