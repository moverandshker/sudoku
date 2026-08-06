const E = require('./engine.js');

function stats(a) {
  a = a.slice().sort((x, y) => x - y);
  const q = p => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { n: a.length, min: a[0], p10: q(.1), med: q(.5), p90: q(.9), max: a[a.length - 1] };
}

const N = parseInt(process.argv[2] || '25', 10);
for (const band of E.BAND_ORDER) {
  const scores = [], times = [], clues = [], hard = {};
  let fails = 0, notUnique = 0, mismatch = 0;
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    const p = E.generate(band, 1000 + i * 7919, { budgetMs: 6000 });
    const dt = Date.now() - t0;
    if (!p) { fails++; continue; }
    times.push(dt);
    scores.push(p.score);
    clues.push(p.clues);
    hard[p.hardest] = (hard[p.hardest] || 0) + 1;
    // verify exactly one solution
    if (E.countSolutions(Int8Array.from(p.puzzle), 2) !== 1) notUnique++;
    // verify the stored solution actually matches + is a valid grid
    const s = p.solution;
    for (let k = 0; k < 81; k++) if (p.puzzle[k] && p.puzzle[k] !== s[k]) mismatch++;
    for (let u = 0; u < 27; u++) {
      const seen = new Set();
      for (const c of E.UNITS[u]) seen.add(s[c]);
      if (seen.size !== 9 || seen.has(0)) mismatch++;
    }
  }
  console.log(`\n== ${band} ==  fails=${fails} notUnique=${notUnique} invalid=${mismatch}`);
  console.log('  score  ', JSON.stringify(stats(scores)));
  console.log('  gen ms ', JSON.stringify(stats(times)));
  console.log('  clues  ', JSON.stringify(stats(clues)));
  console.log('  hardest', JSON.stringify(hard));
}
