package sic.ast.expression;

import sic.asm.*;
import sic.ast.Program;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class ExprInt extends Expr {

    public final int value;

    public ExprInt(Location loc, int value) {
        super(loc);
        this.value = value;
    }

    @Override
    public String toString() {
        return Integer.toString(value);
    }

    @Override
    public int eval(Program program) {
        return value;
    }

}
