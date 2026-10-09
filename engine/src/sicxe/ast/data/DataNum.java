package sicxe.ast.data;

import sicxe.asm.AsmError;
import sicxe.asm.parsing.Parser;
import sicxe.common.Opcode;
import sicxe.common.SICXE;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class DataNum extends Data {

    private int numint;
    private double numfloat;

    public DataNum(int opcode) {
        super(opcode);
    }

    @Override
    public String toString() {
        switch (opcode) {
            case Opcode.BYTE:
            case Opcode.WORD: return Integer.toString(numint);
            case Opcode.FLOT: return Double.toString(numfloat);
        }
        return "";
    }

    @Override
    public void parse(Parser parser) throws AsmError {
        switch (opcode) {
            case Opcode.BYTE:
                numint = parser.readInt(SICXE.MIN_SBYTE, SICXE.MAX_BYTE);
                data = SICXE.intToDataByte(numint);
                break;
            case Opcode.WORD:
                numint = parser.readInt(SICXE.MIN_SWORD, SICXE.MAX_WORD);
                data = SICXE.intToDataWord(numint);
                break;
            case Opcode.FLOT:
                numfloat = parser.readFloat();
                data = SICXE.doubleToDataFloat(numfloat);
                break;
        }
    }

}
