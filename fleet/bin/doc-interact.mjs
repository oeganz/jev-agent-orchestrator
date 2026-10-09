#!/usr/bin/env node
// doc-interact: OPTIONAL real-browser smoke check for the project-doc HTML.
//
// Not part of any hermetic suite. Loads playwright-core from one of three
// known sibling node_modules trees (first one that exists wins) and runs an
// end-to-end click flow on every file passed as argv:
//   1. capture console errors + page errors;
//   2. click #reviewToggle and assert aria-pressed flips + label changes;
//   3. click a .side-btn for a non-initial page and assert the matching
//      .page-pane becomes .active;
//   4. mark three claims in a row with ONLY claim clicks + verdict clicks
//      (no click-away, no force, default playwright click semantics with a
//      5s timeout) - the regression test for T5: after a verdict, the
//      popover MUST close so the next claim click is not intercepted;
//   5. after each verdict, assert document.elementFromPoint at the centre
//      of the NEXT claim resolves to that claim (or one of its descendants)
//      and NOT to a popover/overlay - i.e. the page is not blocked;
//   6. open a fresh claim, press Escape, assert popover closed AND
//      document.activeElement is the originating claim (focus restoration);
//   7. export the reviews via the #reviewExport button, capture the
//      downloaded JSON via Playwright's download event, parse it, and
//      assert it contains exactly the three verdicts marked (round-trip);
//   8. import the same file into a FRESH page load and assert the three
//      claims are marked with the right verdicts (round-trip);
//   9. assert ZERO page errors were raised. Console errors are listed but
//      only `<g> attribute transform`, `Syntax error`, and any `Uncaught`
//      text are fatal.
//
// Exits 0 if all assertions PASS and zero fatal errors were captured.
// Exits 0 (NOT a failure) with a clear `SKIP:` line when neither a browser
// executable nor a usable playwright-core install is found, so callers
// can run this without it ever blocking CI.

import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

// ---------- locate playwright-core (first existing wins) ---------------------
// ROOT is Agent/Orchestrator. The vault root is two levels up; the
// canonical install location is <vault>/Infra/<tool>/node_modules.
// The operator can extend the search by setting the
// FLEET_PLAYWRIGHT_PATHS env var (semicolon-separated additional
// node_modules roots) without editing this file - the placeholder
// path the operator would have used (their personal node_modules
// tree) is intentionally not embedded here.
const VAULT = resolve(ROOT, '..', '..');
const PW_CANDIDATES = [
  join(VAULT, 'Infra', 'ganz-command-center', 'node_modules'),
  ...((process.env.FLEET_PLAYWRIGHT_PATHS || '').split(';').map((s) => s.trim()).filter(Boolean)),
];
const EXEC_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

function findPW() {
  for (const base of PW_CANDIDATES) {
    try {
      if (!existsSync(base)) continue;
      if (!statSync(base).isDirectory()) continue;
      const r = createRequire(join(base, 'noop.cjs'));
      const pkgPath = r.resolve('playwright-core/package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      return { base, require: r, pkg };
    } catch (_) { /* try next */ }
  }
  return null;
}
function findBrowser() {
  for (const p of EXEC_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

// ---------- argv / result aggregator ---------------------------------------
const args = process.argv.slice(2);
const files = args.filter(a => /\.(html|htm)$/i.test(a));
if (!files.length) {
  console.log('usage: node doc-interact.mjs <html> [<html> ...]');
  process.exit(2);
}

const FAIL_PATTERNS = [
  /<g>\s*attribute transform/i,
  /Syntax\s*error/i,
  /Uncaught/i,
];

// ---------- load playwright (or SKIP) ---------------------------------------
const pwLoc = findPW();
const browserPath = findBrowser();
if (!pwLoc || !browserPath) {
  console.log(`SKIP: doc-interact unavailable (playwright-core=${pwLoc ? 'ok' : 'MISSING'}, browser=${browserPath ? 'ok' : 'MISSING'})`);
  process.exit(0);
}

const pwPath = join(pwLoc.base, 'node_modules', 'playwright-core');
// playwright-core publishes its CJS entry via the package name; require it
// out of the discovered tree so we do not depend on Orchestrator's deps.
const pw = createRequire(join(pwLoc.base, 'noop.cjs'))('playwright-core');

// ---------- run --------------------------------------------------

function isFatal(msg) {
  return FAIL_PATTERNS.some(re => re.test(msg));
}

function pass(line) { console.log('PASS  ' + line); return true; }
function fail(line) { console.log('FAIL  ' + line); return false; }

// Read the JSON body of a Playwright Download as a string.
async function readDownloadText(download) {
  const p = await download.path();
  return readFileSync(p, 'utf8');
}

async function check(file) {
  const abs = resolve(file);
  if (!existsSync(abs)) return fail(`${file}: file not found`), { file, ok: false, reason: 'missing' };
  const url = pathToFileURL(abs).toString();
  const consoleErrs = [];
  const pageErrs = [];

  const browser = await pw.chromium.launch({ headless: true, executablePath: browserPath });
  let asserts = [];
  let overall = true;
  try {
    const page = await browser.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrs.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrs.push(String(err?.message || err)));

    await page.goto(url, { waitUntil: 'load' });
    // Wait until the inline script has run and bound its listeners. The
    // review toggle is wired synchronously inside the IIFE; we just need
    // it to exist in the DOM.
    await page.waitForSelector('#reviewToggle', { timeout: 5000 });
    // Start clean so the round-trip is reproducible across runs.
    await page.evaluate(() => { try { localStorage.clear(); } catch (_) {} });
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#reviewToggle', { timeout: 5000 });

    // (1) review toggle.
    const toggle = page.locator('#reviewToggle');
    const initialPressed = await toggle.getAttribute('aria-pressed');
    const initialLabel = (await toggle.textContent()).trim();
    await toggle.click();
    await page.waitForTimeout(50);
    const afterPressed = await toggle.getAttribute('aria-pressed');
    const afterLabel = (await toggle.textContent()).trim();
    const toggleFlipped = initialPressed !== afterPressed && initialLabel !== afterLabel;
    overall = overall && (toggleFlipped
      ? pass(`${file} #reviewToggle aria-pressed ${initialPressed}->${afterPressed}, label "${initialLabel}"->"${afterLabel}"`)
      : fail(`${file} #reviewToggle aria-pressed ${initialPressed}->${afterPressed}, label "${initialLabel}"->"${afterLabel}"`));
    asserts.push({ name: 'review toggle flips aria-pressed and label', ok: toggleFlipped });

    // (2) sidebar button to a non-initial page.
    const initialId = await page.evaluate(() => {
      const a = document.querySelector('.page-pane.active');
      return a ? a.id : null;
    });
    const sideBtns = await page.locator('.side-btn').all();
    let sidebarOk = false;
    let sidebarLine = '';
    for (const b of sideBtns) {
      const dp = await b.getAttribute('data-page');
      if (!dp) continue;
      const targetId = 'page-' + dp;
      if (targetId === initialId) continue;
      await b.click();
      await page.waitForTimeout(50);
      const isActive = await page.evaluate((id) => {
        const el = document.getElementById(id);
        return !!(el && el.classList.contains('active'));
      }, targetId);
      sidebarLine = `data-page="${dp}" -> ${targetId} .active=${isActive}`;
      sidebarOk = isActive;
      if (isActive) break;
    }
    overall = overall && (sidebarOk
      ? pass(`${file} .side-btn -> ${sidebarLine}`)
      : fail(`${file} .side-btn -> ${sidebarLine || 'no non-initial .side-btn found'}`));
    asserts.push({ name: 'sidebar click activates the matching .page-pane', ok: sidebarOk });

    // (3) click one .claim visible on the active pane, assert #claimPopover
    // acquires .open. Scoped to the active pane because clicking the sidebar
    // hid the overview and any claim inside it is no longer visible
    // (display:none). Uses default 5s timeout for clicks.
    const activePaneSelector = '.page-pane.active';
    const firstClaim = page.locator(`${activePaneSelector} .claim[data-claim]`).first();
    const claimCount = await firstClaim.count();
    let claimOk = false;
    let claimLine = '';
    if (claimCount > 0) {
      const beforeOpen = await page.evaluate(() => document.getElementById('claimPopover')?.classList.contains('open'));
      await firstClaim.click({ timeout: 5000 });
      await page.waitForTimeout(50);
      const afterOpen = await page.evaluate(() => document.getElementById('claimPopover')?.classList.contains('open'));
      claimLine = `#claimPopover.open ${beforeOpen}->${afterOpen}`;
      claimOk = !beforeOpen && afterOpen;
    } else {
      claimLine = `no .claim[data-claim] inside ${activePaneSelector}`;
    }
    overall = overall && (claimOk
      ? pass(`${file} .claim click -> ${claimLine}`)
      : fail(`${file} .claim click -> ${claimLine}`));
    asserts.push({ name: 'claim click opens the review popover', ok: claimOk });

    // Close the popover to start the three-in-a-row flow from a clean slate.
    if (claimOk) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(50);
    }

    // (4) THREE-IN-A-ROW: pick the first three claims on the active pane and
    // mark each with only a claim click + a verdict click, no click-away, no
    // force. This is the regression test for the T5 defect (T4-fix-clickable
    // left the popover open after a verdict, so the second click was
    // intercepted). Each click uses the default 5s timeout - if the popover
    // intercepts pointer events, the call hangs and the script fails.
    const VERDICTS = ['v-agree', 'v-wrong', 'v-unsure'];
    const threeClaims = await page.locator(`${activePaneSelector} .claim[data-claim]`).all();
    let threeOk = threeClaims.length >= 3;
    let threeLine = `${Math.min(3, threeClaims.length)}/3 claims available`;
    if (threeOk) {
      threeOk = true;
      for (let i = 0; i < 3; i++) {
        const c = threeClaims[i];
        const cid = await c.getAttribute('data-claim');
        // Click the claim.
        try {
          await c.click({ timeout: 5000 });
        } catch (e) {
          threeOk = false;
          threeLine = `claim ${i} (${cid}) click timed out: ${(e?.message || '').split('\n')[0]}`;
          break;
        }
        await page.waitForTimeout(50);
        const popAfterClaim = await page.evaluate(() => document.getElementById('claimPopover')?.classList.contains('open'));
        if (!popAfterClaim) {
          threeOk = false;
          threeLine = `claim ${i} (${cid}) click did NOT open the popover`;
          break;
        }
        // Click the matching verdict button.
        try {
          await page.locator(`.pop-verdict button.${VERDICTS[i]}`).first().click({ timeout: 5000 });
        } catch (e) {
          threeOk = false;
          threeLine = `claim ${i} (${cid}) verdict click timed out: ${(e?.message || '').split('\n')[0]}`;
          break;
        }
        await page.waitForTimeout(50);
        const popAfterVerdict = await page.evaluate(() => document.getElementById('claimPopover')?.classList.contains('open'));
        if (popAfterVerdict) {
          threeOk = false;
          threeLine = `claim ${i} (${cid}) verdict left popover .open=true`;
          break;
        }
      }
    }
    overall = overall && (threeOk
      ? pass(`${file} three claims marked in a row (claim+verdict, no click-away): ${threeLine}`)
      : fail(`${file} three claims marked in a row: ${threeLine}`));
    asserts.push({ name: 'three claims marked in a row without click-away', ok: threeOk });

    // (5) ELEMENT-FROM-POINT: for each of the three just-marked claims, the
    // NEXT claim's centre must be reachable. If the popover were intercepting
    // pointer events, elementFromPoint would resolve to the popover (or one
    // of its descendants), not the next claim. The hit element may be a
    // descendant of the claim (e.g. a <code> child); that is also fine -
    // it proves the popover is not on top of the claim.
    let elFromPtOk = true;
    let elFromPtLine = '';
    if (threeOk && threeClaims.length >= 4) {
      for (let i = 0; i < 3; i++) {
        const next = threeClaims[i + 1];
        const nextId = await next.getAttribute('data-claim');
        const bb = await next.boundingBox();
        if (!bb) { elFromPtOk = false; elFromPtLine = `claim ${i + 1} (${nextId}): no bounding box`; break; }
        const got = await page.evaluate(({ x, y, id }) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return { tag: null, claimId: null, isInsidePopover: false, isInsideClaim: false };
          const popover = el.closest ? el.closest('#claimPopover') : null;
          const claim = el.closest ? el.closest('.claim[data-claim]') : null;
          return {
            tag: el.tagName,
            hitClaimId: claim?.getAttribute?.('data-claim') || null,
            isInsidePopover: !!popover,
            isInsideClaim: !!claim,
          };
        }, { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id: nextId });
        if (got.isInsidePopover || !got.isInsideClaim || got.hitClaimId !== nextId) {
          elFromPtOk = false;
          elFromPtLine = `claim ${i + 1} (${nextId}) centre hit ${got.isInsidePopover ? 'popover' : `unexpected element (${JSON.stringify(got)})`}`;
          break;
        }
      }
      if (elFromPtOk) elFromPtLine = `all 3 next-claim centres resolve to the claim (or its descendants), not the popover`;
    } else {
      elFromPtOk = false;
      elFromPtLine = `skipped: need >= 4 claims and a clean three-in-a-row run`;
    }
    overall = overall && (elFromPtOk
      ? pass(`${file} elementFromPoint(next-claim centre): ` + elFromPtLine)
      : fail(`${file} elementFromPoint(next-claim centre): ` + elFromPtLine));
    asserts.push({ name: 'next-claim centre not blocked by popover', ok: elFromPtOk });

    // (6) ESCAPE closes the popover AND returns focus to the opener claim.
    // Uses a fresh claim (index 3) so we don't rely on state from step 4.
    const escIdx = Math.min(3, threeClaims.length - 1);
    const escClaim = threeClaims[escIdx];
    const escId = await escClaim.getAttribute('data-claim');
    try { await escClaim.click({ timeout: 5000 }); }
    catch (e) { overall = overall && fail(`${file} escape opener click timed out: ${(e?.message || '').split('\n')[0]}`); }
    await page.waitForTimeout(50);
    const escOpenBefore = await page.evaluate(() => document.getElementById('claimPopover')?.classList.contains('open'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    const escOpenAfter = await page.evaluate(() => document.getElementById('claimPopover')?.classList.contains('open'));
    const escActive = await page.evaluate(() => {
      const ae = document.activeElement;
      return { tag: ae?.tagName, claimId: ae?.getAttribute?.('data-claim'), classes: ae?.className };
    });
    const escOk = escOpenBefore && !escOpenAfter && escActive.tag === 'SPAN' && escActive.claimId === escId;
    const escLine = `popover ${escOpenBefore}->${escOpenAfter}, activeElement=${JSON.stringify(escActive)} (expected claim ${escId})`;
    overall = overall && (escOk ? pass(`${file} Escape closes popover + focus -> ${escLine}`) : fail(`${file} Escape: ${escLine}`));
    asserts.push({ name: 'Escape closes popover and returns focus to opener', ok: escOk });

    // (7) EXPORT round trip - press it, capture the download, parse JSON,
    // assert it contains exactly the three verdicts we marked with the
    // right ids/verdicts. Then re-import the same payload on a FRESH page
    // load and assert the three claims come back marked.
    // Set up the download listener BEFORE clicking the export button.
    const downloadPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
    await page.locator('#reviewExport').click();
    const download = await downloadPromise;
    let exportText = null;
    let exportJson = null;
    let exportOk = false;
    let exportLine = '';
    if (!download) {
      exportLine = `#reviewExport click did not produce a download event`;
    } else {
      exportText = await readDownloadText(download);
      try { exportJson = JSON.parse(exportText); }
      catch (e) { exportLine = `downloaded file is not valid JSON: ${e?.message || e}`; }
      if (exportJson) {
        // Build the expected verdict list from the three ids we marked.
        const markedIds = [];
        for (let i = 0; i < 3; i++) markedIds.push(await threeClaims[i].getAttribute('data-claim'));
        const expectedVerdicts = ['agree', 'wrong', 'unsure'];
        const byId = Object.fromEntries((exportJson.reviews || []).map(r => [r.id, r]));
        let allMatch = exportJson.reviews && exportJson.reviews.length === 3;
        if (allMatch) {
          for (let i = 0; i < 3; i++) {
            const id = markedIds[i];
            const r = byId[id];
            if (!r || r.verdict !== expectedVerdicts[i]) {
              allMatch = false;
              exportLine = `export: ${id} expected verdict "${expectedVerdicts[i]}", got "${r?.verdict}"`;
              break;
            }
          }
        } else {
          exportLine = `export: expected 3 reviews, got ${exportJson.reviews?.length || 0}`;
        }
        exportOk = allMatch;
        if (exportOk) exportLine = `${exportJson.reviews.length} reviews, all match marked ids/verdicts`;
      }
    }
    overall = overall && (exportOk
      ? pass(`${file} export JSON: ` + exportLine)
      : fail(`${file} export JSON: ` + exportLine));
    asserts.push({ name: 'export JSON contains exactly the marked verdicts', ok: exportOk });

    // (8) IMPORT round trip - reload the page clean, then feed the exported
    // JSON to the import handler, and assert the three claims come back
    // marked with the right verdicts.
    let importOk = false;
    let importLine = '';
    if (!exportText) {
      importLine = `skipped: no export payload`;
    } else {
      // Capture the expected claim ids BEFORE reload - the export was
      // produced for the claims we marked on the active pane. We must
      // import against those same ids, so we record them now.
      const markedIds = [];
      for (let i = 0; i < 3; i++) markedIds.push(await threeClaims[i].getAttribute('data-claim'));
      const expectedVerdicts = ['agree', 'wrong', 'unsure'];
      // Reload to a clean page so the import is the only source of truth.
      await page.evaluate(() => { try { localStorage.clear(); } catch (_) {} });
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#reviewToggle', { timeout: 5000 });
      // Navigate back to the page that hosts the marked claims (the
      // sidebar click in step 2 took us there). We look up the page id
      // from the doc-meta + the data-page attribute of the matching
      // sidebar button - simpler: just find which .page-pane contains
      // markedIds[0].
      const owningPageId = await page.evaluate((id) => {
        const c = document.querySelector(`.claim[data-claim="${id}"]`);
        if (!c) return null;
        const pane = c.closest('.page-pane');
        return pane ? pane.id : null;
      }, markedIds[0]);
      if (owningPageId) {
        const dp = owningPageId.replace(/^page-/, '');
        const side = page.locator(`.side-btn[data-page="${dp}"]`);
        if (await side.count() > 0) {
          await side.click();
          await page.waitForTimeout(50);
        }
      }
      // Trigger the hidden file input. The import button delegates to a
      // click on the file input. Setting the input files via Playwright
      // simulates the user selecting them.
      try {
        const importInput = page.locator('#reviewImportFile');
        await importInput.setInputFiles({
          name: 'review-roundtrip.json',
          mimeType: 'application/json',
          buffer: Buffer.from(exportText, 'utf8'),
        });
        await page.waitForTimeout(100);
      } catch (e) {
        importLine = `setInputFiles failed: ${e?.message || e}`;
      }
      // Inspect localStorage and the claim DOM.
      if (!importLine) {
        const stored = await page.evaluate(() => {
          try {
            const out = {};
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              out[k] = localStorage.getItem(k);
            }
            return out;
          } catch (_) { return null; }
        });
        const importVerdicts = await page.evaluate((ids) => {
          return ids.map(id => document.querySelector(`.claim[data-claim="${id}"]`)?.getAttribute('data-verdict') || null);
        }, markedIds);
        const allThree = importVerdicts.length === 3 && importVerdicts.every((v, i) => v === expectedVerdicts[i]);
        importOk = allThree;
        importLine = allThree
          ? `claims ${markedIds.join(',')} marked ${importVerdicts.join(',')}`
          : `expected ${expectedVerdicts.join(',')}, got ${importVerdicts.join(',')} (storage keys: ${Object.keys(stored || {}).join(';')})`;
      }
    }
    overall = overall && (importOk
      ? pass(`${file} import round trip: ` + importLine)
      : fail(`${file} import round trip: ` + importLine));
    asserts.push({ name: 'import round trip marks the same three claims', ok: importOk });

    // (9) zero page errors AND no fatal console errors.
    const fatalConsole = consoleErrs.filter(isFatal);
    const zeroPageErrs = pageErrs.length === 0;
    const noFatalConsole = fatalConsole.length === 0;
    overall = overall && (zeroPageErrs ? pass(`${file} page errors: ${pageErrs.length}`) : fail(`${file} page errors: ${pageErrs.length}`));
    overall = overall && (noFatalConsole ? pass(`${file} fatal console errors: ${fatalConsole.length} (total console errors: ${consoleErrs.length})`) : fail(`${file} fatal console errors: ${fatalConsole.length} (total console errors: ${consoleErrs.length})`));
    for (const e of pageErrs) console.log(`        pageerror: ${e}`);
    for (const e of consoleErrs) console.log(`        console:   ${e}`);
    asserts.push({ name: 'zero page errors', ok: zeroPageErrs });
    asserts.push({ name: 'no fatal console errors', ok: noFatalConsole });
  } catch (err) {
    overall = overall && fail(`${file}: ${err?.message || err}`);
  } finally {
    await browser.close();
  }
  return { file, ok: overall, asserts };
}

let allOk = true;
for (const f of files) {
  const r = await check(f);
  if (!r.ok) allOk = false;
}
process.exit(allOk ? 0 : 1);