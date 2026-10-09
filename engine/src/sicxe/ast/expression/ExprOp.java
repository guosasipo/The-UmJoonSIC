package sicxe.ast.expression;

import sicxe.asm.*;
import sicxe.asm.parsing.ExpressionParser;
import sicxe.ast.Program;

import java.util.Set;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class ExprOp extends Expr {

    private Expr left;
    private Expr right;

    public ExprOp(String name, Location loc, int leftBP) {
        super(name, loc, leftBP);
    }

    @Override
    public String toString() {
        return left + name + right;
    }

    @Override
    public Expr parse(ExpressionParser parser) throws AsmError {
        if ("*".equals(name)) {
            return new ExprStar(loc);
        }
        if ("+".equals(name)) {
            return parser.parseExpression(30);
        }
        if ("-".equals(name)) {
            this.left = new ExprInt(loc, 0);
            this.right = parser.parseExpression(30);
        }
        if (left == null || right == null)
            throw new AsmError(loc, name.length(), "Unexpected operator '%s'", name);
        return this;
    }

    @Override
    public Expr parseLeft(ExpressionParser parser, Expr left) throws AsmError {
        this.left = left;
        this.right = parser.parseExpression(leftBP);
        return this;
    }

    @Override
    public int relocationBalance(Program program) throws AsmError {
        int l = left.relocationBalance(program), r = right.relocationBalance(program);
        if ("+".equals(name)) return l + r;
        if ("-".equals(name)) return l - r;
        if (l != 0 || r != 0)
            throw new AsmError(loc, name.length(), "Relative operands cannot use '%s'", name);
        return 0;
    }

    @Override
    public void bindLocation(int address) {
        left.bindLocation(address);
        right.bindLocation(address);
    }

    @Override
    public Set<String> extractSyms() {
        Set<String> l = left.extractSyms();
        Set<String> r = right.extractSyms();
        if (l == null) return r;
        if (r == null) return l;
        l.addAll(r);
        return l;
    }

    @Override
    public boolean canEval(Program program) {
        return left.canEval(program) && right.canEval(program);
    }

    @Override
    public int eval(Program program) throws AsmError {
        int a = left.eval(program), b = right.eval(program);
        if (("/".equals(name) || "%".equals(name)) && b == 0)
            throw new AsmError(right.loc, Math.max(1, right.toString().length()), "Division by zero");
        try {
            return switch (name) {
                case "+" -> Math.addExact(a, b);
                case "-" -> Math.subtractExact(a, b);
                case "*" -> Math.multiplyExact(a, b);
                case "/" -> Math.toIntExact((long) a / b);
                case "%" -> a % b;
                default -> 0;
            };
        } catch (ArithmeticException overflow) {
            throw new AsmError(loc, name.length(), "Integer overflow in expression '%s'", name);
        }
    }

}
