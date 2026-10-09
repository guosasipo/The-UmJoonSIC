package sic.ast.data;

import sic.asm.AsmError;
import sic.asm.parsing.Parser;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class DataChr extends Data {

    public DataChr(int opcode) {
        super(opcode);
    }

    @Override
    public String toString() {
        StringBuilder buf = new StringBuilder(data.length + 3);
        buf.append("C'");
        buf.append(new String(data, java.nio.charset.StandardCharsets.UTF_8));
        buf.append('\'');
        return buf.toString();
    }

    @Override
    public void parse(Parser parser) throws AsmError {
        parser.advance('C');
        char quote = parser.advance();
        switch (quote) {
            case '\'':
                data = parser.readUntil('\'').getBytes(java.nio.charset.StandardCharsets.UTF_8);
                break;
            case '"':
                data = parser.readEscapedString('"').getBytes(java.nio.charset.StandardCharsets.UTF_8);
                break;
            default:
                throw new AsmError(parser.loc(), 1, "Expected quote");
        }
    }

}
