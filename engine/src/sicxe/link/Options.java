package sicxe.link;

/**
 * Options for the linker
 */
public class Options {
    private String outputName = null; // specifies the output file name
    private String main = null;       // first section - otherwise the first in the first input file is used

    public String getOutputName() {
        return outputName;
    }

    public void setOutputName(String outputName) {
        this.outputName = outputName;
    }

    public String getMain() {
        return main;
    }

    public void setMain(String main) {
        this.main = main;
    }

}
