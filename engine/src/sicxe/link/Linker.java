package sicxe.link;

import sicxe.link.visitors.SecondPassVisitor;
import sicxe.asm.ujs.Relocations;
import sicxe.link.section.ExtDef;
import sicxe.link.section.Section;
import sicxe.link.section.Sections;
import sicxe.link.visitors.FirstPassVisitor;

import java.util.HashMap;
import java.util.Map;

/**
 * main linker class
 * 'sections' contains the parsed object records to be linked
 * 'options' is a list of linker options
 * link() performs the linking and returns the resulting Section
 */
public class Linker {
    private static final String PHASE = "linker";

    private final Sections sections;
    private Options options;
    private Map<String, ExtDef> esTable = Map.of();
    public Relocations relocations;

    public Linker(Sections sections, Options options) {
        this.sections = sections;
        this.options = options;
    }

    public Section link() throws LinkerError {
        return passAndCombine(parse());
    }

    public Sections parse() throws LinkerError {
        if (sections.getSections().size() == 0)
            throw new LinkerError(PHASE, "No sections found in given input files.");

        if (options.getMain() != null) {
            try {
                sections.move(options.getMain(), 0);
            } catch (LinkerError le) {
                throw new LinkerError("options", "specified main section " + options.getMain() + " does not exist");
            }
        }

        // name the section from options
        if (options.getOutputName() != null) {
            String name = options.getOutputName().replace(".obj", "");
            if (name.length() > 6)
                name = name.substring(0, 6);
            sections.setName(name);
        }

        return sections;
    }

    public Section passAndCombine(Sections sections) throws LinkerError {

        if (sections.getSections().size() == 0)
            throw new LinkerError(PHASE, "No sections to link.");

        if (sections.getName() == null)
            sections.setName(sections.getSections().get(0).getName());

        // Shared by both passes and the facade's final instruction-range check.
        esTable = new HashMap<>();

        FirstPassVisitor firstPass = new FirstPassVisitor(esTable);
        firstPass.visit(sections);
        if (relocations == null) relocations = new Relocations();
        relocations.recordSections(sections.getSections());

        SecondPassVisitor secondPassVisitor =
                new SecondPassVisitor(sections.getName(), esTable);
        secondPassVisitor.visit(sections);

        sections.clean();
        return sections.combine();
    }

    public long symbolAddress(String name) throws LinkerError {
        ExtDef symbol = esTable.get(name);
        if (symbol == null) throw new LinkerError(PHASE, "Unknown linked symbol: " + name);
        return symbol.getCsAddress() + symbol.getAddress();
    }
}
