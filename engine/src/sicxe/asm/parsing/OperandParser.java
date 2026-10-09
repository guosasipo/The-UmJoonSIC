package sicxe.asm.parsing;

import sicxe.asm.AsmError;
import sicxe.asm.Location;
import sicxe.ast.Command;
import sicxe.ast.data.*;
import sicxe.ast.directives.*;
import sicxe.ast.expression.Expr;
import sicxe.ast.instructions.*;
import sicxe.ast.storage.StorageData;
import sicxe.ast.storage.StorageRes;
import sicxe.common.Flags;
import sicxe.common.Mnemonic;
import sicxe.common.Opcode;

import java.util.ArrayList;
import java.util.List;

/**
 * Support for parsing of instruction operands.
 *
 * @author jure
 */
public class OperandParser {

    private final Parser parser;

    public OperandParser(Parser parser) {
        this.parser = parser;
    }

    // helpers

    private void checkWhitespace(String name) throws AsmError {
        parser.checkWhitespace("Missing whitespace after mnemonic '%s'", name);
    }

    // Helper tuple to return names + locations together
    private static final class Symbols {
        final List<String> names;
        final List<Location> locs;
        Symbols(List<String> names, List<Location> locs) {
            this.names = names;
            this.locs = locs;
        }
    }

    private Symbols parseSymbols(int maxLength) throws AsmError {
        List<String> names = new ArrayList<>();
        List<Location> locs = new ArrayList<>();

        do {
            Location startLoc = parser.loc();
            String sym = parser.readSymbol();
            Location postLoc = parser.loc();

            if (sym.length() > maxLength) {
                throw new AsmError(startLoc, sym.length(), "Symbol name '%s' too long", sym);
            }

            int len = postLoc.row == startLoc.row
                    ? Math.max(1, postLoc.pos - startLoc.pos)
                    : Math.max(1, sym.length());

            startLoc.length = len;

            names.add(sym);
            locs.add(startLoc);

        } while (parser.skipIfComma());

        return new Symbols(names, locs);
    }

    private Expr parseExpression(boolean throwIfNull) throws AsmError {
        Expr expr = parser.expressionParser.parseExpression();
        if (throwIfNull && expr == null)
            throw new AsmError(parser.loc(), 1, "Expression expected '%c'", parser.peek());
        return expr;
    }

    public Data parseData(int opcode) throws AsmError {
        Data data;
        switch (parser.peek()) {
            case 'C': data = new DataChr(opcode); break;
            case 'X': data = new DataHex(opcode); break;
            case 'F': data = new DataFloat(opcode); break;
            default: data = new DataNum(opcode); break;
        }
        data.parse(parser);
        return data;
    }

    private Mnemonic parseLiteralSpec() {
        Mnemonic mnm;
        // WORD, FLOaT, or BYTE (default) literal
        if (parser.advanceIf("BYTE") || parser.advanceIf('B'))
            mnm = parser.mnemonics.get("BYTE");
        else if (parser.advanceIf("FLOT") || parser.peek() == 'F')
            mnm = parser.mnemonics.get("FLOT");
        else {
            mnm = parser.mnemonics.get("WORD");
            parser.advanceIf("WORD"); // WORD is default
            parser.advanceIf('W');
        }
        return mnm;
    }

    private StorageData parseLiteralData() throws AsmError {
        Location loc = parser.loc();

        Location mnemonicStart = parser.loc();
        Mnemonic mnm = parseLiteralSpec();
        Location mnemonicEnd = parser.loc();
        mnemonicStart.length = Math.max(1, mnemonicEnd.pos - mnemonicStart.pos);
        Location mnemonicLoc = mnemonicStart;

        parser.skipWhitespace();

        Data data = parseData(mnm.opcode);

        String lbl = parser.program.section().literals.makeUniqLabel();
        Location labelLoc = null;

        return new StorageData(loc, lbl, labelLoc,
                mnm, mnemonicLoc,
                data, true);
    }

    // operand parsing

    private Command parseF1(Location loc, String label, Location labelLoc,
                            Mnemonic mnemonic, Location mnemonicLoc) {
        return new InstructionF1(loc, label, labelLoc, mnemonic, mnemonicLoc);
    }

    private Command parseF2n(Location loc, String label, Location labelLoc,
                             Mnemonic mnemonic, Location mnemonicLoc) throws AsmError {
        int n = parser.readInt(0, 15);
        return new InstructionF2n(loc, label, labelLoc, mnemonic, mnemonicLoc, n);
    }

    private Command parseF2r(Location loc, String label, Location labelLoc,
                             Mnemonic mnemonic, Location mnemonicLoc) throws AsmError {
        int r = parser.readRegister();
        return new InstructionF2r(loc, label, labelLoc, mnemonic, mnemonicLoc, r);
    }

    private Command parseF2rn(Location loc, String label, Location labelLoc,
                              Mnemonic mnemonic, Location mnemonicLoc) throws AsmError {
        int r = parser.readRegister();

        parser.skipComma();

        int n = parser.readInt(1, 16);

        return new InstructionF2rn(loc, label, labelLoc, mnemonic, mnemonicLoc, r, n);
    }

    private Command parseF2rr(Location loc, String label, Location labelLoc,
                              Mnemonic mnemonic, Location mnemonicLoc) throws AsmError {
        int r1 = parser.readRegister();

        parser.skipComma();

        int r2 = parser.readRegister();

        return new InstructionF2rr(loc, label, labelLoc, mnemonic, mnemonicLoc, r1, r2);
    }

    private Command parseF3(Location loc, String label, Location labelLoc, Mnemonic mnemonic, Location mnemonicLoc) throws AsmError {
        return new InstructionF3(loc, label, labelLoc, mnemonic, mnemonicLoc);
    }

    private Command parseF3m(Location loc, String label, Location labelLoc, Mnemonic mnemonic, Location mnemonicLoc) throws AsmError {
        checkWhitespace(mnemonic.name);
        Flags flags = new Flags();
        int operand;
        String symbol;
        // check if literal
        if (parser.advanceIf('=')) {
            InstructionF34Base cmd = new InstructionF3m(loc, label, labelLoc, mnemonic, mnemonicLoc, new Flags(Flags.SIMPLE, Flags.NONE), 0, null, null);
            StorageData lit = parseLiteralData();
            return new InstructionLiteral(cmd, lit);
        }

        Location symbolLoc = null;
        Location operandLoc = parser.loc();
        // otherwise no literal: detect TA use
        if (parser.advanceIf('#')) flags.set_ni(Flags.IMMEDIATE);
        else if (parser.advanceIf('@')) flags.set_ni(Flags.INDIRECT);
        else flags.set_ni(Flags.SIMPLE);
        // read operand: number, symbol, '*'
        if (Character.isDigit(parser.peek()) || parser.peek() == '-') {
            operand = parser.readInt(flags.minOperand(), flags.maxOperand());
            symbol = null;
        } else if (Character.isLetter(parser.peek()) || parser.peek() == '_') {
            operand = 0;
            symbolLoc = parser.loc();
            symbol = parser.readSymbol();
        } else if (parser.peek() == '*') {
            operand = 0;
            symbolLoc = parser.loc();
            symbol = "*";
        } else
            throw new AsmError(parser.loc(), 1, "Invalid character '%c", parser.peek());
        // check for indexed addressing (only if simple)
        if (parser.skipIfIndexed()) {
            if (flags.isSimple())
                flags.setIndexed();
            else
                throw new AsmError(operandLoc, Math.max(1,parser.loc().pos - operandLoc.pos), "Indexed addressing not supported here");
        }
        return new InstructionF3m(loc, label, labelLoc, mnemonic, mnemonicLoc, flags, operand, symbol, symbolLoc);
    }

    private Command parseF4m(Location loc, String label, Location labelLoc, Mnemonic mnemonic, Location mnemonicLoc) throws AsmError {
        checkWhitespace(mnemonic.name);
        Flags flags = new Flags();
        flags.setExtended();
        int operand;
        String symbol;
        // check if literal
        if (parser.advanceIf('=')) {
            InstructionF34Base cmd = new InstructionF4m(loc, label, labelLoc, mnemonic, mnemonicLoc, new Flags(Flags.SIMPLE, Flags.NONE), 0, null, null);
            StorageData lit = parseLiteralData();
            return new InstructionLiteral(cmd, lit);
        }

        Location symbolLoc = null;
        Location operandLoc = parser.loc();

        // otherwise no literal: detect TA use
        if (parser.advanceIf('#')) flags.set_ni(Flags.IMMEDIATE);
        else if (parser.advanceIf('@')) flags.set_ni(Flags.INDIRECT);
        else flags.set_ni(Flags.SIMPLE);
        // read operand: number, symbol, '*'
        if (Character.isDigit(parser.peek()) || parser.peek() == '-') {
            operand = parser.readInt(flags.minOperand(), flags.maxOperand());
            symbol = null;
        } else if (Character.isLetter(parser.peek()) || parser.peek() == '_') {
            operand = 0;
            symbolLoc = parser.loc();
            symbol = parser.readSymbol();
        } else if (parser.peek() == '*') {
            operand = 0;
            symbolLoc = parser.loc();
            symbol = "*";
        } else
            throw new AsmError(parser.loc(), 1, "Invalid character '%c", parser.peek());
        // check for indexed addressing (only if simple)
        if (parser.skipIfIndexed()) {
            if (flags.isSimple())
                flags.setIndexed();
            else
                throw new AsmError(operandLoc, Math.max(1, parser.loc().pos - operandLoc.pos), "Indexed addressing not supported here");
        }
        return new InstructionF4m(loc, label, labelLoc, mnemonic, mnemonicLoc, flags, operand, symbol, symbolLoc);
    }

    private Command parseD(Location loc, String label, Location labelLoc, Mnemonic mnemonic, Location mnemonicLoc) throws AsmError {
        switch (mnemonic.opcode) {
            case Opcode.CSECT:  return new DirectiveCSECT(loc, label, labelLoc, mnemonic, mnemonicLoc);
            case Opcode.LTORG:  return new DirectiveLTORG(loc, label, labelLoc, mnemonic, mnemonicLoc);
            case Opcode.NOBASE: return new DirectiveNOBASE(loc, label, labelLoc, mnemonic, mnemonicLoc);
        }
        return null;
    }

    private Command parseDe(Location loc, String label, Location labelLoc, Mnemonic mnemonic, Location mnemonicLoc) throws AsmError {
        Location exprLoc = parser.loc();
        Expr expr = parseExpression(true);
        exprLoc.length = Math.max(1, parser.pos() - exprLoc.pos);
        switch (mnemonic.opcode) {
            case Opcode.BASE:  return new DirectiveBASE(loc, label, labelLoc, mnemonic, mnemonicLoc, expr, exprLoc);
            case Opcode.START: return new DirectiveSTART(loc, label, labelLoc, mnemonic, mnemonicLoc, expr, exprLoc);
            case Opcode.END:   return new DirectiveEND(loc, label, labelLoc, mnemonic, mnemonicLoc, expr, exprLoc);
            case Opcode.EQU:   return new DirectiveEQU(loc, label, labelLoc, mnemonic, mnemonicLoc, expr, exprLoc);
        }
        return null;
    }

    private Command parseDe0(Location loc, String label, Location labelLoc, Mnemonic mnemonic, Location mnemonicLoc) throws AsmError {
        Location exprLoc = parser.loc();
        Expr expr = parseExpression(false);  // expr may be null
        exprLoc.length = Math.max(1, parser.pos() - exprLoc.pos);
        return new DirectiveORG(loc, label, labelLoc, mnemonic, mnemonicLoc, expr, exprLoc);
    }

    private Command parseDs0(Location loc, String label, Location labelLoc, Mnemonic mnemonic, Location mnemonicLoc) throws AsmError {
        String blockName = parser.readIfSymbol();
        return new DirectiveUSE(loc, label, labelLoc, mnemonic, mnemonicLoc, blockName);
    }

    private Command parseDs_(Location loc,
                             String label, Location labelLoc,
                             Mnemonic mnemonic, Location mnemonicLoc) throws AsmError {
        Symbols s = parseSymbols(6);
        switch (mnemonic.opcode) {
            case Opcode.EXTDEF:
                return new DirectiveEXTDEF(loc, label, labelLoc, mnemonic, mnemonicLoc, s.names, s.locs);
            case Opcode.EXTREF:
                return new DirectiveEXTREF(loc, label, labelLoc, mnemonic, mnemonicLoc, s.names, s.locs);
            default:
                return null;
        }
    }

    private Command parseSe(Location loc, String label, Location labelLoc, Mnemonic mnemonic, Location mnemonicLoc) throws AsmError {
        Expr expr = parseExpression(true);
        return new StorageRes(loc, label, labelLoc, mnemonic, mnemonicLoc, expr);
    }

    private Command parseSd(Location loc,
                            String label, Location labelLoc,
                            Mnemonic mnemonic, Location mnemonicLoc) throws AsmError {
        Data data = parseData(mnemonic.opcode);
        return new StorageData(loc, label, labelLoc, mnemonic, mnemonicLoc, data, false);
    }

    // cover all formats

    public Command parse(Location loc, String label, Location labelLocation,
                         Mnemonic mnemonic, Location mnemonicLocation) throws AsmError {
        switch (mnemonic.format) {
            case F1:    return parseF1(loc, label, labelLocation, mnemonic, mnemonicLocation);
            case F2n:   return parseF2n(loc, label, labelLocation, mnemonic, mnemonicLocation);
            case F2r:   return parseF2r(loc, label, labelLocation, mnemonic, mnemonicLocation);
            case F2rn:  return parseF2rn(loc, label, labelLocation, mnemonic, mnemonicLocation);
            case F2rr:  return parseF2rr(loc, label, labelLocation, mnemonic, mnemonicLocation);
            case F3:    return parseF3(loc, label, labelLocation, mnemonic, mnemonicLocation);
            case F3m:   return parseF3m(loc, label, labelLocation, mnemonic, mnemonicLocation);
            case F4m:   return parseF4m(loc, label, labelLocation, mnemonic, mnemonicLocation);
            case D:     return parseD(loc, label, labelLocation, mnemonic, mnemonicLocation);
            case De:    return parseDe(loc, label, labelLocation, mnemonic, mnemonicLocation);
            case De0:   return parseDe0(loc, label, labelLocation, mnemonic, mnemonicLocation);
            case Ds0:    return parseDs0(loc, label, labelLocation, mnemonic, mnemonicLocation);
            case Ds_:   return parseDs_(loc, label, labelLocation, mnemonic, mnemonicLocation);
            case Se:    return parseSe(loc, label, labelLocation, mnemonic, mnemonicLocation);
            case Sd:    return parseSd(loc, label, labelLocation, mnemonic, mnemonicLocation);
        }
        return null;
    }

}
