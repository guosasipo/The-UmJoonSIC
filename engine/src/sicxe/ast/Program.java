package sicxe.ast;

import sicxe.asm.AsmError;

import java.util.ArrayList;
import java.util.List;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class Program extends Node {

    private String name;		        // commands name (max 6 chars)
    private int start;                  // code start address
    private int first;                  // the address of the first instruction (entry)

    public final List<Command> commands;    // list of commands

    public final List<Section> sections;    // list of sections, first section is the default section
    private Section section;                // current active section;

    public Program() {
        super();
        //setLine(1);  // programs starts at line 1
        commands = new ArrayList<Command>();
        sections = new ArrayList<Section>();
        switchSection("");            // default section
    }

    @Override
    public String toString() {
        return name;
    }

    // ************

    public String name() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public int start() {
        return start;
    }

    public void setStart(int addr) {
        this.start = addr;
        // automatically also set first instruction
        setFirst(addr);
    }

    public int first() {
        return first;
    }

    public void setFirst(int addr) {
        first = addr;
    }

    public Section section() {
        return section;
    }

    public Block block() {
        return section.block();
    }

    // ************ locctr tracking

    public int locctr() {
        return block().locctr();
    }

    public void step(int size) {
        block().step(size);
    }

    // ************ defining symbols: by label (locctr) and by expression

    public int maxSymbolLength() {
        int max = -1;
        for (Section section : sections) {
            int len = section.name.length() + section.symbols.maxLength() + 1;
            if (len > max) max = len;
        }
        return max;
    }

    // ************ literals

    public void flushAllLiterals() throws AsmError {
        String activeSection = section.name;
        String activeBlock = block().name;
        for (Section next : sections) {
            switchSection(next.name);
            next.literals.flush(this);
        }
        switchSection(activeSection);
        section.switchBlock(activeBlock);
    }

    // ************ switching sections and blocks

    public Section findSection(String name) {
        for (Section section : sections)
            if (section.name.equals(name)) return section;
        return null;
    }

    public void switchSection(String name) {
        section = findSection(name);
        if (section == null) {
            section = new Section(name);
            sections.add(section);
        }
    }

    public void switchDefault() {
        // switch to default section and block
        switchSection("");
        section.switchBlock("");
    }

    // ************ on parse

    public void append(Command command) throws AsmError {
        commands.add(command);         // add command to the program
        block().append(command);       // add command to the current block
    }

    @Override
    public void enter(Program program) {
        switchDefault();
    }

}
