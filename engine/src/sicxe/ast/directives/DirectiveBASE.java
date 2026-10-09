package sicxe.ast.directives;

import sicxe.asm.*;
import sicxe.ast.Program;
import sicxe.ast.expression.Expr;
import sicxe.common.Mnemonic;

/**
 * Directive BASE: enable base-relative addressing.
 *
 * @author jure
 */
public class DirectiveBASE extends DirectiveFe {
    private Integer relocationBalance;

    public DirectiveBASE(Location loc, String label, Location labelLoc,
                         Mnemonic mnemonic, Location mnemonicLoc,
                         Expr expr, Location exprLoc) {
        super(loc, label, labelLoc, mnemonic, mnemonicLoc, expr, exprLoc);
    }

    @Override
    public void enter(Program program) throws AsmError {
        super.enter(program);
        program.section().enableBaseAddressing(value, relocationBalance);
    }

    @Override
    public void resolve(Program program) throws AsmError {
        super.resolve(program);
        try {
            relocationBalance = expr.relocationBalance(program);
        } catch (AsmError nonlinear) {
            // Keep in-place BASE arithmetic; its displacement cannot safely move.
            relocationBalance = null;
        }
    }

}
