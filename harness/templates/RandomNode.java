/** List node with a random pointer (Copy List with Random Pointer). JSON form: [[val, randomIndex|null], ...]. */
public class Node {
    public int val;
    public Node next;
    public Node random;

    public Node(int val) {
        this.val = val;
    }
}
