import java.io.PrintStream;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;

/**
 * PrepCoach Java test harness (no dependencies).
 *
 * Usage: java -cp <build> PrepRunner <tests.json> <results.json> <timeoutMs>
 *
 * tests.json:
 *   function problems: {"method": "twoSum", "compare": "exact|unordered|unorderedNested|float|checker",
 *                       "inPlace": <param index, optional>, "cases": [{"name": "...", "input": [arg0, arg1, ...], "expected": ...}]}
 *   design problems:   {"design": true, "cases": [{"name": "...", "ops": ["LRUCache","put","get"], "args": [[2],[1,1],[1]],
 *                       "expected": [null,null,1]}]}
 *
 * Argument types come from the Java method signature via reflection; JSON values are converted:
 *   ListNode <- [1,2,3] or {"list":[3,2,0,-4],"pos":1} (cycle)   TreeNode <- level order [3,9,20,null,null,15,7]
 *   char <- "a"   char[][] <- [["1","0"],...]   Node (graph) <- adjacency list   Node (random) <- [[7,null],[13,0]]
 */
public class PrepRunner {
    static final double EPS = 1e-5;
    static final int MAX_LIST_NODES = 100_000;

    public static void main(String[] args) throws Exception {
        Path testsPath = Path.of(args[0]);
        Path outPath = Path.of(args[1]);
        long timeoutMs = Long.parseLong(args[2]);

        Map<String, Object> spec = asMap(PrepJson.parse(Files.readString(testsPath, StandardCharsets.UTF_8)));
        List<Object> cases = asList(spec.get("cases"));
        boolean design = Boolean.TRUE.equals(spec.get("design"));
        String compare = (String) spec.getOrDefault("compare", "exact");

        List<Object> results = new ArrayList<>();
        int passed = 0;
        PrintStream realOut = System.out;

        for (int i = 0; i < cases.size(); i++) {
            Map<String, Object> c = asMap(cases.get(i));
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("index", (long) i);
            r.put("name", c.getOrDefault("name", "case " + (i + 1)));
            if (design) {
                r.put("input", mapOf("ops", c.get("ops"), "args", c.get("args")));
            } else {
                r.put("input", c.get("input"));
            }
            r.put("expected", c.get("expected"));

            final Map<String, Object> theCase = c;
            FutureTask<Object[]> task = new FutureTask<>(() -> {
                try {
                    return design ? runDesign(theCase) : runFunction(spec, theCase);
                } catch (Exception | Error e) {
                    throw e;
                } catch (Throwable t) {
                    throw new RuntimeException(t);
                }
            });
            Thread t = new Thread(null, task, "case-" + i, 512L * 1024 * 1024);
            t.setDaemon(true);
            long start = System.nanoTime();
            t.start();
            try {
                Object[] res = task.get(timeoutMs, TimeUnit.MILLISECONDS);
                Object actual = res[0];
                long nanos = (Long) res[1];
                r.put("timeMs", round2(nanos / 1e6));
                r.put("actual", actual);
                String failure = check(spec, compare, c, actual);
                if (failure == null) {
                    r.put("status", "pass");
                    passed++;
                } else {
                    r.put("status", "fail");
                    if (failure.isEmpty() && design) failure = designMismatch(c, actual);
                    if (!failure.isEmpty()) r.put("error", failure);
                }
            } catch (TimeoutException e) {
                r.put("status", "timeout");
                r.put("timeMs", (double) timeoutMs);
                r.put("error", "Time limit exceeded (" + timeoutMs + " ms) — infinite loop or too slow?");
                stopQuietly(t);
            } catch (ExecutionException e) {
                Throwable cause = unwrap(e.getCause());
                r.put("status", "error");
                r.put("timeMs", round2((System.nanoTime() - start) / 1e6));
                r.put("error", describe(cause));
            }
            results.add(r);
        }
        System.setOut(realOut);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("passed", (long) passed);
        out.put("total", (long) cases.size());
        out.put("cases", results);
        Files.writeString(outPath, PrepJson.write(out), StandardCharsets.UTF_8);
        System.out.flush();
        System.exit(0);
    }

    // ---------------------------------------------------------------- execution

    static Object[] runFunction(Map<String, Object> spec, Map<String, Object> c) throws Throwable {
        String className = (String) spec.getOrDefault("className", "Solution");
        String methodName = (String) spec.get("method");
        List<Object> input = asList(c.get("input"));
        Class<?> cls = Class.forName(className);
        Method m = findMethod(cls, methodName, input.size());
        Object instance = Modifier.isStatic(m.getModifiers()) ? null : newInstance(cls);
        Type[] types = m.getGenericParameterTypes();
        Object[] args = new Object[types.length];
        for (int i = 0; i < types.length; i++) args[i] = toJava(input.get(i), types[i]);

        long start = System.nanoTime();
        Object ret;
        try {
            ret = m.invoke(instance, args);
        } catch (InvocationTargetException e) {
            throw e.getCause();
        }
        long nanos = System.nanoTime() - start;

        Object inPlace = spec.get("inPlace");
        Object actual = inPlace != null
                ? canonTyped(args[((Number) inPlace).intValue()], m.getParameterTypes()[((Number) inPlace).intValue()])
                : canonTyped(ret, m.getReturnType());
        return new Object[] {actual, nanos};
    }

    static Object[] runDesign(Map<String, Object> c) throws Throwable {
        List<Object> ops = asList(c.get("ops"));
        List<Object> argLists = asList(c.get("args"));
        Class<?> cls = Class.forName((String) ops.get(0));
        List<Object> outputs = new ArrayList<>();
        long start = System.nanoTime();
        Object instance;
        try {
            List<Object> ctorArgs = asList(argLists.get(0));
            Constructor<?> ctor = null;
            for (Constructor<?> k : cls.getDeclaredConstructors()) {
                if (k.getParameterCount() == ctorArgs.size()) ctor = k;
            }
            if (ctor == null) throw new NoSuchMethodException(cls.getName() + " constructor with " + ctorArgs.size() + " args");
            ctor.setAccessible(true);
            instance = ctor.newInstance(convertArgs(ctor.getGenericParameterTypes(), ctorArgs));
            outputs.add(null);
            for (int i = 1; i < ops.size(); i++) {
                List<Object> a = asList(argLists.get(i));
                Method m = findMethod(cls, (String) ops.get(i), a.size());
                Object ret = m.invoke(instance, convertArgs(m.getGenericParameterTypes(), a));
                outputs.add(m.getReturnType() == void.class ? null : canonTyped(ret, m.getReturnType()));
            }
        } catch (InvocationTargetException e) {
            throw e.getCause();
        }
        return new Object[] {outputs, System.nanoTime() - start};
    }

    static Object[] convertArgs(Type[] types, List<Object> json) {
        Object[] out = new Object[types.length];
        for (int i = 0; i < types.length; i++) out[i] = toJava(json.get(i), types[i]);
        return out;
    }

    static Method findMethod(Class<?> cls, String name, int argc) throws NoSuchMethodException {
        for (Class<?> k = cls; k != null; k = k.getSuperclass()) {
            for (Method m : k.getDeclaredMethods()) {
                if (m.getName().equals(name) && m.getParameterCount() == argc) {
                    m.setAccessible(true);
                    return m;
                }
            }
        }
        throw new NoSuchMethodException(cls.getName() + "." + name + " with " + argc + " parameter(s) — did you change the method signature?");
    }

    static Object newInstance(Class<?> cls) throws Exception {
        Constructor<?> k = cls.getDeclaredConstructor();
        k.setAccessible(true);
        return k.newInstance();
    }

    @SuppressWarnings("deprecation")
    static void stopQuietly(Thread t) {
        try {
            t.stop(); // works on Java 17-19; on newer JDKs the daemon thread is simply abandoned
        } catch (Throwable ignored) {
        }
    }

    static Throwable unwrap(Throwable t) {
        while ((t instanceof InvocationTargetException || t instanceof ExecutionException) && t.getCause() != null) t = t.getCause();
        return t;
    }

    static String describe(Throwable t) {
        StringBuilder sb = new StringBuilder(t.getClass().getName());
        if (t instanceof StackOverflowError) sb.append(" (recursion too deep or infinite recursion)");
        if (t.getMessage() != null) sb.append(": ").append(t.getMessage());
        for (StackTraceElement el : t.getStackTrace()) {
            String c = el.getClassName();
            if (!c.startsWith("PrepRunner") && !c.startsWith("PrepJson") && !c.startsWith("java.") && !c.startsWith("jdk.")) {
                sb.append(" at ").append(el.getClassName()).append('.').append(el.getMethodName())
                  .append('(').append(el.getFileName()).append(':').append(el.getLineNumber()).append(')');
                break;
            }
        }
        return sb.toString();
    }

    // ---------------------------------------------------------------- comparison

    /** Returns null on pass, otherwise a (possibly empty) failure note. */
    static String check(Map<String, Object> spec, String compare, Map<String, Object> c, Object actual) throws Exception {
        Object expected = c.get("expected");
        switch (compare) {
            case "unordered":
                return deepEquals(sortedList(expected, false), sortedList(actual, false), false) ? null : "";
            case "unorderedNested":
                return deepEquals(sortedList(expected, true), sortedList(actual, true), false) ? null : "";
            case "float":
                return deepEquals(expected, actual, true) ? null : "";
            case "checker": {
                Class<?> k = Class.forName((String) spec.getOrDefault("checker", "Checker"));
                Method m = k.getDeclaredMethod("check", Object.class, Object.class, Object.class);
                m.setAccessible(true);
                Object input = c.containsKey("input") ? c.get("input") : mapOf("ops", c.get("ops"), "args", c.get("args"));
                String msg = (String) m.invoke(null, input, actual, expected);
                return msg == null ? null : msg;
            }
            default:
                return deepEquals(expected, actual, false) ? null : "";
        }
    }

    /** "op #5 get(2): expected -1, got 2" for the first differing design call. */
    static String designMismatch(Map<String, Object> c, Object actual) {
        List<Object> ops = asList(c.get("ops")), args = asList(c.get("args")), exp = asList(c.get("expected"));
        List<Object> act = asList(actual);
        for (int i = 0; i < Math.min(exp.size(), act.size()); i++) {
            if (!deepEquals(exp.get(i), act.get(i), false)) {
                String a = PrepJson.write(args.get(i));
                return "first mismatch at op #" + i + " " + ops.get(i) + "(" + a.substring(1, a.length() - 1) + "): expected "
                        + PrepJson.write(exp.get(i)) + ", got " + PrepJson.write(act.get(i));
            }
        }
        return exp.size() != act.size() ? "expected " + exp.size() + " outputs, got " + act.size() : "";
    }

    static Object sortedList(Object v, boolean nested) {
        if (!(v instanceof List)) return v;
        List<Object> copy = new ArrayList<>();
        for (Object o : (List<?>) v) copy.add(nested ? sortedList(o, false) : o);
        copy.sort(Comparator.comparing(PrepJson::write));
        return copy;
    }

    static boolean deepEquals(Object a, Object b, boolean tolerant) {
        if (a == null || b == null) return a == b;
        if (a instanceof Number && b instanceof Number) {
            if (a instanceof Double || b instanceof Double) {
                double x = ((Number) a).doubleValue(), y = ((Number) b).doubleValue();
                return tolerant ? Math.abs(x - y) <= EPS * Math.max(1, Math.abs(x)) : x == y;
            }
            return ((Number) a).longValue() == ((Number) b).longValue();
        }
        if (a instanceof List && b instanceof List) {
            List<?> x = (List<?>) a, y = (List<?>) b;
            if (x.size() != y.size()) return false;
            for (int i = 0; i < x.size(); i++) if (!deepEquals(x.get(i), y.get(i), tolerant)) return false;
            return true;
        }
        if (a instanceof Map && b instanceof Map) {
            Map<?, ?> x = (Map<?, ?>) a, y = (Map<?, ?>) b;
            if (!x.keySet().equals(y.keySet())) return false;
            for (Object k : x.keySet()) if (!deepEquals(x.get(k), y.get(k), tolerant)) return false;
            return true;
        }
        return a.equals(b);
    }

    // ---------------------------------------------------------------- JSON -> Java

    static Object toJava(Object json, Type type) {
        if (type instanceof ParameterizedType) {
            ParameterizedType pt = (ParameterizedType) type;
            Class<?> raw = (Class<?>) pt.getRawType();
            Type[] targs = pt.getActualTypeArguments();
            if (json == null) return null;
            if (Collection.class.isAssignableFrom(raw)) {
                Collection<Object> col = Set.class.isAssignableFrom(raw) ? new LinkedHashSet<>()
                        : Deque.class.isAssignableFrom(raw) || Queue.class.isAssignableFrom(raw) ? new ArrayDeque<>()
                        : new ArrayList<>();
                for (Object o : asList(json)) col.add(toJava(o, targs[0]));
                return col;
            }
            if (Map.class.isAssignableFrom(raw)) {
                Map<Object, Object> m = new LinkedHashMap<>();
                for (Map.Entry<String, Object> e : asMap(json).entrySet()) m.put(toJava(e.getKey(), targs[0]), toJava(e.getValue(), targs[1]));
                return m;
            }
            return toJava(json, raw);
        }
        if (type instanceof GenericArrayType) {
            Type comp = ((GenericArrayType) type).getGenericComponentType();
            List<Object> list = asList(json);
            Class<?> rawComp = comp instanceof ParameterizedType ? (Class<?>) ((ParameterizedType) comp).getRawType() : Object.class;
            Object arr = Array.newInstance(rawComp, list.size());
            for (int i = 0; i < list.size(); i++) Array.set(arr, i, toJava(list.get(i), comp));
            return arr;
        }
        Class<?> cls = (Class<?>) type;
        if (cls == int.class || cls == Integer.class) return json == null ? null : ((Number) json).intValue();
        if (cls == long.class || cls == Long.class) return json == null ? null : ((Number) json).longValue();
        if (cls == double.class || cls == Double.class) return json == null ? null : ((Number) json).doubleValue();
        if (cls == float.class || cls == Float.class) return json == null ? null : ((Number) json).floatValue();
        if (cls == boolean.class || cls == Boolean.class) return json;
        if (cls == char.class || cls == Character.class) return json == null ? null : ((String) json).charAt(0);
        if (cls == String.class) return json;
        if (cls == Object.class) return json;
        if (json == null) return null;
        if (cls.isArray()) {
            List<Object> list = asList(json);
            Object arr = Array.newInstance(cls.getComponentType(), list.size());
            for (int i = 0; i < list.size(); i++) Array.set(arr, i, toJava(list.get(i), cls.getComponentType()));
            return arr;
        }
        if (cls.getSimpleName().equals("ListNode")) return buildList(json);
        if (cls.getSimpleName().equals("TreeNode")) return buildTree(asList(json));
        if (cls.getSimpleName().equals("Node")) return buildNode(cls, json);
        if (Collection.class.isAssignableFrom(cls)) return new ArrayList<>(asList(json));
        throw new IllegalArgumentException("Harness can't convert JSON to " + cls.getName());
    }

    static ListNode buildList(Object json) {
        List<Object> vals;
        int pos = -1;
        if (json instanceof Map) {
            Map<String, Object> m = asMap(json);
            vals = asList(m.get("list"));
            if (m.get("pos") != null) pos = ((Number) m.get("pos")).intValue();
        } else vals = asList(json);
        ListNode dummy = new ListNode(0), cur = dummy, cycleTarget = null;
        for (int i = 0; i < vals.size(); i++) {
            cur.next = new ListNode(((Number) vals.get(i)).intValue());
            cur = cur.next;
            if (i == pos) cycleTarget = cur;
        }
        if (cycleTarget != null) cur.next = cycleTarget;
        return dummy.next;
    }

    static TreeNode buildTree(List<Object> vals) {
        if (vals.isEmpty() || vals.get(0) == null) return null;
        TreeNode root = new TreeNode(((Number) vals.get(0)).intValue());
        Deque<TreeNode> q = new ArrayDeque<>();
        q.add(root);
        int i = 1;
        while (!q.isEmpty() && i < vals.size()) {
            TreeNode n = q.poll();
            if (i < vals.size() && vals.get(i) != null) { n.left = new TreeNode(((Number) vals.get(i)).intValue()); q.add(n.left); }
            i++;
            if (i < vals.size() && vals.get(i) != null) { n.right = new TreeNode(((Number) vals.get(i)).intValue()); q.add(n.right); }
            i++;
        }
        return root;
    }

    static Object buildNode(Class<?> cls, Object json) {
        try {
            List<Object> rows = asList(json);
            Constructor<?> k = cls.getDeclaredConstructor(int.class);
            k.setAccessible(true);
            if (hasField(cls, "neighbors")) {
                if (rows.isEmpty()) return null;
                Field nf = cls.getDeclaredField("neighbors");
                nf.setAccessible(true);
                List<Object> nodes = new ArrayList<>();
                for (int i = 0; i < rows.size(); i++) nodes.add(k.newInstance(i + 1));
                for (int i = 0; i < rows.size(); i++) {
                    @SuppressWarnings("unchecked") List<Object> nb = (List<Object>) nf.get(nodes.get(i));
                    if (nb == null) { nb = new ArrayList<>(); nf.set(nodes.get(i), nb); }
                    for (Object j : asList(rows.get(i))) nb.add(nodes.get(((Number) j).intValue() - 1));
                }
                return nodes.get(0);
            }
            if (hasField(cls, "random")) {
                Field next = cls.getDeclaredField("next"), random = cls.getDeclaredField("random");
                next.setAccessible(true);
                random.setAccessible(true);
                List<Object> nodes = new ArrayList<>();
                for (Object row : rows) nodes.add(k.newInstance(((Number) asList(row).get(0)).intValue()));
                for (int i = 0; i < nodes.size(); i++) {
                    if (i + 1 < nodes.size()) next.set(nodes.get(i), nodes.get(i + 1));
                    Object ri = asList(rows.get(i)).get(1);
                    if (ri != null) random.set(nodes.get(i), nodes.get(((Number) ri).intValue()));
                }
                return nodes.isEmpty() ? null : nodes.get(0);
            }
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
        throw new IllegalArgumentException("Unsupported Node shape (expected neighbors or random field)");
    }

    static boolean hasField(Class<?> cls, String name) {
        try { cls.getDeclaredField(name); return true; } catch (NoSuchFieldException e) { return false; }
    }

    // ---------------------------------------------------------------- Java -> canonical JSON

    /** Like canon, but a null ListNode/TreeNode/Node is the empty structure [] (LeetCode convention). */
    static Object canonTyped(Object v, Class<?> declared) {
        if (v == null) {
            String n = declared.getSimpleName();
            if (n.equals("ListNode") || n.equals("TreeNode") || n.equals("Node")) return new ArrayList<>();
        }
        return canon(v);
    }

    static Object canon(Object v) {
        if (v == null) return null;
        if (v instanceof Integer || v instanceof Long || v instanceof Short || v instanceof Byte) return ((Number) v).longValue();
        if (v instanceof Float || v instanceof Double) return ((Number) v).doubleValue();
        if (v instanceof Boolean || v instanceof String) return v;
        if (v instanceof Character) return String.valueOf(v);
        if (v.getClass().isArray()) {
            List<Object> out = new ArrayList<>();
            for (int i = 0; i < Array.getLength(v); i++) out.add(canon(Array.get(v, i)));
            return out;
        }
        if (v instanceof Iterable) {
            List<Object> out = new ArrayList<>();
            for (Object o : (Iterable<?>) v) out.add(canon(o));
            return out;
        }
        if (v instanceof Map) {
            Map<String, Object> out = new TreeMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) out.put(String.valueOf(e.getKey()), canon(e.getValue()));
            return out;
        }
        if (v instanceof ListNode) {
            List<Object> out = new ArrayList<>();
            Set<ListNode> seen = Collections.newSetFromMap(new IdentityHashMap<>());
            for (ListNode n = (ListNode) v; n != null; n = n.next) {
                if (!seen.add(n) || out.size() > MAX_LIST_NODES) { out.add("...cycle"); break; }
                out.add((long) n.val);
            }
            return out;
        }
        if (v instanceof TreeNode) {
            List<Object> out = new ArrayList<>();
            Deque<TreeNode> q = new ArrayDeque<>();
            List<TreeNode> level = new ArrayList<>();
            level.add((TreeNode) v);
            while (!level.isEmpty()) {
                List<TreeNode> next = new ArrayList<>();
                for (TreeNode n : level) {
                    if (n == null) { out.add(null); continue; }
                    out.add((long) n.val);
                    next.add(n.left);
                    next.add(n.right);
                }
                level = next;
                if (out.size() > MAX_LIST_NODES) break;
            }
            while (!out.isEmpty() && out.get(out.size() - 1) == null) out.remove(out.size() - 1);
            return out;
        }
        if (v.getClass().getSimpleName().equals("Node")) return canonNode(v);
        return String.valueOf(v);
    }

    static Object canonNode(Object start) {
        try {
            Class<?> cls = start.getClass();
            Field val = cls.getDeclaredField("val");
            val.setAccessible(true);
            if (hasField(cls, "neighbors")) {
                Field nf = cls.getDeclaredField("neighbors");
                nf.setAccessible(true);
                Map<Integer, Object> byVal = new TreeMap<>();
                Deque<Object> q = new ArrayDeque<>();
                Set<Object> seen = Collections.newSetFromMap(new IdentityHashMap<>());
                q.add(start);
                seen.add(start);
                while (!q.isEmpty()) {
                    Object n = q.poll();
                    List<Object> adj = new ArrayList<>();
                    for (Object m : (List<?>) nf.get(n)) {
                        adj.add((long) val.getInt(m));
                        if (seen.add(m)) q.add(m);
                    }
                    byVal.put(val.getInt(n), adj);
                }
                return new ArrayList<>(byVal.values());
            }
            if (hasField(cls, "random")) {
                Field next = cls.getDeclaredField("next"), random = cls.getDeclaredField("random");
                next.setAccessible(true);
                random.setAccessible(true);
                IdentityHashMap<Object, Integer> idx = new IdentityHashMap<>();
                List<Object> nodes = new ArrayList<>();
                for (Object n = start; n != null && nodes.size() <= MAX_LIST_NODES; n = next.get(n)) {
                    if (idx.containsKey(n)) break;
                    idx.put(n, nodes.size());
                    nodes.add(n);
                }
                List<Object> out = new ArrayList<>();
                for (Object n : nodes) {
                    Object r = random.get(n);
                    out.add(Arrays.asList((long) val.getInt(n), r == null ? null : (Object) (long) idx.getOrDefault(r, -1)));
                }
                return out;
            }
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
        return String.valueOf(start);
    }

    // ---------------------------------------------------------------- helpers

    @SuppressWarnings("unchecked")
    static Map<String, Object> asMap(Object o) { return (Map<String, Object>) o; }

    @SuppressWarnings("unchecked")
    static List<Object> asList(Object o) {
        if (o == null) return new ArrayList<>();
        return (List<Object>) o;
    }

    static Map<String, Object> mapOf(String k1, Object v1, String k2, Object v2) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put(k1, v1);
        m.put(k2, v2);
        return m;
    }

    static double round2(double x) { return Math.round(x * 100) / 100.0; }
}

/** Minimal JSON parser/writer: objects → LinkedHashMap, arrays → ArrayList, integers → Long, decimals → Double. */
class PrepJson {
    private final String s;
    private int i;

    private PrepJson(String s) { this.s = s; }

    static Object parse(String text) {
        PrepJson p = new PrepJson(text);
        p.ws();
        Object v = p.value();
        p.ws();
        if (p.i != p.s.length()) throw p.err("trailing characters");
        return v;
    }

    private RuntimeException err(String msg) { return new IllegalArgumentException("tests.json: " + msg + " at offset " + i); }

    private void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

    private Object value() {
        if (i >= s.length()) throw err("unexpected end");
        char c = s.charAt(i);
        if (c == '{') return object();
        if (c == '[') return array();
        if (c == '"') return string();
        if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
        if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
        if (s.startsWith("null", i)) { i += 4; return null; }
        return number();
    }

    private Map<String, Object> object() {
        Map<String, Object> m = new LinkedHashMap<>();
        i++;
        ws();
        if (s.charAt(i) == '}') { i++; return m; }
        while (true) {
            ws();
            String k = string();
            ws();
            if (s.charAt(i++) != ':') throw err("expected ':'");
            ws();
            m.put(k, value());
            ws();
            char c = s.charAt(i++);
            if (c == '}') return m;
            if (c != ',') throw err("expected ',' or '}'");
        }
    }

    private List<Object> array() {
        List<Object> l = new ArrayList<>();
        i++;
        ws();
        if (s.charAt(i) == ']') { i++; return l; }
        while (true) {
            ws();
            l.add(value());
            ws();
            char c = s.charAt(i++);
            if (c == ']') return l;
            if (c != ',') throw err("expected ',' or ']'");
        }
    }

    private String string() {
        if (s.charAt(i) != '"') throw err("expected string");
        i++;
        StringBuilder sb = new StringBuilder();
        while (true) {
            char c = s.charAt(i++);
            if (c == '"') return sb.toString();
            if (c == '\\') {
                char e = s.charAt(i++);
                switch (e) {
                    case 'n': sb.append('\n'); break;
                    case 't': sb.append('\t'); break;
                    case 'r': sb.append('\r'); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case 'u': sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                    default: sb.append(e);
                }
            } else sb.append(c);
        }
    }

    private Object number() {
        int start = i;
        while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
        String n = s.substring(start, i);
        if (n.isEmpty()) throw err("unexpected character '" + s.charAt(i) + "'");
        if (n.contains(".") || n.contains("e") || n.contains("E")) return Double.parseDouble(n);
        return Long.parseLong(n);
    }

    static String write(Object v) {
        StringBuilder sb = new StringBuilder();
        write(v, sb);
        return sb.toString();
    }

    private static void write(Object v, StringBuilder sb) {
        if (v == null) sb.append("null");
        else if (v instanceof String) {
            sb.append('"');
            for (char c : ((String) v).toCharArray()) {
                if (c == '"' || c == '\\') sb.append('\\').append(c);
                else if (c == '\n') sb.append("\\n");
                else if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                else sb.append(c);
            }
            sb.append('"');
        } else if (v instanceof Double) {
            double d = (Double) v;
            if (Double.isNaN(d) || Double.isInfinite(d)) sb.append('"').append(d).append('"');
            else sb.append(d);
        } else if (v instanceof Number || v instanceof Boolean) sb.append(v);
        else if (v instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                write(String.valueOf(e.getKey()), sb);
                sb.append(':');
                write(e.getValue(), sb);
            }
            sb.append('}');
        } else if (v instanceof List) {
            sb.append('[');
            boolean first = true;
            for (Object o : (List<?>) v) {
                if (!first) sb.append(',');
                first = false;
                write(o, sb);
            }
            sb.append(']');
        } else write(String.valueOf(v), sb);
    }
}
