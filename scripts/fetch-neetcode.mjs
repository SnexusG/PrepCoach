// Rebuilds data/sheets/neetcode150.json and blind75.json from NeetCode's public GitHub data.
// Usage: node scripts/fetch-neetcode.mjs [path-to-local-.problemSiteData.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://raw.githubusercontent.com/neetcode-gh/leetcode/main/.problemSiteData.json';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'data', 'sheets');

const local = process.argv[2];
const data = local
  ? JSON.parse(fs.readFileSync(local, 'utf8'))
  : await fetch(SOURCE).then((r) => {
      if (!r.ok) throw new Error(`Fetch failed: HTTP ${r.status}`);
      return r.json();
    });

const config = JSON.parse(fs.readFileSync(path.join(root, 'prep.config.json'), 'utf8'));
const knownTopics = new Set(config.topics.dsa.map((t) => t.name));

function build(id, name, flag, expected) {
  const rows = data.filter((p) => p[flag]);
  const problems = rows.map((p, i) => {
    const slug = p.link.replace(/\/$/, '');
    if (!knownTopics.has(p.pattern)) throw new Error(`Unknown category "${p.pattern}" for ${slug}`);
    return {
      order: i + 1,
      slug,
      title: p.problem,
      topic: p.pattern,
      secondaryTopics: [],
      difficulty: p.difficulty.toLowerCase(),
      url: `https://leetcode.com/problems/${slug}/`,
      leetcodeId: Number.parseInt(p.code, 10) || null,
    };
  });
  const verified = problems.length === expected;
  const sheet = { id, name, source: SOURCE, fetchedAt: new Date().toISOString(), verified, problems };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(sheet, null, 2) + '\n');
  console.log(`${id}: ${problems.length} problems${verified ? '' : ` (expected ${expected} — marked unverified)`}`);
}

build('neetcode150', 'NeetCode 150', 'neetcode150', 150);
build('blind75', 'Blind 75', 'blind75', 75);
