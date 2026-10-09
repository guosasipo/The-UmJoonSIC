package sic.ast.data;

import sic.asm.AsmError;
import sic.asm.parsing.Parser;
import sic.common.SICXE;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class DataNum extends Data {

    private int numint;

    public DataNum(int opcode) {
        super(opcode);
    }

    @Override
    public String toString() {
        return Integer.toString(numint);
    }

    @Override
    public void parse(Parser parser) throws AsmError {
        numint = parser.readInt(SICXE.MIN_SWORD, SICXE.MAX_WORD);
        data = SICXE.intToDataWord(numint);
    }

}
