# Sudoku — a private, offline sudoku for iOS (and anything else with a browser)

One HTML file. No ads, no accounts, no analytics, no fonts or scripts pulled from a CDN,
no network requests of any kind after the page loads. Puzzles are generated on the device.
Your solve log lives in the browser's local storage and nowhere else.

Verified in an automated run on an iPhone-sized viewport: **zero outbound requests, zero console errors.**

---

## Getting it on your iPhone

iOS has no F-Droid, so the practical route is a **home-screen web app**. It gets its own icon,
launches full-screen with no Safari chrome, and works with the phone in airplane mode.

### Option A — GitHub Pages (recommended, ~5 minutes, free, permanent)

1. Create a new **public** repo on github.com, e.g. `sudoku`.
2. Upload `index.html`, `sw.js`, `icon180.png`, `icon512.png` to the root of it.
3. Repo → **Settings → Pages** → Source: *Deploy from a branch*, Branch: `main` / `root` → Save.
4. Wait a minute, then open `https://<your-username>.github.io/sudoku/` in **Safari** on the iPhone.
5. Share button → **Add to Home Screen**.

That's it. After the first load the service worker caches everything, so it runs offline forever.

### Option B — any static host you already have

Drop the same four files anywhere that serves HTTPS (your own box, Netlify drop, Cloudflare Pages,
a Tailscale-only nginx). Same Add-to-Home-Screen step. HTTPS is required for the service worker;
without it the app still works, it just won't cache itself for offline use.

### Option C — no hosting at all

Put `index.html` in iCloud Drive / Files and open it from there. It plays fine, but iOS won't let
you Add-to-Home-Screen a `file://` URL, so you get a Safari tab rather than an app.

### Why the home screen matters for your tracking

Safari clears script-writable storage for sites you haven't visited in ~7 days. Home-screen web apps
get their own storage and aren't subject to that sweep. Install it properly, and still export your log
to CSV every few weeks — Stats → Export CSV. Belt and braces.

---

## What's in it

**Board**
- Row/column/box highlighting is **off by default** — toggle in Menu → Board if you ever want it.
- Matching-digit highlighting also off by default.
- Pencil marks, hand-written or auto-generated (Menu → Assistance → Auto candidate marks).
- Placing a digit optionally strips it from the pencil marks of its row, column and box.
- Mistake display: off / conflicts only / against the solution. Off by default.
- Tapping the same digit twice clears the square. Undo is unlimited within a puzzle.
- Digit keys show how many of each number are still unplaced.

**Difficulty that actually means something**

Every generated puzzle is solved by a logical solver that only uses named human techniques —
naked and hidden singles, locked candidates, naked/hidden pairs and triples, naked quads,
X-wing, XY-wing, XYZ-wing, swordfish, jellyfish, simple colouring. Each technique carries a cost.
The puzzle's **difficulty score** is the summed cost of the solve path, and the band is set by the
hardest technique the puzzle actually requires.

A puzzle is only released if its score falls inside a narrow window for the band you asked for:

| Band | Hardest technique needed | Score window | Typical clues |
|---|---|---|---|
| Gentle | hidden single | 64–72 | 32–33 |
| Steady | locked candidates, pairs | 89–103 | 28–31 |
| Tough | triples, X-wing, XY-wing | 118–138 | 25–30 |
| Fiendish | XYZ-wing, swordfish, colouring | 148–176 | 23–32 |

That is the part that makes the times worth logging. Measured over 160 generated puzzles,
every one had exactly one solution, and within-band score spread was roughly ±10%.
Generation is a few hundred milliseconds; the app also keeps one puzzle per band pre-built
in the background so "new puzzle" is instant.

**Tracking**
- Every solve logs: timestamp, band, difficulty score, hardest technique, clue count,
  seconds, wrong entries, hints used, and an optional 1–5 "how did that feel" tap.
- **Pace** = seconds per point of difficulty. This is the cross-band comparable number —
  it's what the default chart plots, with a 5-solve rolling median over the top.
- Per-band table: n, median, best, last-5 median, and the drift between them.
- Day streak, total solved, today's count.
- Export CSV or JSON, copy to clipboard, or merge a JSON export back in (dedupes by timestamp).
- Erase-everything button that means it.

The timer pauses when you switch away from the app, so an interruption doesn't corrupt the number.

**Hints** work in three taps: name the technique, then show you where, then apply it.
The hint engine uses the same solver as the grader, so it never guesses — if it says there's an
XY-wing, there's an XY-wing.

---

## Source

- `engine.js` — geometry, bitmask solver, the technique ladder, grader, generator. No dependencies.
- `app.js` — UI, state, storage, stats, chart.
- `styles.css` — theme and layout.
- `shell.html` — the page template.
- `build.js` — inlines all of the above into `dist/index.html` and writes `dist/sw.js`.
- `test.js` — generates puzzles across bands and verifies uniqueness, validity, score spread and timing.
- `uitest.js` — headless iPhone-viewport run: taps through play, notes, undo, hints, completion, stats, export; asserts no external requests.

Rebuild with `node build.js`. No npm install needed for the build; `uitest.js` wants `playwright`.

To tune the difficulty windows, edit `BANDS` near the bottom of `engine.js` and re-run
`node test.js 40` to see the resulting distributions.

---

## Non-FOSS alternative, if you'd rather not host anything

`SwiftSuDoKu` by Rasmus Kramer is on the App Store, free, MPL-2.0 licensed with source on GitHub,
and its App Privacy label reads "The developer does not collect any data from this app."
It's the cleanest existing option I found. You're still running someone else's signed binary,
which is exactly the thing you're chafing at — but it's there.
