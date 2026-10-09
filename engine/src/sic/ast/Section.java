package sic.ast;

import sic.asm.AsmError;

import java.util.ArrayList;
import java.util.List;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class Section extends Node {

    public final String name;                   // name of the section
    public final List<Block> blocks;            // list of blocks
    public final Symbols symbols;               // symbol table
    public final Literals literals;             // literals
    private int size;

    private Block block;                        // current active block

    public Section(String name) {
        super();
        this.name = name;
        blocks = new ArrayList<Block>();
        symbols = new Symbols();
        literals = new Literals();
        reset();
    }

    @Override
    public String toString() {
        return name();
    }

    public boolean isDefault() {
        return "".equals(name);
    }

    public String name() {
        return isDefault() ? "<default>" : name;
    }

    @Override
    public void enter(Program program) throws AsmError {
        program.switchSection(name);
        program.section().switchBlock("");
    }

    public void setSize(int size) {
        this.size = size;
    }

    public int size() {
        return size;
    }

    public void reset() {
        switchBlock("");
    }

    // blocks

    public Block block() {
        return block;
    }

    public Block findBlock(String name) {
        for (Block block : blocks)
            if (block.name.equals(name)) return block;
        return null;
    }

    public void switchBlock(String name) {
        block = findBlock(name);
        if (block == null) {
            block = new Block(name);
            blocks.add(block);
        }
    }

}
