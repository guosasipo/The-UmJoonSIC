package sic.ast.data;

import sic.asm.AsmError;
import sic.asm.Location;
import sic.asm.parsing.Parser;
import sic.common.Conversion;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class DataHex extends Data {

    public DataHex(int opcode) {
        super(opcode);
    }

    @Override
    public String toString() {
        StringBuilder buf = new StringBuilder(data.length + 3);
        buf.append("X'");
        buf.append(Conversion.bytesToHex(data, 0, data.length));
        buf.append('\'');
        return buf.toString();
    }

    @Override
    public void parse(Parser parser) throws AsmError {
        parser.advance('X');
        parser.advance('\'');
        Location prevLoc = parser.loc();
        String str = parser.readUntil('\'');
        if (str.length() % 2 == 1)
            throw new AsmError(prevLoc, str.length(), "Invalid length of hex encoding '%s'", str);
        try {
            data = Conversion.hexToBytes(str);
        } catch (IllegalArgumentException e) {
            throw new AsmError(prevLoc, Math.max(1, str.length()), "Invalid hexadecimal byte string");
        }
    }

}
