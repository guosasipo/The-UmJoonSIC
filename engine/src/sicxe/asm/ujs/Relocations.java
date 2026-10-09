package sicxe.asm.ujs;

import sicxe.link.section.Section;

import java.util.ArrayList;
import java.util.List;

/** Section placements consumed by the compiler facade after linking. */
public class Relocations {
    private final List<ControlSectionInfo> controlSections = new ArrayList<>();

    public static class ControlSectionInfo {
        public final String name;
        public final long start;
        public final long length;

        public ControlSectionInfo(String name, long start, long length) {
            this.name = name;
            this.start = start;
            this.length = length;
        }

        @Override
        public String toString() {
            return String.format("%6s | 0x%06X | 0x%06X", name, start, length);
        }
    }

    public void recordSections(List<Section> sections) {
        for (Section section : sections)
            controlSections.add(new ControlSectionInfo(section.getName(), section.getStart(), section.getLength()));
    }

    public List<ControlSectionInfo> getControlSections() {
        return controlSections;
    }
}
