# LRU Cache

**Topic:** Linked List (+ Arrays & Hashing) · **Difficulty:** Medium · **Original:** https://leetcode.com/problems/lru-cache/

Build a key→value cache with a fixed capacity that, when full, throws out the entry that was
**least recently used**. Both reading a key and writing a key count as "using" it.

Implement class `LRUCache`:
- `LRUCache(int capacity)` — create an empty cache holding at most `capacity` entries.
- `int get(int key)` — return the value for `key`, or `-1` if it isn't cached. A hit makes `key` the most recently used.
- `void put(int key, int value)` — insert or overwrite `key`. It becomes the most recently used. If inserting a
  *new* key pushes the size above `capacity`, remove the least recently used key first-in-line.

**Both `get` and `put` must run in O(1) average time.**

## Constraints
- 1 ≤ capacity ≤ 3000
- 0 ≤ key ≤ 10⁴, 0 ≤ value ≤ 10⁵
- Up to 2·10⁵ calls in total

## Examples
Tests are operation sequences: the first op constructs the object; outputs are `null` for constructor/`void` calls.
```
ops:      ["LRUCache","put","put","get","put","get","put","get","get","get"]
args:     [[2],       [1,1],[2,2],[1],  [3,3],[2],  [4,4],[1],  [3],  [4]]
outputs:  [null,      null, null, 1,    null, -1,   null, -1,   3,    4]
```
After `get(1)`, key 2 is the least recently used, so `put(3,3)` evicts 2; then `put(4,4)` evicts 1.

```
ops:      ["LRUCache","put","get","put","get","get"]
args:     [[1],       [2,1],[2],  [3,2],[2],  [3]]
outputs:  [null,      null, 1,    null, -1,   2]
```

## Class to implement
```java
class LRUCache {
    public LRUCache(int capacity)
    public int get(int key)
    public void put(int key, int value)
}
```
