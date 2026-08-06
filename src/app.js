/* ============================================================
   Sudoku — offline PWA. No network, no accounts, no telemetry.
   All state lives in this browser only.
   ============================================================ */
(function () {
  'use strict';
  const E = self.SudokuEngine;
  const $ = s => document.querySelector(s);
  const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n; };

  /* ---------------- storage (never throws) ---------------- */
  const mem = {};
  const store = {
    get(k, dflt) {
      try { const v = localStorage.getItem('sud.' + k); return v == null ? dflt : JSON.parse(v); }
      catch (e) { return k in mem ? mem[k] : dflt; }
    },
    set(k, v) {
      mem[k] = v;
      try { localStorage.setItem('sud.' + k, JSON.stringify(v)); } catch (e) { /* private mode / full */ }
    },
    del(k) { delete mem[k]; try { localStorage.removeItem('sud.' + k); } catch (e) {} }
  };

  /* ---------------- settings ---------------- */
  const DEFAULTS = {
    theme: 'auto',
    highlightPeers: false,      // Hendrik: off by default
    highlightSame: false,
    highlightNotes: true,       // bold the selected digit inside notes
    autoCandidates: false,
    autoClearNotes: true,
    mistakes: 'off',            // off | conflicts | solution
    showTimer: true,
    autoPause: true,
    haptics: true,
    checkin: true,              // post-solve 1-5 rating
    symmetric: true,
    lastBand: 'steady'
  };
  let S = Object.assign({}, DEFAULTS, store.get('settings', {}));
  const saveSettings = () => store.set('settings', S);

  function applyTheme() {
    const t = S.theme === 'auto'
      ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : S.theme;
    document.documentElement.setAttribute('data-theme', t);
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t === 'light' ? '#f4f6f9' : '#0e1013');
  }
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

  const buzz = ms => { if (S.haptics && navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) {} } };

  /* ---------------- generator worker ---------------- */
  let worker = null, workerJobs = {}, jobSeq = 0;
  function startWorker() {
    try {
      const src = document.getElementById('engine-src').textContent +
        '\nself.onmessage=function(e){var d=e.data;if(d.type==="gen"){' +
        'var p=self.SudokuEngine.generate(d.band,d.seed,{symmetric:d.symmetric,budgetMs:12000});' +
        'self.postMessage({type:"gen",id:d.id,band:d.band,puzzle:p});}};';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = e => {
        const j = workerJobs[e.data.id];
        if (j) { delete workerJobs[e.data.id]; j(e.data.puzzle); }
      };
      worker.onerror = () => { worker = null; };
    } catch (e) { worker = null; }
  }
  function genPuzzle(band, cb) {
    const seed = (Math.random() * 4294967295) >>> 0;
    if (worker) {
      const id = ++jobSeq;
      workerJobs[id] = cb;
      worker.postMessage({ type: 'gen', band, seed, id, symmetric: S.symmetric });
    } else {
      setTimeout(() => cb(E.generate(band, seed, { symmetric: S.symmetric, budgetMs: 12000 })), 10);
    }
  }

  /* --------- puzzle pre-cache so "new game" is instant --------- */
  let cache = store.get('cache', {});
  function topUpCache() {
    for (const b of E.BAND_ORDER) {
      if (!cache[b] || !cache[b].length) {
        genPuzzle(b, p => {
          if (!p) return;
          cache[b] = (cache[b] || []).concat([p]);
          store.set('cache', cache);
        });
        return;  // one at a time, keeps the phone cool
      }
    }
  }
  function takeCached(band) {
    if (cache[band] && cache[band].length) {
      const p = cache[band].shift();
      store.set('cache', cache);
      setTimeout(topUpCache, 400);
      return p;
    }
    return null;
  }

  /* ---------------- game state ---------------- */
  let G = null;             // current game
  let sel = -1;
  let notesMode = false;
  let undoStack = [];
  let pendingHint = null, hintStage = 0;
  let tickHandle = null;

  function newGameFrom(p) {
    G = {
      band: p.band, label: p.label, score: p.score, hardest: p.hardest,
      clues: p.clues, seed: p.seed,
      puzzle: p.puzzle.slice(), solution: p.solution.slice(),
      values: p.puzzle.slice(),
      notes: new Array(81).fill(0),
      elapsed: 0, running: true, startedAt: Date.now(),
      errors: 0, hints: 0, pausedMs: 0,
      createdAt: Date.now(), done: false
    };
    sel = -1; notesMode = false; undoStack = []; pendingHint = null; hintStage = 0;
    S.lastBand = p.band; saveSettings();
    saveGame(); renderAll(); startTick();
  }

  function startNewGame(band) {
    const cached = takeCached(band);
    if (cached) { newGameFrom(cached); closeSheet('#sheetMenu'); return; }
    showBusy(true);
    genPuzzle(band, p => {
      showBusy(false);
      if (!p) { toast('Could not build a puzzle in that band — try again.'); return; }
      newGameFrom(p); closeSheet('#sheetMenu');
    });
  }

  const saveGame = () => { if (G) store.set('game', G); };

  /* ---------------- rendering ---------------- */
  const board = $('#board');
  const cells = [];
  for (let i = 0; i < 81; i++) {
    const b = el('button', 'cell');
    b.dataset.i = i; b.dataset.r = E.ROW[i]; b.dataset.c = E.COL[i];
    const n = el('div', 'notes');
    for (let d = 1; d <= 9; d++) n.appendChild(el('span'));
    b.appendChild(n);
    b.appendChild(el('span', 'val'));
    board.appendChild(b);
    cells.push(b);
  }

  function conflictSet() {
    const bad = new Set();
    for (let u = 0; u < 27; u++) {
      const seen = {};
      for (const i of E.UNITS[u]) {
        const v = G.values[i];
        if (!v) continue;
        if (seen[v] != null) { bad.add(i); bad.add(seen[v]); } else seen[v] = i;
      }
    }
    return bad;
  }

  function renderBoard() {
    if (!G) return;
    const autoC = S.autoCandidates ? E.candidatesFor(G.values) : null;
    const bad = S.mistakes === 'conflicts' ? conflictSet() : null;
    const selVal = sel >= 0 ? G.values[sel] : 0;

    for (let i = 0; i < 81; i++) {
      const c = cells[i], v = G.values[i], given = G.puzzle[i] !== 0;
      c.className = 'cell' + (given ? ' given' : '');
      if (sel >= 0 && i !== sel) {
        if (S.highlightPeers && (E.ROW[i] === E.ROW[sel] || E.COL[i] === E.COL[sel] || E.BOX[i] === E.BOX[sel])) c.classList.add('peer');
        if (S.highlightSame && selVal && v === selVal) c.classList.add('same');
      }
      if (i === sel) c.classList.add('sel');

      let wrong = false;
      if (v && !given) {
        if (S.mistakes === 'solution') wrong = v !== G.solution[i];
        else if (S.mistakes === 'conflicts') wrong = bad.has(i);
      }
      if (wrong) c.classList.add('bad');

      const valEl = c.lastChild, notesEl = c.firstChild;
      valEl.textContent = v ? String(v) : '';
      const nm = v ? 0 : (autoC ? autoC[i] : G.notes[i]);
      notesEl.style.display = nm ? '' : 'none';
      if (nm) {
        for (let d = 1; d <= 9; d++) {
          const sp = notesEl.children[d - 1];
          const on = (nm & E.BIT[d]) !== 0;
          sp.textContent = on ? String(d) : '';
          sp.className = (on && S.highlightNotes && selVal === d) ? 'hi' : '';
        }
      }
    }
    if (pendingHint && hintStage >= 2) {
      const list = pendingHint.type === 'place' ? [pendingHint.cell] : pendingHint.elims.map(x => x.cell);
      list.forEach(i => cells[i].classList.add('hintcell'));
    }
  }

  function renderKeypad() {
    const pad = $('#keypad');
    pad.classList.toggle('notemode', notesMode);
    const counts = new Array(10).fill(0);
    if (G) for (let i = 0; i < 81; i++) if (G.values[i]) counts[G.values[i]]++;
    for (let d = 1; d <= 9; d++) {
      const k = pad.children[d - 1];
      k.firstChild.textContent = String(d);
      const left = 9 - counts[d];
      k.lastChild.textContent = notesMode ? '' : (left > 0 ? String(left) : '');
      k.classList.toggle('done', !notesMode && left <= 0);
    }
  }

  function renderTop() {
    if (!G) return;
    $('#mBand').textContent = G.label;
    $('#mSub').textContent = 'difficulty ' + G.score + ' · ' + G.clues + ' clues';
    $('#mTimer').classList.toggle('hidden-timer', !S.showTimer);
    $('#mTimer').textContent = fmt(elapsedMs());
    $('#btnNotes').classList.toggle('on', notesMode);
    $('#btnUndo').disabled = undoStack.length === 0;
    $('#pauseIcon').innerHTML = G.running
      ? '<rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect>'
      : '<path d="M7 4l12 8-12 8z"></path>';
    $('#pausedOverlay').classList.toggle('hide', G.running || G.done);
  }
  function renderAll() { renderBoard(); renderKeypad(); renderTop(); }

  /* ---------------- timer ---------------- */
  const elapsedMs = () => !G ? 0 : G.elapsed + (G.running ? Date.now() - G.startedAt : 0);
  function fmt(ms) {
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h ? h + ':' + String(m % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
             : m + ':' + String(s % 60).padStart(2, '0');
  }
  let lastPersist = 0;
  function startTick() {
    clearInterval(tickHandle);
    tickHandle = setInterval(() => {
      if (!G || !G.running || G.done) return;
      $('#mTimer').textContent = fmt(elapsedMs());
      // fold elapsed into the saved game every few seconds, so a reload
      // mid-solve loses at most that much of the clock
      const now = Date.now();
      if (now - lastPersist > 5000) {
        lastPersist = now;
        G.elapsed += now - G.startedAt; G.startedAt = now;
        saveGame();
      }
    }, 300);
  }
  function setRunning(on) {
    if (!G || G.done) return;
    if (on === G.running) return;
    if (on) { G.startedAt = Date.now(); G.running = true; }
    else { G.elapsed += Date.now() - G.startedAt; G.running = false; }
    saveGame(); renderTop();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (G && G.running) { setRunning(false); G.autoPaused = true; } }
    else if (G && G.autoPaused && S.autoPause) { G.autoPaused = false; }
    else if (G && G.autoPaused) { G.autoPaused = false; setRunning(true); }
  });

  /* ---------------- input ---------------- */
  board.addEventListener('click', e => {
    const t = e.target.closest('.cell');
    if (!t || !G || !G.running) return;
    const i = +t.dataset.i;
    sel = (sel === i) ? -1 : i;
    clearHint();
    renderBoard();
    renderKeypad();
  });

  function pushUndo(changes) { undoStack.push(changes); if (undoStack.length > 200) undoStack.shift(); }

  function enter(d) {
    if (!G || !G.running || G.done || sel < 0) { if (sel < 0) toast('Pick a square first.'); return; }
    if (G.puzzle[sel]) { buzz(8); return; }
    const changes = [];
    const snap = i => changes.push({ i, v: G.values[i], n: G.notes[i] });

    if (notesMode) {
      if (S.autoCandidates) { toast('Auto candidates is on — turn it off in the menu to write your own.'); return; }
      if (G.values[sel]) { toast('Clear the digit first.'); return; }
      snap(sel);
      G.notes[sel] ^= E.BIT[d];
    } else {
      snap(sel);
      if (G.values[sel] === d) { G.values[sel] = 0; }
      else {
        G.values[sel] = d;
        G.notes[sel] = 0;
        if (d !== G.solution[sel]) { G.errors++; buzz(30); }
        if (S.autoClearNotes) {
          for (const p of E.PEERS[sel]) if (G.notes[p] & E.BIT[d]) { snap(p); G.notes[p] &= ~E.BIT[d]; }
        }
      }
    }
    pushUndo(changes);
    clearHint();
    saveGame(); renderAll();
    checkDone();
  }

  function erase() {
    if (!G || !G.running || sel < 0 || G.puzzle[sel]) return;
    if (!G.values[sel] && !G.notes[sel]) return;
    pushUndo([{ i: sel, v: G.values[sel], n: G.notes[sel] }]);
    G.values[sel] = 0; G.notes[sel] = 0;
    clearHint(); saveGame(); renderAll();
  }

  function undo() {
    const ch = undoStack.pop();
    if (!ch) return;
    for (const c of ch) { G.values[c.i] = c.v; G.notes[c.i] = c.n; }
    clearHint(); saveGame(); renderAll();
  }

  /* ---------------- hints ---------------- */
  function clearHint() { pendingHint = null; hintStage = 0; }
  function hint() {
    if (!G || !G.running || G.done) return;
    if (!pendingHint) {
      const step = E.nextStep(G.values);
      if (!step) {
        const stuck = G.values.some((v, i) => v && v !== G.solution[i]);
        toast(stuck ? 'Something already placed is wrong — no logical step from here.' : 'No further logical step found.');
        return;
      }
      pendingHint = step; hintStage = 1; G.hints++;
      toast(step.type === 'place'
        ? 'There is a ' + step.name + ' available. Tap hint again to see where.'
        : 'A ' + step.name + ' lets you rule something out. Tap hint again to see where.');
      saveGame();
      return;
    }
    if (hintStage === 1) {
      hintStage = 2; renderBoard();
      toast(pendingHint.type === 'place' ? 'Here. Tap hint once more to fill it in.' : 'These squares. Tap hint again to apply it.');
      return;
    }
    // apply
    const changes = [];
    if (pendingHint.type === 'place') {
      changes.push({ i: pendingHint.cell, v: G.values[pendingHint.cell], n: G.notes[pendingHint.cell] });
      G.values[pendingHint.cell] = pendingHint.digit;
      G.notes[pendingHint.cell] = 0;
      if (S.autoClearNotes) for (const p of E.PEERS[pendingHint.cell]) if (G.notes[p] & E.BIT[pendingHint.digit]) { changes.push({ i: p, v: G.values[p], n: G.notes[p] }); G.notes[p] &= ~E.BIT[pendingHint.digit]; }
    } else {
      for (const x of pendingHint.elims) {
        if (G.notes[x.cell] & E.BIT[x.digit]) { changes.push({ i: x.cell, v: G.values[x.cell], n: G.notes[x.cell] }); G.notes[x.cell] &= ~E.BIT[x.digit]; }
      }
      if (!changes.length) toast('Those candidates are already ruled out in your notes.');
    }
    if (changes.length) pushUndo(changes);
    clearHint(); saveGame(); renderAll(); checkDone();
  }

  /* ---------------- completion ---------------- */
  function checkDone() {
    if (!G || G.done) return;
    let full = true, right = true;
    for (let i = 0; i < 81; i++) {
      if (!G.values[i]) { full = false; break; }
      if (G.values[i] !== G.solution[i]) right = false;
    }
    if (!full) return;
    if (!right) { toast('Board is full, but something is off.'); return; }
    G.done = true;
    G.elapsed = elapsedMs(); G.running = false;
    clearInterval(tickHandle);
    buzz([18, 60, 18]);
    const rec = {
      ts: Date.now(), band: G.band, label: G.label, score: G.score,
      hardest: G.hardest, clues: G.clues, ms: G.elapsed,
      errors: G.errors, hints: G.hints, rating: null
    };
    const recs = store.get('records', []);
    recs.push(rec); store.set('records', recs);
    store.del('game');
    showResult(rec, recs.length - 1);
    setTimeout(topUpCache, 600);
  }

  function showResult(rec, idx) {
    $('#rTime').textContent = fmt(rec.ms);
    $('#rPace').textContent = (rec.ms / 1000 / rec.score).toFixed(2) + 's';
    $('#rErr').textContent = rec.errors;
    $('#rHint').textContent = rec.hints;
    $('#rLead').textContent = rec.label + ' · difficulty ' + rec.score + ' · hardest step was a ' + rec.hardest;
    const recs = store.get('records', []).filter(r => r.band === rec.band);
    const best = Math.min.apply(null, recs.map(r => r.ms));
    $('#rBest').textContent = best === rec.ms && recs.length > 1 ? 'New best for ' + rec.label + '.' :
      recs.length > 1 ? 'Best ' + rec.label + ': ' + fmt(best) : '';
    $('#checkinBlock').classList.toggle('hide', !S.checkin);
    Array.from($('#rating').children).forEach(b => b.classList.remove('on'));
    $('#rating').dataset.idx = idx;
    $('#modalDone').classList.add('open');
  }
  $('#rating').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    Array.from($('#rating').children).forEach(x => x.classList.toggle('on', x === b));
    const recs = store.get('records', []);
    const idx = +$('#rating').dataset.idx;
    if (recs[idx]) { recs[idx].rating = +b.dataset.v; store.set('records', recs); }
  });

  /* ---------------- toast / busy ---------------- */
  let toastT = null;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function showBusy(on) { $('#modalBusy').classList.toggle('open', on); }

  /* ---------------- sheets ---------------- */
  const openSheet = s => { $('#toast').classList.remove('show'); $(s).classList.add('open'); };
  const closeSheet = s => { $(s).classList.remove('open'); };

  /* ---------------- settings UI ---------------- */
  function bindSwitch(id, key, after) {
    const n = $(id);
    const paint = () => n.classList.toggle('on', !!S[key]);
    n.parentElement.addEventListener('click', () => { S[key] = !S[key]; saveSettings(); paint(); if (after) after(); });
    paint();
  }
  function bindSeg(id, key, after) {
    const n = $(id);
    const paint = () => Array.from(n.children).forEach(b => b.classList.toggle('on', b.dataset.v === String(S[key])));
    n.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      S[key] = b.dataset.v; saveSettings(); paint(); if (after) after();
    });
    paint();
  }

  /* ---------------- stats ---------------- */
  const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  function dayKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function streak(recs) {
    const days = new Set(recs.map(r => dayKey(r.ts)));
    let n = 0, d = new Date();
    if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1);
    while (days.has(dayKey(d.getTime()))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  let chartBand = 'all';
  function renderStats() {
    const recs = store.get('records', []);
    $('#sTotal').textContent = recs.length;
    $('#sStreak').textContent = streak(recs);
    $('#sToday').textContent = recs.filter(r => dayKey(r.ts) === dayKey(Date.now())).length;

    const tb = $('#statTable'); tb.innerHTML = '';
    const head = el('tr');
    ['Band', 'n', 'Median', 'Best', 'Last 5', ''].forEach(h => head.appendChild(el('th', null, h)));
    tb.appendChild(head);
    for (const b of E.BAND_ORDER) {
      const rs = recs.filter(r => r.band === b);
      if (!rs.length) continue;
      const all = rs.map(r => r.ms);
      const last5 = rs.slice(-5).map(r => r.ms);
      const med = median(all), l5 = median(last5);
      const tr = el('tr');
      tr.appendChild(el('td', null, E.BANDS[b].label));
      tr.appendChild(el('td', null, String(rs.length)));
      tr.appendChild(el('td', null, fmt(med)));
      tr.appendChild(el('td', null, fmt(Math.min.apply(null, all))));
      tr.appendChild(el('td', null, fmt(l5)));
      const delta = med ? Math.round((l5 - med) / med * 100) : 0;
      const td = el('td', 'trend ' + (delta < 0 ? 'up' : delta > 0 ? 'down' : ''),
        rs.length < 4 ? '' : delta === 0 ? '–' : (delta < 0 ? '▼' : '▲') + Math.abs(delta) + '%');
      tr.appendChild(td);
      tb.appendChild(tr);
    }
    if (tb.children.length === 1) { const tr = el('tr'); const td = el('td', null, 'No solves logged yet.'); td.colSpan = 6; td.style.color = 'var(--muted)'; tr.appendChild(td); tb.appendChild(tr); }

    renderChart(recs);

    const log = $('#log'); log.innerHTML = '';
    recs.slice(-40).reverse().forEach(r => {
      const e = el('div', 'entry');
      const d = new Date(r.ts);
      e.appendChild(el('div', 'when', d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })));
      e.appendChild(el('div', 'b', r.label + ' · ' + r.score + (r.rating ? ' · felt ' + r.rating + '/5' : '') + (r.errors ? ' · ' + r.errors + ' err' : '') + (r.hints ? ' · ' + r.hints + ' hint' : '')));
      e.appendChild(el('div', 't', fmt(r.ms)));
      log.appendChild(e);
    });
    if (!recs.length) log.appendChild(el('div', 'chart-note', 'Solve a puzzle and it will show up here.'));
  }

  function renderChart(recs) {
    const box = $('#chart');
    const data = (chartBand === 'all' ? recs : recs.filter(r => r.band === chartBand));
    const vals = data.map(r => chartBand === 'all' ? r.ms / 1000 / r.score : r.ms / 1000);
    const note = $('#chartNote');
    if (vals.length < 2) {
      box.innerHTML = '<div class="chart-note">Two or more solves needed to draw a trend.</div>';
      note.textContent = '';
      return;
    }
    const W = 320, H = 150, PL = 38, PR = 8, PT = 10, PB = 20;
    const iw = W - PL - PR, ih = H - PT - PB;
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi === lo) { hi = lo + 1; }
    const pad = (hi - lo) * 0.12; lo = Math.max(0, lo - pad); hi = hi + pad;
    const x = i => PL + (vals.length === 1 ? iw / 2 : i * iw / (vals.length - 1));
    const y = v => PT + ih - (v - lo) / (hi - lo) * ih;

    // rolling median, window 5
    const roll = vals.map((_, i) => {
      const a = vals.slice(Math.max(0, i - 4), i + 1);
      return median(a);
    });

    const fmtY = v => chartBand === 'all' ? v.toFixed(2) : fmt(v * 1000);
    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img">';
    for (let k = 0; k <= 3; k++) {
      const v = lo + (hi - lo) * k / 3, yy = y(v);
      svg += '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + yy.toFixed(1) + '" y2="' + yy.toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>';
      svg += '<text x="' + (PL - 6) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end" font-size="9" fill="var(--muted)">' + fmtY(v) + '</text>';
    }
    svg += '<polyline fill="none" stroke="#f2a65a" stroke-width="1.8" stroke-linejoin="round" points="' +
      roll.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ') + '"/>';
    vals.forEach((v, i) => { svg += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2.6" fill="var(--accent)"/>'; });
    const d0 = new Date(data[0].ts), d1 = new Date(data[data.length - 1].ts);
    const dl = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    svg += '<text x="' + PL + '" y="' + (H - 5) + '" font-size="9" fill="var(--muted)">' + dl(d0) + '</text>';
    svg += '<text x="' + (W - PR) + '" y="' + (H - 5) + '" font-size="9" fill="var(--muted)" text-anchor="end">' + dl(d1) + '</text>';
    svg += '</svg>';
    box.innerHTML = svg;

    const first = median(vals.slice(0, Math.max(3, Math.ceil(vals.length / 3))));
    const last = median(vals.slice(-Math.max(3, Math.ceil(vals.length / 3))));
    const pct = first ? Math.round((last - first) / first * 100) : 0;
    note.innerHTML = (chartBand === 'all'
      ? 'Pace — seconds per point of puzzle difficulty. Comparable across bands. '
      : 'Solve time, ' + E.BANDS[chartBand].label + ' only. ') +
      '<br>Blue dots are solves, orange is a 5-solve rolling median. ' +
      (Math.abs(pct) < 3 ? 'Flat over the logged range.' : (pct < 0 ? 'Down ' : 'Up ') + Math.abs(pct) + '% from the earliest third to the most recent third.');
  }

  /* ---------------- export / import ---------------- */
  function toCSV(recs) {
    const head = ['datetime_local', 'iso', 'band', 'difficulty_score', 'hardest_technique', 'clues', 'seconds', 'pace_sec_per_point', 'errors', 'hints', 'rating_1_5'];
    const rows = recs.map(r => [
      new Date(r.ts).toLocaleString(), new Date(r.ts).toISOString(), r.band, r.score,
      r.hardest, r.clues, (r.ms / 1000).toFixed(1), (r.ms / 1000 / r.score).toFixed(3),
      r.errors, r.hints, r.rating == null ? '' : r.rating
    ]);
    return [head].concat(rows).map(r => r.map(v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(',')).join('\n');
  }
  function download(name, text, mime) {
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: mime }));
      a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    } catch (e) { toast('Download blocked — copy the text instead.'); }
  }

  /* ---------------- wiring ---------------- */
  const pad = $('#keypad');
  for (let d = 1; d <= 9; d++) {
    const k = el('button', 'key');
    k.appendChild(el('span', 'd', String(d)));
    k.appendChild(el('span', 'left', ''));
    k.addEventListener('click', () => enter(d));
    pad.appendChild(k);
  }
  $('#btnUndo').addEventListener('click', undo);
  $('#btnErase').addEventListener('click', erase);
  $('#btnNotes').addEventListener('click', () => { notesMode = !notesMode; renderKeypad(); renderTop(); buzz(6); });
  $('#btnHint').addEventListener('click', hint);
  $('#btnPause').addEventListener('click', () => { if (G) setRunning(!G.running); });
  $('#pausedOverlay').addEventListener('click', () => setRunning(true));
  $('#btnMenu').addEventListener('click', () => { if (G && G.running) setRunning(false); openSheet('#sheetMenu'); });
  $('#btnStats').addEventListener('click', () => { renderStats(); openSheet('#sheetStats'); });
  $('#closeMenu').addEventListener('click', () => closeSheet('#sheetMenu'));
  $('#closeStats').addEventListener('click', () => closeSheet('#sheetStats'));

  $('#bandPick').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    Array.from($('#bandPick').children).forEach(x => x.classList.toggle('on', x === b));
  });
  $('#btnStart').addEventListener('click', () => {
    const b = $('#bandPick').querySelector('.on');
    startNewGame(b ? b.dataset.v : 'steady');
  });
  $('#btnResume').addEventListener('click', () => { closeSheet('#sheetMenu'); setRunning(true); });

  $('#chartPick').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    chartBand = b.dataset.v;
    Array.from($('#chartPick').children).forEach(x => x.classList.toggle('on', x === b));
    renderChart(store.get('records', []));
  });

  $('#btnCSV').addEventListener('click', () => {
    const recs = store.get('records', []);
    if (!recs.length) return toast('Nothing logged yet.');
    const csv = toCSV(recs);
    $('#exportBox').value = csv;
    $('#exportBox').classList.remove('hide');
    download('sudoku-log-' + dayKey(Date.now()) + '.csv', csv, 'text/csv');
  });
  $('#btnJSON').addEventListener('click', () => {
    const recs = store.get('records', []);
    const js = JSON.stringify({ version: 1, exported: new Date().toISOString(), records: recs }, null, 1);
    $('#exportBox').value = js;
    $('#exportBox').classList.remove('hide');
    download('sudoku-log-' + dayKey(Date.now()) + '.json', js, 'application/json');
  });
  $('#btnCopy').addEventListener('click', async () => {
    const v = $('#exportBox').value;
    if (!v) return toast('Export something first.');
    try { await navigator.clipboard.writeText(v); toast('Copied.'); }
    catch (e) { $('#exportBox').select(); toast('Select-all and copy manually.'); }
  });
  $('#btnImport').addEventListener('click', () => {
    const v = $('#exportBox').value.trim();
    if (!v) return toast('Paste an exported JSON blob into the box first.');
    try {
      const o = JSON.parse(v);
      const inc = Array.isArray(o) ? o : o.records;
      if (!Array.isArray(inc)) throw 0;
      const cur = store.get('records', []);
      const seen = new Set(cur.map(r => r.ts));
      let added = 0;
      inc.forEach(r => { if (r && r.ts && !seen.has(r.ts)) { cur.push(r); added++; } });
      cur.sort((a, b) => a.ts - b.ts);
      store.set('records', cur);
      renderStats();
      toast('Merged ' + added + ' record' + (added === 1 ? '' : 's') + '.');
    } catch (e) { toast('That is not a valid export.'); }
  });
  $('#btnWipe').addEventListener('click', () => {
    if ($('#btnWipe').dataset.armed) {
      store.del('records'); store.del('game'); mem.records = [];
      renderStats(); toast('History erased.');
      $('#btnWipe').dataset.armed = ''; $('#btnWipe').textContent = 'Erase all history';
    } else {
      $('#btnWipe').dataset.armed = '1';
      $('#btnWipe').textContent = 'Tap again to confirm — this cannot be undone';
      setTimeout(() => { $('#btnWipe').dataset.armed = ''; $('#btnWipe').textContent = 'Erase all history'; }, 5000);
    }
  });

  $('#doneNew').addEventListener('click', () => { $('#modalDone').classList.remove('open'); startNewGame(G ? G.band : S.lastBand); });
  $('#doneStats').addEventListener('click', () => { $('#modalDone').classList.remove('open'); renderStats(); openSheet('#sheetStats'); });

  bindSwitch('#swPeers', 'highlightPeers', renderBoard);
  bindSwitch('#swSame', 'highlightSame', renderBoard);
  bindSwitch('#swNoteHi', 'highlightNotes', renderBoard);
  bindSwitch('#swAutoC', 'autoCandidates', renderBoard);
  bindSwitch('#swClearNotes', 'autoClearNotes');
  bindSwitch('#swTimer', 'showTimer', renderTop);
  bindSwitch('#swAutoPause', 'autoPause');
  bindSwitch('#swHaptics', 'haptics');
  bindSwitch('#swCheckin', 'checkin');
  bindSwitch('#swSym', 'symmetric');
  bindSeg('#segTheme', 'theme', applyTheme);
  bindSeg('#segMistakes', 'mistakes', renderBoard);

  // desktop keyboard (handy for testing, harmless on iOS)
  document.addEventListener('keydown', e => {
    if (!G) return;
    if (e.key >= '1' && e.key <= '9') { enter(+e.key); e.preventDefault(); }
    else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') { erase(); e.preventDefault(); }
    else if (e.key.toLowerCase() === 'n') { notesMode = !notesMode; renderKeypad(); renderTop(); }
    else if (e.key.toLowerCase() === 'h') hint();
    else if (e.key.toLowerCase() === 'u') undo();
    else if (e.key.startsWith('Arrow') && sel >= 0) {
      let r = E.ROW[sel], c = E.COL[sel];
      if (e.key === 'ArrowUp') r = (r + 8) % 9;
      if (e.key === 'ArrowDown') r = (r + 1) % 9;
      if (e.key === 'ArrowLeft') c = (c + 8) % 9;
      if (e.key === 'ArrowRight') c = (c + 1) % 9;
      sel = r * 9 + c; renderBoard(); renderKeypad(); e.preventDefault();
    }
  });

  // stop iOS pinch-zoom. (double-tap zoom is handled by touch-action: manipulation in CSS,
  // which does not swallow the second tap the way a touchend preventDefault would)
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('gesturechange', e => e.preventDefault());

  /* ---------------- boot ---------------- */
  applyTheme();
  startWorker();

  const saved = store.get('game', null);
  if (saved && !saved.done) {
    G = saved;
    if (G.running) { G.elapsed += 0; G.startedAt = Date.now(); }  // resume where we left off, clock restarts now
    renderAll(); startTick();
  } else {
    // first run: build something immediately
    showBusy(true);
    genPuzzle(S.lastBand || 'steady', p => {
      showBusy(false);
      if (p) newGameFrom(p);
      else toast('Generator failed to start.');
    });
  }
  Array.from($('#bandPick').children).forEach(x => x.classList.toggle('on', x.dataset.v === (S.lastBand || 'steady')));
  setTimeout(topUpCache, 1500);

  // service worker: only meaningful when served over http(s)
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  // web app manifest, built at runtime so the file stays self-contained
  try {
    const base = location.href.split('?')[0];
    const mf = {
      name: 'Sudoku', short_name: 'Sudoku', start_url: base, scope: base.replace(/[^/]*$/, ''),
      display: 'standalone', background_color: '#0e1013', theme_color: '#0e1013', orientation: 'portrait',
      icons: [{ src: document.querySelector('link[rel="apple-touch-icon"]').href, sizes: '180x180', type: 'image/png', purpose: 'any' }]
    };
    document.getElementById('manifest').href = URL.createObjectURL(new Blob([JSON.stringify(mf)], { type: 'application/manifest+json' }));
  } catch (e) {}
})();
