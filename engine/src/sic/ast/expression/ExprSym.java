package sic.ast.expression;

import sic.asm.*;
import sic.ast.Program;
import sic.ast.Symbols;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class ExprSym extends Expr {

    public final String value;

    public ExprSym(Location loc, String value) {
        super(loc);
        this.value = value;
    }

    @Override
    public String toString() {
        return value;
    }

    @Override
    public int eval(Program program) throws AsmError {
        Symbols symbols = program.section().symbols;
        if (symbols.isDefined(value)) return symbols.get(value).value();
        throw new AsmError(loc, value.length(), "Undefined symbol '%s'", value);
    }

}
