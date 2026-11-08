import java.util.ArrayList;
import java.util.List;

/** Graph node (Clone Graph). JSON form: 1-indexed adjacency list, e.g. [[2,4],[1,3],[2,4],[1,3]]. */
public class Node {
    public int val;
    public List<Node> neighbors;

    public Node() { this(0); }

    public Node(int val) { this(val, new ArrayList<>()); }

    public Node(int val, List<Node> neighbors) {
        this.val = val;
        this.neighbors = neighbors;
    }
}
