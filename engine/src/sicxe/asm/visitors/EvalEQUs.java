package sicxe.asm.visitors;

import sicxe.asm.AsmError;
import sicxe.asm.ErrorCatcher;
import sicxe.ast.Command;
import sicxe.ast.Program;
import sicxe.ast.directives.DirectiveEQU;

/**
 * Evaluate EQU (absolute or relative) expressions.
 * Use the algorithm from the book for forward reference resolution.
 *
 * @author jure
 */
public class EvalEQUs extends Visitor {

    public final boolean relative;

    public EvalEQUs(Program program, ErrorCatcher errorCatcher, boolean relative) {
        super(program, errorCatcher);
        this.relative = relative;
    }

    public void visit(Command c) throws AsmError {
        if (relative && c.hasLabel())
            program.section().symbols.notify(program, c.label());
    }

    public void visit(DirectiveEQU d) throws AsmError {
        program.section().symbols.update(program, d.label());
    }

}
