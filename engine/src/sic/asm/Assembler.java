package sic.asm;

import sic.asm.parsing.Parser;
import sic.asm.visitors.*;
import sic.ast.Program;
import sic.common.Mnemonics;

import java.io.Writer;

/**
 * Pure SIC assembler pipeline.
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

        // phase one: resolve START and simple storage sizes (RESB/RESW)
        new ResolveAbsolute(program, errorCatcher).visitCommands();

        // phase two: define labels, block sizes; resolve instructions
        new ResolveBlocks(program, errorCatcher).visitByStructure();
        new ResolveSymbols(program, errorCatcher).visitCommands();

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
