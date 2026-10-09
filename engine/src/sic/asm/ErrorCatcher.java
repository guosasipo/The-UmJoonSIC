package sic.asm;

import java.util.ArrayList;
import java.util.List;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class ErrorCatcher {

    public final List<AsmError> errs;


    public ErrorCatcher() {
        this.errs = new ArrayList<AsmError>();
    }

    public void clear() {
        errs.clear();
    }

    public void add(AsmError err) {
        errs.add(err);
    }

    public boolean shouldEnd() {
        return errs.stream().anyMatch(AsmError::isBreaking);
    }

}
