package sic.ast.data;

import sic.asm.AsmError;
import sic.asm.parsing.Parser;
import sic.common.Opcode;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public abstract class Data {

    public final int opcode;    // the opcode of the corresponding storage directive
    protected byte[] data;      // actual data bytes

    public Data(int opcode) {
        this.opcode = opcode;
    }

    public abstract void parse(Parser parser) throws AsmError;

    public boolean equals(Data that) {
        return opcode == that.opcode && java.util.Arrays.equals(data, that.data);
    }

    public int size() {
        switch (opcode) {
            case Opcode.BYTE:  return data.length;
            case Opcode.WORD:  return (data.length + 2) / 3 * 3;
        }
        return 0;
    }

    public void emit(byte[] data, int loc) {
        System.arraycopy(this.data, 0, data, loc, this.data.length);
    }

}
