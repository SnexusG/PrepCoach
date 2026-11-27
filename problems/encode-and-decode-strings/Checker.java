import java.util.*;

/** Round-trip property check: decode(encode(strs)) must equal strs. Contains no solution logic. */
class Checker {
    @SuppressWarnings("unchecked")
    public static String check(Object input, Object actual, Object expected) {
        List<Object> args = (List<Object>) input;
        List<Object> original = (List<Object>) args.get(0);
        if (!(actual instanceof String)) return "encode must return a String, got " + actual;
        List<String> decoded;
        try {
            decoded = new Solution().decode((String) actual);
        } catch (Throwable t) {
            return "decode threw " + t;
        }
        if (decoded == null) return "decode returned null";
        if (decoded.size() != original.size())
            return "decode returned " + decoded.size() + " strings, expected " + original.size() + ": " + decoded;
        for (int i = 0; i < original.size(); i++) {
            if (!Objects.equals(original.get(i), decoded.get(i)))
                return "string #" + i + " came back as \"" + decoded.get(i) + "\", expected \"" + original.get(i) + "\"";
        }
        return null;
    }
}
