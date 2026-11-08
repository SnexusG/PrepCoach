import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runJavaTests } from '../javaRunner';
import { paths } from '../config';

let hasJava = true;
try {
  execFileSync('javac', ['-version'], { stdio: 'ignore' });
} catch {
  hasJava = false;
}

const dirs: string[] = [];
function fixture(solution: string, tests: object, extra: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-fixture-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'Solution.java'), solution);
  fs.writeFileSync(path.join(dir, 'tests.json'), JSON.stringify(tests));
  for (const [name, content] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe.skipIf(!hasJava)('Java harness', () => {
  it('runs int[] → boolean, reporting pass/fail with expected vs actual', async () => {
    const dir = fixture(
      `import java.util.*;
       class Solution { public boolean containsDuplicate(int[] nums) {
         Set<Integer> s = new HashSet<>(); for (int n : nums) if (!s.add(n)) return true; return false; } }`,
      {
        method: 'containsDuplicate',
        cases: [
          { name: 'dup', input: [[1, 2, 3, 1]], expected: true },
          { name: 'none', input: [[1, 2, 3]], expected: false },
          { name: 'wrong expectation', input: [[]], expected: true },
        ],
      },
    );
    const r = await runJavaTests(dir);
    expect(r.compiled).toBe(true);
    expect(r).toMatchObject({ passed: 2, total: 3, allPassed: false });
    expect(r.firstFailure).toMatchObject({ index: 2, status: 'fail', expected: true, actual: false });
  }, 30000);

  it('handles ListNode, TreeNode and cycles', async () => {
    const dir = fixture(
      `class Solution {
         public ListNode reverseList(ListNode h) { ListNode p = null; while (h != null) { ListNode n = h.next; h.next = p; p = h; h = n; } return p; }
         public TreeNode invertTree(TreeNode r) { if (r == null) return null; TreeNode t = r.left; r.left = invertTree(r.right); r.right = invertTree(t); return r; }
         public boolean hasCycle(ListNode h) { ListNode s = h, f = h; while (f != null && f.next != null) { s = s.next; f = f.next.next; if (s == f) return true; } return false; }
       }`,
      {
        method: 'reverseList',
        cases: [
          { input: [[1, 2, 3, 4, 5]], expected: [5, 4, 3, 2, 1] },
          { input: [[]], expected: [] },
        ],
      },
    );
    expect((await runJavaTests(dir)).allPassed).toBe(true);

    fs.writeFileSync(
      path.join(dir, 'tests.json'),
      JSON.stringify({ method: 'invertTree', cases: [{ input: [[4, 2, 7, 1, 3, 6, 9]], expected: [4, 7, 2, 9, 6, 3, 1] }, { input: [[1, null, 2]], expected: [1, 2] }] }),
    );
    expect((await runJavaTests(dir)).allPassed).toBe(true);

    fs.writeFileSync(
      path.join(dir, 'tests.json'),
      JSON.stringify({ method: 'hasCycle', cases: [{ input: [{ list: [3, 2, 0, -4], pos: 1 }], expected: true }, { input: [[1, 2]], expected: false }] }),
    );
    expect((await runJavaTests(dir)).allPassed).toBe(true);
  }, 60000);

  it('times out infinite loops and reports runtime errors with the solution line', async () => {
    const dir = fixture(
      `class Solution { public int f(int x) {
         if (x == 0) { while (true) {} }
         int[] a = new int[1];
         return a[x]; } }`,
      { method: 'f', cases: [{ name: 'loop', input: [0], expected: 0 }, { name: 'oob', input: [5], expected: 0 }] },
    );
    const r = await runJavaTests(dir, { timeoutMs: 300 });
    expect(r.cases[0].status).toBe('timeout');
    expect(r.cases[1].status).toBe('error');
    expect(r.cases[1].error).toMatch(/ArrayIndexOutOfBoundsException.*Solution\.f\(Solution\.java:4\)/);
  }, 30000);

  it('reports compile errors without harness noise', async () => {
    const dir = fixture('class Solution { public int f(int x) { return y; } }', { method: 'f', cases: [{ input: [1], expected: 1 }] });
    const r = await runJavaTests(dir);
    expect(r.compiled).toBe(false);
    expect(r.compileError).toMatch(/Solution\.java:1: error: cannot find symbol/);
    expect(r.compileError).not.toContain(paths.harness);
  }, 30000);

  it('supports design classes via operation sequences', async () => {
    const dir = fixture(
      `import java.util.*;
       class MinStack { Deque<int[]> s = new ArrayDeque<>();
         public MinStack() {}
         public void push(int v) { s.push(new int[]{v, s.isEmpty() ? v : Math.min(v, s.peek()[1])}); }
         public void pop() { s.pop(); } public int top() { return s.peek()[0]; } public int getMin() { return s.peek()[1]; } }`,
      {
        design: true,
        cases: [
          {
            ops: ['MinStack', 'push', 'push', 'push', 'getMin', 'pop', 'top', 'getMin'],
            args: [[], [-2], [0], [-3], [], [], [], []],
            expected: [null, null, null, null, -3, null, 0, -2],
          },
        ],
      },
    );
    const r = await runJavaTests(dir);
    expect(r.allPassed).toBe(true);
  }, 30000);

  it('supports unordered comparisons, char[][], in-place and float', async () => {
    const dir = fixture(
      `import java.util.*;
       class Solution {
         public List<List<String>> groupAnagrams(String[] strs) { Map<String, List<String>> m = new HashMap<>();
           for (String s : strs) { char[] c = s.toCharArray(); Arrays.sort(c); m.computeIfAbsent(new String(c), k -> new ArrayList<>()).add(s); }
           return new ArrayList<>(m.values()); }
         public int count(char[][] g) { int n = 0; for (char[] r : g) for (char c : r) if (c == '1') n++; return n; }
         public void rotate(int[][] m) { int n = m.length; int[][] r = new int[n][n];
           for (int i = 0; i < n; i++) for (int j = 0; j < n; j++) r[j][n - 1 - i] = m[i][j];
           for (int i = 0; i < n; i++) m[i] = r[i]; }
         public double half(int x) { return x / 3.0; }
       }`,
      { method: 'groupAnagrams', compare: 'unorderedNested', cases: [{ input: [['eat', 'tea', 'tan', 'ate', 'nat', 'bat']], expected: [['bat'], ['nat', 'tan'], ['ate', 'eat', 'tea']] }] },
    );
    expect((await runJavaTests(dir)).allPassed).toBe(true);
    fs.writeFileSync(path.join(dir, 'tests.json'), JSON.stringify({ method: 'count', cases: [{ input: [[['1', '0'], ['1', '1']]], expected: 3 }] }));
    expect((await runJavaTests(dir)).allPassed).toBe(true);
    fs.writeFileSync(path.join(dir, 'tests.json'), JSON.stringify({ method: 'rotate', inPlace: 0, cases: [{ input: [[[1, 2], [3, 4]]], expected: [[3, 1], [4, 2]] }] }));
    expect((await runJavaTests(dir)).allPassed).toBe(true);
    fs.writeFileSync(path.join(dir, 'tests.json'), JSON.stringify({ method: 'half', compare: 'float', cases: [{ input: [1], expected: 0.333333 }] }));
    expect((await runJavaTests(dir)).allPassed).toBe(true);
  }, 60000);

  it('clones graphs with per-problem Node classes', async () => {
    const node = fs.readFileSync(path.join(paths.harness, 'templates', 'GraphNode.java'), 'utf8');
    const dir = fixture(
      `import java.util.*;
       class Solution { Map<Node, Node> m = new HashMap<>();
         public Node cloneGraph(Node n) { if (n == null) return null; if (m.containsKey(n)) return m.get(n);
           Node c = new Node(n.val); m.put(n, c); for (Node x : n.neighbors) c.neighbors.add(cloneGraph(x)); return c; } }`,
      { method: 'cloneGraph', cases: [{ input: [[[2, 4], [1, 3], [2, 4], [1, 3]]], expected: [[2, 4], [1, 3], [2, 4], [1, 3]] }, { input: [[]], expected: [] }] },
      { 'Node.java': node },
    );
    expect((await runJavaTests(dir)).allPassed).toBe(true);
  }, 30000);

  it('can run a reference solution file in place of Solution.java', async () => {
    const dir = fixture('class Solution { public int sq(int x) { return 0; } }', { method: 'sq', cases: [{ input: [3], expected: 9 }] });
    expect((await runJavaTests(dir)).allPassed).toBe(false);
    const ref = path.join(dir, '..', `ref-${path.basename(dir)}.java`);
    fs.writeFileSync(ref, 'class Solution { public int sq(int x) { return x * x; } }');
    dirs.push(ref);
    const r = await runJavaTests(dir, { solutionFile: ref });
    expect(r).toMatchObject({ allPassed: true, usedReference: true });
  }, 30000);
});
