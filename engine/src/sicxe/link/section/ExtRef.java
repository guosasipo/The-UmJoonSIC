package sicxe.link.section;

import sicxe.link.LinkerError;
import sicxe.link.visitors.SectionVisitor;

/**
 * External reference
 */
public class ExtRef {
    private String name;

    public ExtRef(String name) {
        this.name = name;
    }

    public String getName() {
        return name;
    }

    @Override
    public String toString() {
        return "ExtRef{" +
                "name='" + name + '\'' +
                '}';
    }

    public void accept(SectionVisitor visitor) throws LinkerError {
        visitor.visit(this);
    }
}
