package sicxe.ast.expression;

import sicxe.asm.AsmError;
import sicxe.asm.Location;
import sicxe.asm.parsing.ExpressionParser;
import sicxe.ast.Program;

import java.util.Set;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class ExprStar extends Expr {
    private Integer address;

    public ExprStar(Location loc) {
        super("*", loc, 0);
    }

    @Override
    public String toString() {
        return "*";
    }

    @Override
    public Expr parse(ExpressionParser parser) throws AsmError {
        return this;
    }

    @Override
    public int relocationBalance(Program program) {
        return 1;
    }

    @Override
    public void bindLocation(int address) {
        this.address = address;
    }

    @Override
    public Set<String> extractSyms() {
        return null;
    }

    @Override
    public boolean canEval(Program program) {
        return address != null;
    }

    @Override
    public int eval(Program program) {
        return address == null ? program.locctr() : address;
    }

}
