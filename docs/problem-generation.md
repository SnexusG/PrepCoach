# Lazy problem generation (tutor procedure)

Generate a problem's files the first time it is served (`prep next` / `prep start` says "NOT generated yet").

## Steps
1. `npx prep scaffold <slug>` — creates `problems/<slug>/` and `notes.md`.
   Graph problems (Clone Graph): add `--node graph`. Random-pointer list: `--node random`.
2. `npx prep tag <slug> --secondary "Topic A,Topic B"` if the problem genuinely exercises other topics
   (e.g. LRU Cache → Linked List + Arrays & Hashing). Secondary topics get half-weight rating updates.
3. Write **`Problem.md`** — in your own words (never copy LeetCode text): header line with topic, difficulty and
   original link; statement; constraints; 2–3 examples; the method/class signature. No hints toward the approach.
4. Write **`Solution.java`** — a stub with the exact LeetCode signature, `// TODO` body and a dummy return.
   `ListNode` / `TreeNode` come from the harness (mention them in a comment). Design problems: just the class.
5. Write **`tests.json`** — 10–20 cases incl. edge cases: empty input, single element, duplicates, negatives,
   boundaries, and one max-constraint case. Generate big/random cases and their expected values with a script.
6. **Verify privately:** write a reference solution **outside the repo** (e.g. `%TEMP%/prepcoach-ref/<slug>.java`),
   run `npx prep run-tests <slug> --solution <that file>`, fix tests until all pass, then delete the reference.
   Never show the reference to the user and never save it under the repo.
7. Sanity-check that the stub compiles: `npx prep run-tests <slug>` should run (and fail) without a compile error.

## tests.json format
One case per line keeps diffs readable.

Function problems:
```json
{
  "method": "groupAnagrams",
  "compare": "unorderedNested",
  "cases": [
    {"name": "mixed example", "input": [["eat","tea","tan"]], "expected": [["eat","tea"],["tan"]]}
  ]
}
```
- `input` is the argument list (one JSON value per parameter). Types come from the Java signature.
- `compare`: `exact` (default) · `unordered` (top-level list order ignored) · `unorderedNested` (inner and outer
  order ignored) · `float` (1e-5 relative tolerance) · `checker` (problem dir has `Checker.java` with
  `public static String check(Object input, Object actual, Object expected)` returning `null` on success; it must
  validate properties only, never contain a solution).
- `inPlace: <param index>` — for `void` methods, compare that argument after the call (e.g. Rotate Image).
- `className` — defaults to `Solution`.

Design problems (operation sequences, LeetCode style):
```json
{
  "design": true,
  "cases": [
    {"name": "example", "ops": ["LRUCache","put","get"], "args": [[2],[1,1],[1]], "expected": [null,null,1]}
  ]
}
```

## JSON ↔ Java conversions
| Java type | JSON |
|---|---|
| `int`, `long`, `double`, `boolean`, `String` | number / boolean / string |
| `char` | one-character string `"a"` |
| arrays, `List<…>`, `Set<…>` | arrays (nested as needed), e.g. `char[][]` ← `[["1","0"],["0","1"]]` |
| `ListNode` | `[1,2,3]`; with a cycle: `{"list":[3,2,0,-4],"pos":1}` |
| `TreeNode` | LeetCode level order with `null`s: `[3,9,20,null,null,15,7]` |
| `Node` (graph, `--node graph`) | 1-indexed adjacency list `[[2,4],[1,3],[2,4],[1,3]]` |
| `Node` (random pointer, `--node random`) | `[[7,null],[13,0],[11,4]]` |

Null `ListNode`/`TreeNode`/`Node` results are written as `[]`.

## Runner behaviour
Each case runs on its own thread (512 MB stack) with a per-test timeout (`runner.perTestTimeoutMs`, default 2 s).
Results: pass / fail / timeout / error per case, first failing input with expected vs actual (design problems name
the first mismatching op), solution runtime, and anything printed to stdout. `prep run-tests` saves
`problems/<slug>/.results.json` and stores passed/total on the open attempt.
