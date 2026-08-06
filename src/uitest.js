const { chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const DIST = __dirname + '/dist';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const f = path.join(DIST, p);
  if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});

(async () => {
  await new Promise(r => server.listen(8099, r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext(Object.assign({}, devices['iPhone 13'], { isMobile: true, hasTouch: true, colorScheme: 'dark' }));
  const page = await ctx.newPage();

  const external = [], errors = [], logs = [];
  page.on('request', r => { const u = r.url(); if (!u.startsWith('http://localhost:8099') && !u.startsWith('blob:') && !u.startsWith('data:')) external.push(u); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); else logs.push(m.text()); });

  await page.goto('http://localhost:8099/');
  await page.waitForFunction(() => document.querySelectorAll('.cell .val').length === 81, { timeout: 20000 });
  await page.waitForFunction(() => !document.getElementById('modalBusy').classList.contains('open'), { timeout: 30000 });
  await page.waitForTimeout(600);

  const info = await page.evaluate(() => ({
    band: document.getElementById('mBand').textContent,
    sub: document.getElementById('mSub').textContent,
    givens: Array.from(document.querySelectorAll('.cell')).filter(c => c.classList.contains('given')).length
  }));
  console.log('LOADED:', JSON.stringify(info));

  await page.screenshot({ path: 'shot-board.png' });

  // tap a cell + a digit
  const empty = await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('.cell')).find(x => !x.classList.contains('given'));
    return +c.dataset.i;
  });
  await page.locator(`.cell[data-i="${empty}"]`).tap();
  await page.locator('.key').nth(4).tap();          // digit 5
  const after = await page.evaluate(i => document.querySelectorAll('.cell')[i].lastChild.textContent, empty);
  console.log('ENTER DIGIT ->', JSON.stringify(after));

  // peer highlighting must be OFF by default
  const peers = await page.evaluate(() => document.querySelectorAll('.cell.peer').length);
  console.log('PEER-HIGHLIGHTED CELLS (expect 0):', peers);

  // notes mode on a different empty square
  const empty2 = await page.evaluate(i => {
    const c = Array.from(document.querySelectorAll('.cell')).filter(x => !x.classList.contains('given') && +x.dataset.i !== i);
    return +c[3].dataset.i;
  }, empty);
  await page.locator(`.cell[data-i="${empty2}"]`).tap();
  await page.locator('#btnNotes').tap();
  await page.locator('.key').nth(0).tap();
  await page.locator('.key').nth(2).tap();
  await page.locator('.key').nth(6).tap();
  const noteMask = await page.evaluate(i => {
    const g = JSON.parse(localStorage.getItem('sud.game'));
    return g.notes[i];
  }, empty2);
  console.log('NOTES bitmask for 1,3,7 (expect 69):', noteMask);
  await page.locator('#btnNotes').tap();
  await page.screenshot({ path: 'shot-notes.png' });

  // undo everything back to a clean board
  for (let i = 0; i < 6; i++) {
    if (await page.locator('#btnUndo').isDisabled()) break;
    await page.locator('#btnUndo').tap();
  }
  const clean = await page.evaluate(() => {
    const g = JSON.parse(localStorage.getItem('sud.game'));
    return g.values.every((v, i) => v === g.puzzle[i]) && g.notes.every(n => n === 0);
  });
  console.log('UNDO restored clean board:', clean);

  // hint chain
  await page.locator('#btnHint').tap(); await page.waitForTimeout(150);
  const h1 = await page.evaluate(() => document.getElementById('toast').textContent);
  await page.locator('#btnHint').tap(); await page.waitForTimeout(150);
  await page.locator('#btnHint').tap(); await page.waitForTimeout(150);
  const filled = await page.evaluate(() => Array.from(document.querySelectorAll('.cell')).filter(c => c.lastChild.textContent).length);
  console.log('HINT:', JSON.stringify(h1), '-> filled cells now', filled);

  // menu + settings render
  await page.locator('#btnMenu').tap(); await page.waitForTimeout(400);
  await page.screenshot({ path: 'shot-menu.png' });
  await page.locator('#closeMenu').tap(); await page.waitForTimeout(300);
  await page.locator('#pausedOverlay').tap();

  // --- auto-solve the puzzle to exercise completion + stats ---
  await page.evaluate(() => {
    const g = JSON.parse(localStorage.getItem('sud.game'));
    window.__sol = g.solution;
  });
  await page.evaluate(async () => {
    const g = JSON.parse(localStorage.getItem('sud.game'));
    const cells = document.querySelectorAll('.cell');
    for (let i = 0; i < 81; i++) {
      if (g.puzzle[i]) continue;
      const cur = JSON.parse(localStorage.getItem('sud.game')).values[i];
      if (cur === g.solution[i]) continue;   // already correct (e.g. filled by a hint)
      cells[i].click();
      document.querySelectorAll('.key')[g.solution[i] - 1].click();
    }
  });
  await page.waitForTimeout(500);
  const doneOpen = await page.evaluate(() => document.getElementById('modalDone').classList.contains('open'));
  console.log('COMPLETION MODAL:', doneOpen);
  await page.screenshot({ path: 'shot-done.png' });

  // rate it
  await page.locator('#rating button').nth(3).tap();
  await page.locator('#doneStats').tap();
  await page.waitForTimeout(500);

  // seed a few synthetic records so the chart has something to draw
  await page.evaluate(() => {
    const recs = JSON.parse(localStorage.getItem('sud.records') || '[]');
    const bands = ['gentle', 'steady', 'tough', 'fiendish'];
    const labels = { gentle: 'Gentle', steady: 'Steady', tough: 'Tough', fiendish: 'Fiendish' };
    const scores = { gentle: 67, steady: 94, tough: 127, fiendish: 160 };
    for (let i = 0; i < 22; i++) {
      const b = bands[i % 4];
      recs.push({
        ts: Date.now() - (22 - i) * 86400000 * 0.7,
        band: b, label: labels[b], score: scores[b], hardest: 'x', clues: 28,
        ms: (scores[b] * (5.2 - i * 0.06) + Math.sin(i) * 40) * 1000,
        errors: i % 3, hints: i % 5 === 0 ? 1 : 0, rating: 3 + (i % 3 === 0 ? 1 : 0)
      });
    }
    recs.sort((a, b) => a.ts - b.ts);
    localStorage.setItem('sud.records', JSON.stringify(recs));
  });
  await page.locator('#closeStats').tap(); await page.waitForTimeout(300);
  await page.locator('#btnStats').tap(); await page.waitForTimeout(500);
  await page.screenshot({ path: 'shot-stats.png', fullPage: false });
  await page.evaluate(() => document.querySelector('#sheetStats .body').scrollTop = 460);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'shot-stats2.png' });

  // CSV export sanity
  const csv = await page.evaluate(() => {
    document.getElementById('btnCSV').click();
    return document.getElementById('exportBox').value.split('\n').slice(0, 3).join('\n');
  });
  console.log('CSV HEAD:\n' + csv);

  // light theme shot
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('sud.settings') || '{}'); s.theme = 'light'; localStorage.setItem('sud.settings', JSON.stringify(s)); });
  await page.reload();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'shot-light.png' });

  console.log('\nEXTERNAL REQUESTS (expect none):', external.length ? external : 'NONE');
  console.log('ERRORS:', errors.length ? errors : 'none');

  await browser.close(); server.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
