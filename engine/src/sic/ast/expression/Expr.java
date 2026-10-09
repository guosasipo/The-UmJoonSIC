package sic.ast.expression;

import sic.asm.*;
import sic.ast.Program;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public abstract class Expr {

    public final Location loc;

    public Expr(Location loc) {
        this.loc = loc;
    }

    public abstract int eval(Program program) throws AsmError;
}
