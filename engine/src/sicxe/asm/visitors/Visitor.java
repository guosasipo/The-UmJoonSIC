package sicxe.asm.visitors;

import sicxe.asm.AsmError;
import sicxe.asm.ErrorCatcher;
import sicxe.ast.*;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.List;
import java.util.HashMap;
import java.util.Map;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class Visitor {

    public final Program program;
    public final ErrorCatcher errorCatcher;

    public Visitor(Program program, ErrorCatcher errorCatcher) {
        this.program = program;
        this.errorCatcher = errorCatcher;
        begin();
    }

    protected void begin() {
        program.switchDefault();
        for (Section section : program.sections) {
            section.reset();
            for (Block block : section.blocks)
                block.reset();
        }
    }

    private final Map<Class<?>, Method> visitMethods = new HashMap<>();

    protected Method findVisitMethod(Node node) {
        Class<?> originalClass = node.getClass();
        if (visitMethods.containsKey(originalClass)) return visitMethods.get(originalClass);
        Method method = null;
        Class<?> visitorClass = getClass();
        Class<?> nodeClass = originalClass;
        do {
            try {
                method = visitorClass.getDeclaredMethod("visit", nodeClass);
            } catch (NoSuchMethodException e) {}
            nodeClass = nodeClass.getSuperclass();
        } while (nodeClass != null && method == null);
        visitMethods.put(originalClass, method);
        return method;
    }

    protected void visit(Node node) throws AsmError {
        // BFS dispatcher for visit() methods
        Method method = findVisitMethod(node);
        if (method == null) return;
        try {
            method.invoke(this, node);
        } catch (IllegalAccessException | InvocationTargetException e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            if (cause instanceof AsmError) throw (AsmError) cause;
            throw new AsmError(node instanceof Command ? ((Command) node).loc : null,
                    1, "Cannot assemble: %s", cause.getMessage() == null ? cause.getClass().getSimpleName() : cause.getMessage());
        }
    }

    // catch errors: node.enter, this.visit(dynamic), node.leave
    protected void visitNode(Node node) {
        try {
            node.enter(program);
            visit(node);
            node.leave(program);
        } catch (AsmError err) {
            errorCatcher.add(err);
        }
    }

    protected void visitCommands(List<Command> commands) {
        for (Command cmd : commands) visitNode(cmd);
    }

    protected void visitBlocks(List<Block> blocks) {
        for (Block block : blocks) visitNode(block);
    }

    protected void visitSections(List<Section> sections) {
        for (Section section : sections) visitNode(section);
    }

    protected void visitSymbols(List<Symbol> symbols) {
        for (Symbol symbol : symbols) visitNode(symbol);
    }

    // visit entry points

    public void visitCommands() {
        visitCommands(program.commands);
    }

    public void visitByStructure() {
        try {
            program.enter(program);
            visit(program);
            program.leave(program);
        } catch (AsmError err) {
            errorCatcher.add(err);
        }
    }

}
