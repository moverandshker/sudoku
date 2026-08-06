/* ============================================================
   sudoku engine — generator, human-technique solver, grader
   pure JS, no deps. usable in a worker or node.
   grid: Int8Array(81), 0 = empty, 1..9 = digit
   cands: Uint16Array(81), bit (d-1) set = digit d possible
   ============================================================ */
(function (root) {
  'use strict';

  // ---------- geometry ----------
  const ROW = new Int8Array(81), COL = new Int8Array(81), BOX = new Int8Array(81);
  for (let i = 0; i < 81; i++) {
    ROW[i] = (i / 9) | 0;
    COL[i] = i % 9;
    BOX[i] = ((ROW[i] / 3) | 0) * 3 + ((COL[i] / 3) | 0);
  }
  // 27 units: 0-8 rows, 9-17 cols, 18-26 boxes
  const UNITS = [];
  for (let r = 0; r < 9; r++) { const u = []; for (let c = 0; c < 9; c++) u.push(r * 9 + c); UNITS.push(u); }
  for (let c = 0; c < 9; c++) { const u = []; for (let r = 0; r < 9; r++) u.push(r * 9 + c); UNITS.push(u); }
  for (let b = 0; b < 9; b++) {
    const u = [], br = ((b / 3) | 0) * 3, bc = (b % 3) * 3;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) u.push((br + r) * 9 + bc + c);
    UNITS.push(u);
  }
  const UNITS_OF = [];   // cell -> [rowUnit, colUnit, boxUnit]
  for (let i = 0; i < 81; i++) UNITS_OF.push([ROW[i], 9 + COL[i], 18 + BOX[i]]);
  const PEERS = [];      // cell -> 20 peers
  const PEERMASK = [];   // cell -> Set-like Uint8Array(81)
  for (let i = 0; i < 81; i++) {
    const s = new Set();
    for (const u of UNITS_OF[i]) for (const j of UNITS[u]) if (j !== i) s.add(j);
    PEERS.push(Array.from(s));
    const m = new Uint8Array(81); for (const j of s) m[j] = 1; PEERMASK.push(m);
  }
  const sees = (a, b) => a !== b && PEERMASK[a][b] === 1;

  // ---------- bit helpers ----------
  const BIT = new Uint16Array(10);
  for (let d = 1; d <= 9; d++) BIT[d] = 1 << (d - 1);
  const ALL = 0x1ff;
  const POPCNT = new Uint8Array(512);
  for (let m = 0; m < 512; m++) POPCNT[m] = (m & 1) + POPCNT[m >> 1];
  function bitsOf(mask) { const out = []; for (let d = 1; d <= 9; d++) if (mask & BIT[d]) out.push(d); return out; }
  function lowestDigit(mask) { for (let d = 1; d <= 9; d++) if (mask & BIT[d]) return d; return 0; }

  // ---------- rng (seedable, so puzzles are reproducible) ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rnd) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // ---------- candidates ----------
  function computeCands(grid) {
    const c = new Uint16Array(81);
    for (let i = 0; i < 81; i++) {
      if (grid[i]) { c[i] = 0; continue; }
      let m = ALL;
      const p = PEERS[i];
      for (let k = 0; k < 20; k++) { const g = grid[p[k]]; if (g) m &= ~BIT[g]; }
      c[i] = m;
    }
    return c;
  }
  function place(grid, cands, i, d) {
    grid[i] = d; cands[i] = 0;
    const p = PEERS[i], nb = ~BIT[d];
    for (let k = 0; k < 20; k++) cands[p[k]] &= nb;
  }

  /* ---------- brute-force core ----------
     allocation-free: row/col/box masks with undo, MRV cell selection.
     `_g` is the shared working grid.
  */
  const _g = new Int8Array(81);
  const _rm = new Uint16Array(9), _cm = new Uint16Array(9), _bm = new Uint16Array(9);

  function loadMasks(grid) {
    _g.set(grid);
    _rm.fill(0); _cm.fill(0); _bm.fill(0);
    for (let i = 0; i < 81; i++) {
      const d = _g[i];
      if (!d) continue;
      const b = BIT[d];
      _rm[ROW[i]] |= b; _cm[COL[i]] |= b; _bm[BOX[i]] |= b;
    }
  }
  function pickMRV() {
    let best = -1, bestN = 10, bestMask = 0;
    for (let i = 0; i < 81; i++) {
      if (_g[i]) continue;
      const m = ALL & ~(_rm[ROW[i]] | _cm[COL[i]] | _bm[BOX[i]]);
      const n = POPCNT[m];
      if (n === 0) return { cell: -2, mask: 0 };      // dead end
      if (n < bestN) { bestN = n; best = i; bestMask = m; if (n === 1) break; }
    }
    return { cell: best, mask: bestMask };            // -1 = solved
  }
  function setCell(i, d) {
    const b = BIT[d];
    _g[i] = d; _rm[ROW[i]] |= b; _cm[COL[i]] |= b; _bm[BOX[i]] |= b;
  }
  function clearCell(i, d) {
    const nb = ~BIT[d];
    _g[i] = 0; _rm[ROW[i]] &= nb; _cm[COL[i]] &= nb; _bm[BOX[i]] &= nb;
  }

  function countSolutions(grid, limit) {
    limit = limit || 2;
    loadMasks(grid);
    let found = 0;
    (function rec() {
      const { cell, mask } = pickMRV();
      if (cell === -2) return;
      if (cell === -1) { found++; return; }
      for (let d = 1; d <= 9; d++) {
        if (!(mask & BIT[d])) continue;
        setCell(cell, d);
        rec();
        clearCell(cell, d);
        if (found >= limit) return;
      }
    })();
    return found;
  }

  function solveOne(grid, rnd) {
    loadMasks(grid);
    let ok = false;
    (function rec() {
      const { cell, mask } = pickMRV();
      if (cell === -2) return;
      if (cell === -1) { ok = true; return; }
      let ds = bitsOf(mask);
      if (rnd) ds = shuffle(ds, rnd);
      for (const d of ds) {
        setCell(cell, d);
        rec();
        if (ok) return;
        clearCell(cell, d);
      }
    })();
    return ok ? Int8Array.from(_g) : null;
  }

  // ---------- full grid generator ----------
  function randomFullGrid(rnd) {
    return solveOne(new Int8Array(81), rnd);
  }

  /* ============================================================
     human techniques
     each returns null, or {cost, name, placed?, elims?}
     they mutate grid/cands when applied
     ============================================================ */

  const T = {};

  T.nakedSingle = function (g, c) {
    for (let i = 0; i < 81; i++) {
      if (g[i]) continue;
      if (POPCNT[c[i]] === 1) { place(g, c, i, lowestDigit(c[i])); return { cost: 1, name: 'naked single' }; }
    }
    return null;
  };

  T.hiddenSingle = function (g, c) {
    for (let u = 0; u < 27; u++) {
      const cells = UNITS[u];
      for (let d = 1; d <= 9; d++) {
        const b = BIT[d];
        let spot = -1, n = 0, filled = false;
        for (let k = 0; k < 9; k++) {
          const i = cells[k];
          if (g[i] === d) { filled = true; break; }
          if (c[i] & b) { n++; spot = i; if (n > 1) break; }
        }
        if (!filled && n === 1) { place(g, c, spot, d); return { cost: 2, name: 'hidden single' }; }
      }
    }
    return null;
  };

  // locked candidates: pointing (box -> line) and claiming (line -> box)
  T.lockedCandidates = function (g, c) {
    // pointing
    for (let b = 18; b < 27; b++) {
      const cells = UNITS[b];
      for (let d = 1; d <= 9; d++) {
        const bit = BIT[d];
        const spots = [];
        for (const i of cells) if (c[i] & bit) spots.push(i);
        if (spots.length < 2) continue;
        const r = ROW[spots[0]], col = COL[spots[0]];
        const sameRow = spots.every(i => ROW[i] === r);
        const sameCol = spots.every(i => COL[i] === col);
        if (sameRow) {
          let n = 0;
          for (const i of UNITS[r]) if (BOX[i] !== BOX[spots[0]] && (c[i] & bit)) { c[i] &= ~bit; n++; }
          if (n) return { cost: 4, name: 'pointing pair' };
        }
        if (sameCol) {
          let n = 0;
          for (const i of UNITS[9 + col]) if (BOX[i] !== BOX[spots[0]] && (c[i] & bit)) { c[i] &= ~bit; n++; }
          if (n) return { cost: 4, name: 'pointing pair' };
        }
      }
    }
    // claiming
    for (let u = 0; u < 18; u++) {
      const cells = UNITS[u];
      for (let d = 1; d <= 9; d++) {
        const bit = BIT[d];
        const spots = [];
        for (const i of cells) if (c[i] & bit) spots.push(i);
        if (spots.length < 2) continue;
        const bx = BOX[spots[0]];
        if (!spots.every(i => BOX[i] === bx)) continue;
        let n = 0;
        for (const i of UNITS[18 + bx]) {
          if (cells.indexOf(i) === -1 && (c[i] & bit)) { c[i] &= ~bit; n++; }
        }
        if (n) return { cost: 4, name: 'claiming' };
      }
    }
    return null;
  };

  function nakedSubset(g, c, k, cost, name) {
    for (let u = 0; u < 27; u++) {
      const cells = UNITS[u].filter(i => !g[i] && POPCNT[c[i]] >= 2 && POPCNT[c[i]] <= k);
      const L = cells.length;
      if (L <= k) continue;
      const idx = new Array(k).fill(0).map((_, t) => t);
      const rec = (start, depth, mask, chosen) => {
        if (depth === k) {
          if (POPCNT[mask] !== k) return null;
          let n = 0;
          for (const i of UNITS[u]) {
            if (chosen.indexOf(i) !== -1 || g[i]) continue;
            if (c[i] & mask) { c[i] &= ~mask; n++; }
          }
          return n ? { cost, name } : null;
        }
        for (let t = start; t < L; t++) {
          const nm = mask | c[cells[t]];
          if (POPCNT[nm] > k) continue;
          chosen.push(cells[t]);
          const r = rec(t + 1, depth + 1, nm, chosen);
          chosen.pop();
          if (r) return r;
        }
        return null;
      };
      void idx;
      const r = rec(0, 0, 0, []);
      if (r) return r;
    }
    return null;
  }

  function hiddenSubset(g, c, k, cost, name) {
    for (let u = 0; u < 27; u++) {
      const cells = UNITS[u];
      const digits = [];
      const posOf = {};
      for (let d = 1; d <= 9; d++) {
        const bit = BIT[d];
        let placed = false, mask = 0;
        for (let t = 0; t < 9; t++) {
          const i = cells[t];
          if (g[i] === d) { placed = true; break; }
          if (c[i] & bit) mask |= 1 << t;
        }
        if (placed) continue;
        const n = POPCNT[mask];
        if (n >= 2 && n <= k) { digits.push(d); posOf[d] = mask; }
      }
      const L = digits.length;
      if (L < k) continue;
      const rec = (start, depth, posMask, dMask) => {
        if (depth === k) {
          if (POPCNT[posMask] !== k) return null;
          let n = 0;
          for (let t = 0; t < 9; t++) {
            if (!(posMask & (1 << t))) continue;
            const i = cells[t];
            const keep = c[i] & dMask;
            if (c[i] !== keep) { c[i] = keep; n++; }
          }
          return n ? { cost, name } : null;
        }
        for (let t = start; t < L; t++) {
          const nm = posMask | posOf[digits[t]];
          if (POPCNT[nm] > k) continue;
          const r = rec(t + 1, depth + 1, nm, dMask | BIT[digits[t]]);
          if (r) return r;
        }
        return null;
      };
      const r = rec(0, 0, 0, 0);
      if (r) return r;
    }
    return null;
  }

  T.nakedPair = (g, c) => nakedSubset(g, c, 2, 5, 'naked pair');
  T.hiddenPair = (g, c) => hiddenSubset(g, c, 2, 6, 'hidden pair');
  T.nakedTriple = (g, c) => nakedSubset(g, c, 3, 8, 'naked triple');
  T.hiddenTriple = (g, c) => hiddenSubset(g, c, 3, 10, 'hidden triple');
  T.nakedQuad = (g, c) => nakedSubset(g, c, 4, 12, 'naked quad');

  // basic fish: X-Wing (n=2), Swordfish (n=3), Jellyfish (n=4)
  function fish(g, c, n, cost, name) {
    for (let d = 1; d <= 9; d++) {
      const bit = BIT[d];
      for (let dir = 0; dir < 2; dir++) {          // 0: rows as base, 1: cols as base
        const lines = [];
        for (let a = 0; a < 9; a++) {
          let mask = 0, cnt = 0;
          for (let b = 0; b < 9; b++) {
            const i = dir === 0 ? a * 9 + b : b * 9 + a;
            if (g[i] === d) { cnt = 99; break; }
            if (c[i] & bit) { mask |= 1 << b; cnt++; }
          }
          if (cnt >= 2 && cnt <= n) lines.push({ a, mask });
        }
        const L = lines.length;
        if (L < n) continue;
        const rec = (start, depth, mask, chosen) => {
          if (depth === n) {
            if (POPCNT[mask] !== n) return null;
            let elim = 0;
            for (let b = 0; b < 9; b++) {
              if (!(mask & (1 << b))) continue;
              for (let a = 0; a < 9; a++) {
                if (chosen.indexOf(a) !== -1) continue;
                const i = dir === 0 ? a * 9 + b : b * 9 + a;
                if (c[i] & bit) { c[i] &= ~bit; elim++; }
              }
            }
            return elim ? { cost, name } : null;
          }
          for (let t = start; t < L; t++) {
            const nm = mask | lines[t].mask;
            if (POPCNT[nm] > n) continue;
            chosen.push(lines[t].a);
            const r = rec(t + 1, depth + 1, nm, chosen);
            chosen.pop();
            if (r) return r;
          }
          return null;
        };
        const r = rec(0, 0, 0, []);
        if (r) return r;
      }
    }
    return null;
  }

  T.xWing = (g, c) => fish(g, c, 2, 14, 'X-wing');
  T.swordfish = (g, c) => fish(g, c, 3, 18, 'swordfish');
  T.jellyfish = (g, c) => fish(g, c, 4, 22, 'jellyfish');

  T.xyWing = function (g, c) {
    const bi = [];
    for (let i = 0; i < 81; i++) if (!g[i] && POPCNT[c[i]] === 2) bi.push(i);
    for (const p of bi) {
      const [a, b] = bitsOf(c[p]);
      for (const q of bi) {
        if (q === p || !sees(p, q)) continue;
        for (const r of bi) {
          if (r === p || r === q || !sees(p, r)) continue;
          const cq = c[q], cr = c[r];
          // q = {a,x}, r = {b,x}
          let x = 0;
          if ((cq & BIT[a]) && (cr & BIT[b])) {
            const xq = cq & ~BIT[a], xr = cr & ~BIT[b];
            if (xq === xr && xq !== BIT[b] && xq !== BIT[a]) x = lowestDigit(xq);
          }
          if (!x) continue;
          const bit = BIT[x];
          let elim = 0;
          for (let i = 0; i < 81; i++) {
            if (g[i] || i === p || i === q || i === r) continue;
            if (sees(i, q) && sees(i, r) && (c[i] & bit)) { c[i] &= ~bit; elim++; }
          }
          if (elim) return { cost: 16, name: 'XY-wing' };
        }
      }
    }
    return null;
  };

  T.xyzWing = function (g, c) {
    for (let p = 0; p < 81; p++) {
      if (g[p] || POPCNT[c[p]] !== 3) continue;
      const ds = bitsOf(c[p]);
      const pool = PEERS[p].filter(i => !g[i] && POPCNT[c[i]] === 2 && (c[i] & c[p]) === c[i]);
      for (let a = 0; a < pool.length; a++) {
        for (let b = a + 1; b < pool.length; b++) {
          const q = pool[a], r = pool[b];
          if ((c[q] | c[r]) !== c[p]) continue;
          const shared = c[q] & c[r];
          if (POPCNT[shared] !== 1) continue;
          const x = lowestDigit(shared), bit = BIT[x];
          let elim = 0;
          for (let i = 0; i < 81; i++) {
            if (g[i] || i === p || i === q || i === r) continue;
            if (sees(i, p) && sees(i, q) && sees(i, r) && (c[i] & bit)) { c[i] &= ~bit; elim++; }
          }
          if (elim) return { cost: 17, name: 'XYZ-wing' };
        }
      }
      void ds;
    }
    return null;
  };

  // simple colouring on conjugate pairs
  T.coloring = function (g, c) {
    for (let d = 1; d <= 9; d++) {
      const bit = BIT[d];
      // build conjugate-pair graph
      const adj = new Map();
      const addEdge = (i, j) => {
        if (!adj.has(i)) adj.set(i, []);
        if (!adj.has(j)) adj.set(j, []);
        adj.get(i).push(j); adj.get(j).push(i);
      };
      for (let u = 0; u < 27; u++) {
        const spots = [];
        let placed = false;
        for (const i of UNITS[u]) { if (g[i] === d) { placed = true; break; } if (c[i] & bit) spots.push(i); }
        if (!placed && spots.length === 2) addEdge(spots[0], spots[1]);
      }
      if (!adj.size) continue;
      const color = new Map();
      for (const start of adj.keys()) {
        if (color.has(start)) continue;
        const comp = [];
        color.set(start, 0); comp.push(start);
        const stack = [start];
        while (stack.length) {
          const i = stack.pop();
          for (const j of adj.get(i)) {
            if (!color.has(j)) { color.set(j, 1 - color.get(i)); comp.push(j); stack.push(j); }
          }
        }
        if (comp.length < 4) continue;
        const A = comp.filter(i => color.get(i) === 0);
        const B = comp.filter(i => color.get(i) === 1);
        // rule 2: two same-colour cells in one unit -> that colour is all false
        for (const set of [A, B]) {
          for (let x = 0; x < set.length; x++) for (let y = x + 1; y < set.length; y++) {
            if (sees(set[x], set[y])) {
              let elim = 0;
              for (const i of set) if (c[i] & bit) { c[i] &= ~bit; elim++; }
              if (elim) return { cost: 20, name: 'colouring' };
            }
          }
        }
        // rule 4: a cell seeing both colours can't be d
        let elim = 0;
        for (let i = 0; i < 81; i++) {
          if (g[i] || !(c[i] & bit) || color.has(i)) continue;
          const seesA = A.some(j => sees(i, j));
          const seesB = B.some(j => sees(i, j));
          if (seesA && seesB) { c[i] &= ~bit; elim++; }
        }
        if (elim) return { cost: 20, name: 'colouring' };
      }
    }
    return null;
  };

  const LADDER = [
    T.nakedSingle, T.hiddenSingle,
    T.lockedCandidates,
    T.nakedPair, T.hiddenPair,
    T.nakedTriple, T.hiddenTriple, T.nakedQuad,
    T.xWing, T.xyWing, T.xyzWing,
    T.swordfish, T.coloring, T.jellyfish
  ];

  /* ---------- grader ----------
     solves with human techniques only.
     returns {solved, hardest, hardestName, total, moves, counts}
     `total` is the effort score used for consistency banding.
  */
  function grade(puzzle) {
    const g = Int8Array.from(puzzle);
    const c = computeCands(g);
    let hardest = 0, hardestName = 'given', total = 0, moves = 0;
    const counts = Object.create(null);
    let guard = 0;
    while (guard++ < 2000) {
      let empty = 0;
      for (let i = 0; i < 81; i++) if (!g[i]) empty++;
      if (empty === 0) break;
      let step = null;
      for (const t of LADDER) { step = t(g, c); if (step) break; }
      if (!step) return { solved: false, hardest: 99, hardestName: 'beyond', total: 9999, moves, counts };
      total += step.cost;
      moves++;
      counts[step.name] = (counts[step.name] || 0) + 1;
      if (step.cost > hardest) { hardest = step.cost; hardestName = step.name; }
    }
    for (let i = 0; i < 81; i++) if (!g[i]) return { solved: false, hardest: 99, hardestName: 'beyond', total: 9999, moves, counts };
    return { solved: true, hardest, hardestName, total, moves, counts };
  }

  /* ---------- difficulty bands ----------
     hardest = cost of the hardest technique needed.
     total   = summed effort; keeps puzzles inside a band comparable.
  */
  const BANDS = {
    gentle:    { label: 'Gentle',    hardest: [1, 2],   total: [64, 72] },
    steady:    { label: 'Steady',    hardest: [4, 6],   total: [89, 103] },
    tough:     { label: 'Tough',     hardest: [8, 16],  total: [118, 138] },
    fiendish:  { label: 'Fiendish',  hardest: [17, 30], total: [148, 176] }
  };
  const BAND_ORDER = ['gentle', 'steady', 'tough', 'fiendish'];

  function bandOf(res) {
    if (!res.solved) return null;
    for (const k of BAND_ORDER) {
      const b = BANDS[k];
      if (res.hardest >= b.hardest[0] && res.hardest <= b.hardest[1]) return k;
    }
    return null;
  }

  /* ---------- digging ---------- */
  function dig(full, rnd, opts) {
    opts = opts || {};
    const symmetric = opts.symmetric !== false;
    const minClues = opts.minClues || 22;
    const g = Int8Array.from(full);
    const order = shuffle(Array.from({ length: 81 }, (_, i) => i), rnd);
    let clues = 81;
    for (const i of order) {
      if (clues <= minClues) break;
      const partner = 80 - i;
      const cells = symmetric && partner !== i ? [i, partner] : [i];
      if (cells.some(x => !g[x])) continue;
      if (clues - cells.length < minClues) continue;
      const saved = cells.map(x => g[x]);
      cells.forEach(x => { g[x] = 0; });
      if (countSolutions(g, 2) !== 1) {
        cells.forEach((x, k) => { g[x] = saved[k]; });
      } else {
        clues -= cells.length;
      }
    }
    return g;
  }

  /* ---------- generate a puzzle in a target band ---------- */
  function generate(bandKey, seed, opts) {
    opts = opts || {};
    const band = BANDS[bandKey] || BANDS.steady;
    const rnd = mulberry32(seed >>> 0);
    const budgetMs = opts.budgetMs || 8000;
    const t0 = Date.now();
    let fallback = null;

    for (let attempt = 0; attempt < 400; attempt++) {
      const full = randomFullGrid(rnd);
      const minClues = bandKey === 'gentle' ? 32 : bandKey === 'steady' ? 28 : 23;
      let puz = dig(full, rnd, { symmetric: opts.symmetric !== false, minClues });
      let res = grade(puz);

      // too hard (or unsolvable by logic): hand back clues until it lands
      let addBack = 0;
      while ((!res.solved || rankOf(res) > BAND_ORDER.indexOf(bandKey)) && addBack < 24) {
        const holes = [];
        for (let i = 0; i < 81; i++) if (!puz[i]) holes.push(i);
        if (!holes.length) break;
        const pick = holes[(rnd() * holes.length) | 0];
        puz[pick] = full[pick];
        addBack++;
        res = grade(puz);
      }

      if (res.solved) {
        const k = bandOf(res);
        if (k === bandKey) {
          if (res.total >= band.total[0] && res.total <= band.total[1]) {
            return finish(puz, full, res, bandKey, seed);
          }
          if (!fallback) fallback = { puz: Int8Array.from(puz), res };
          else {
            // keep whichever is closer to the band's centre
            const mid = (band.total[0] + band.total[1]) / 2;
            if (Math.abs(res.total - mid) < Math.abs(fallback.res.total - mid)) fallback = { puz: Int8Array.from(puz), res };
          }
        }
      }
      if (Date.now() - t0 > budgetMs && fallback) break;
    }
    if (fallback) return finish(fallback.puz, null, fallback.res, bandKey, seed);
    return null;
  }

  function rankOf(res) {
    if (!res.solved) return 99;
    const k = bandOf(res);
    return k ? BAND_ORDER.indexOf(k) : 99;
  }

  function finish(puz, full, res, bandKey, seed) {
    const sol = full || solveOne(puz);
    let clues = 0;
    for (let i = 0; i < 81; i++) if (puz[i]) clues++;
    return {
      puzzle: Array.from(puz),
      solution: Array.from(sol),
      band: bandKey,
      label: BANDS[bandKey].label,
      score: res.total,
      hardest: res.hardestName,
      hardestCost: res.hardest,
      moves: res.moves,
      clues,
      counts: res.counts,
      seed
    };
  }

  /* ---------- hint: what is the next logical step? ---------- */
  function nextStep(gridArr) {
    const g = Int8Array.from(gridArr);
    const c = computeCands(g);
    const before = Uint16Array.from(c);
    for (const t of LADDER) {
      const gg = Int8Array.from(g), cc = Uint16Array.from(c);
      const step = t(gg, cc);
      if (step) {
        // did it place a digit?
        for (let i = 0; i < 81; i++) if (!g[i] && gg[i]) return { type: 'place', cell: i, digit: gg[i], name: step.name };
        const elims = [];
        for (let i = 0; i < 81; i++) {
          const gone = before[i] & ~cc[i];
          if (gone) for (const d of bitsOf(gone)) elims.push({ cell: i, digit: d });
        }
        return { type: 'eliminate', name: step.name, elims };
      }
    }
    return null;
  }

  function candidatesFor(gridArr) {
    const g = Int8Array.from(gridArr);
    const c = computeCands(g);
    return Array.from(c);
  }

  const api = {
    generate, grade, nextStep, candidatesFor, countSolutions, solveOne,
    BANDS, BAND_ORDER, computeCands, PEERS, UNITS, ROW, COL, BOX, bitsOf, BIT
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SudokuEngine = api;
})(typeof self !== 'undefined' ? self : this);
