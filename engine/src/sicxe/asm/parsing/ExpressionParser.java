package sicxe.asm.parsing;

import sicxe.asm.AsmError;
import sicxe.ast.expression.Expr;
import sicxe.ast.expression.ExprInt;
import sicxe.ast.expression.ExprOp;
import sicxe.ast.expression.ExprSym;
import sicxe.asm.Location;
import sicxe.common.SICXE;

/**
 * Support for parsing expressions.
 *
 * @author jure
 */
public class ExpressionParser {

    private final Parser parser;

    public ExpressionParser(Parser parser) {
        this.parser = parser;
    }

    private Expr readToken() throws AsmError {
        parser.skipWhitespace();
        Location loc = parser.loc();
        if (Character.isDigit(parser.peek()))
            return new ExprInt(loc, parser.readInt(0, SICXE.MAX_WORD));
        if (Character.isLetter(parser.peek()) || parser.peek() == '_')
            return new ExprSym(loc, parser.readSymbol());
        if (parser.advanceIf('+'))
            return new ExprOp("+", loc, 10);
        if (parser.advanceIf('-'))
            return new ExprOp("-", loc, 10);
        if (parser.advanceIf('*'))
            return new ExprOp("*", loc, 20);
        if (parser.advanceIf('/'))
            return new ExprOp("/", loc, 20);
        if (parser.advanceIf('%'))
            return new ExprOp("%", loc, 20);
        return null;  // end of expression
    }

    private Expr nextTok;

    public Expr parseExpression() throws AsmError {
        nextTok = readToken();
        if (nextTok == null) return null;
        Expr expression = parseExpression(0);
        if (nextTok != null)
            throw new AsmError(nextTok.loc, Math.max(1, parser.pos() - nextTok.loc.pos),
                    "Unexpected token '%s' after expression", parser.extract(nextTok.loc.pos));
        return expression;
    }

    public Expr parseExpression(int rightBP) throws AsmError {
        Expr tok = nextTok;
        if (tok == null) throw new AsmError(parser.loc(), 1, "Expression operand expected");
        nextTok = readToken();
        Expr left = tok.parse(this);
        while (nextTok != null && nextTok.leftBP > rightBP) {
            tok = nextTok;
            nextTok = readToken();
            left = tok.parseLeft(this, left);
        }
        return left;
    }

}
