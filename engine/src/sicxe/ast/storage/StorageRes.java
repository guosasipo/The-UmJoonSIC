package sicxe.ast.storage;

import sicxe.asm.AsmError;
import sicxe.asm.Location;
import sicxe.ast.Program;
import sicxe.ast.expression.Expr;
import sicxe.common.Mnemonic;
import sicxe.common.Opcode;

import java.util.Arrays;

/**
 * Support for storage-reservation directives. This class supports both standard
 * directives: RESB (reserve bytes) and RESW (reserver words).
 * In addition, it also supports RESF (reserve floats).
 *
 * @author jure
 */
public class StorageRes extends Storage {
    public final Expr expr;  // expression
    private int count;  // value of expression

    public StorageRes(Location loc, String label, Location labelLoc,
                      Mnemonic mnemonic, Location mnemonicLoc,
                      Expr expr) {
        super(loc, label, labelLoc, mnemonic, mnemonicLoc);
        this.expr = expr;
    }

    @Override
    public String operandToString() {
        return expr.toString();
    }

    @Override
    public int size() {
        switch (mnemonic.opcode) {
            case Opcode.RESB: return count;
            case Opcode.RESW: return 3 * count;
            case Opcode.RESF: return 6 * count;
        }
        return 0;  // error
    }

    public void resolve(Program program) throws AsmError {
        count = expr.eval(program);
        int width = mnemonic.opcode == Opcode.RESF ? 6 : mnemonic.opcode == Opcode.RESW ? 3 : 1;
        if (count < 0 || (long) count * width > sicxe.common.SICXE.SIZE_MEM) {
            count = 0;
            throw new AsmError(expr.loc, Math.max(1, expr.toString().length()), "Reservation size out of range");
        }
    }

    @Override
    public void emitRawCode(byte[] data, int loc) {
        int s = size();
        if (s <= 0) return;
        // fill with zeros?
        Arrays.fill(data, loc, loc + size(), (byte)0);
    }

    @Override
    public boolean emitText(StringBuilder buf) {
        return true; // no text emitted, but indicate flush
    }

}
