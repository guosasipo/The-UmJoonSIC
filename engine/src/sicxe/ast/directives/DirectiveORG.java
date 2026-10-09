package sicxe.ast.directives;

import sicxe.asm.AsmError;
import sicxe.asm.Location;
import sicxe.ast.Program;
import sicxe.ast.expression.Expr;
import sicxe.common.Mnemonic;
import sicxe.common.SICXE;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class DirectiveORG extends DirectiveFe {

    public DirectiveORG(Location loc, String label, Location labelLoc,
                        Mnemonic mnemonic, Location mnemonicLoc,
                        Expr expr, Location exprLoc) {
        super(loc, label, labelLoc, mnemonic, mnemonicLoc, expr, exprLoc);
    }

    @Override
    public void resolve(Program program) throws AsmError {
        super.resolve(program);
        // A zero-size directive may place the counter just past the final byte.
        if (expr != null && (value < 0 || value > SICXE.SIZE_MEM))
            throw new AsmError(locOf(EXPR), locOf(EXPR).length, "ORG address out of range");
    }

    @Override
    public void leave(Program program) throws AsmError {
        if (expr == null) program.block().restoreLocctr();
        else program.block().setOrigin(value);
    }

    @Override
    public boolean emitText(StringBuilder buf) {
        // flush text after ORG
        return true;
    }

}
