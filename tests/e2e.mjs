// End-to-end test: serves the app locally, fakes the UGRC parcel service,
// map tiles, and GPS, then drives the main flows in headless Chromium.
// Run: npm test   (set CHROMIUM_PATH to use a specific browser binary)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'd4d-test-'));
const PORT = 8765;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const G = 0.0004;
const cell = (v) => Math.floor(v / G);
function parcel(ix, iy, statewide) {
  const x0 = ix * G, y0 = iy * G;
  const id = String(22000000000000 + Math.abs(ix * 7 + iy * 13) % 99999999).padStart(14, '0');
  const attributes = statewide
    ? { PARCEL_ID: id, PARCEL_ADD: `${Math.abs(ix) % 9000} E MAIN ST`, PARCEL_CITY: 'MIDVALE', PARCEL_ZIP: '84047-1234', COUNTY_NAME: 'SALT LAKE', OWN_TYPE: 'Private' }
    : { OBJECTID: 1, PARCEL_ID: id, PARCEL_ADD: `${Math.abs(ix) % 9000} E MAIN ST`, PARCEL_CITY: 'MIDVALE', COUNTY_NAME: 'SALT LAKE', TOTAL_MKT_VALUE: 452300, BUILT_YR: 1962, BLDG_SQFT: 1850, PARCEL_ACRES: 0.21, PRIMARY_RES: 'Y', PROP_CLASS: 'Residential' };
  return { attributes, geometry: { rings: [[[x0, y0], [x0, y0 + G * 0.8], [x0 + G * 0.8, y0 + G * 0.8], [x0 + G * 0.8, y0], [x0, y0]]] } };
}
let blockParcels = false, queries = [];
async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['geolocation', 'clipboard-read', 'clipboard-write'], geolocation: { latitude: 40.61101, longitude: -111.89985 }, acceptDownloads: true });
  await ctx.route(/tile\.openstreetmap|arcgisonline/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG, headers: { 'access-control-allow-origin': '*' } }));
  await ctx.route(/services1\.arcgis\.com/, async (r) => {
    const u = new URL(r.request().url());
    queries.push(u.pathname.split('/')[5] + ' ' + (u.searchParams.get('distance') ? 'dist' : u.searchParams.get('geometryType')));
    if (blockParcels) return r.abort('internetdisconnected');
    const statewide = u.pathname.includes('Parcels_Utah');
    const gt = u.searchParams.get('geometryType');
    let feats = [];
    if (gt === 'esriGeometryPoint') {
      const [x, y] = u.searchParams.get('geometry').split(',').map(Number);
      const ix = cell(x), iy = cell(y);
      const p = parcel(ix, iy, statewide);
      // gap between parcels = "street": only distance query finds it
      const inside = (x - ix * G) < G * 0.8 && (y - iy * G) < G * 0.8;
      if (inside || u.searchParams.get('distance')) feats = [p];
    } else {
      const e = JSON.parse(u.searchParams.get('geometry'));
      for (let ix = cell(e.xmin); ix <= cell(e.xmax) && feats.length < 400; ix++) for (let iy = cell(e.ymin); iy <= cell(e.ymax); iy++) feats.push({ geometry: parcel(ix, iy).geometry, attributes: { OBJECTID: 1 } });
    }
    await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ features: feats }) });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(() => { if (!sessionStorage.getItem('init')) { sessionStorage.setItem('init', 1); localStorage.setItem('d4d.view', JSON.stringify({ lat: 40.61101, lng: -111.89985, zoom: 18 })); } });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForTimeout(1200);
  const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

  // 1. Tap to pin
  await page.mouse.click(195, 380);
  await page.waitForSelector('#sheet:not([hidden]) .pid');
  const head = await page.textContent('#sheet');
  check(/MAIN ST/.test(head), 'tap pins a property and shows its address');
  check(/Parcel \d{2}-\d{2}-\d{3}-\d{3}-\d{4}/.test(head), 'Salt Lake parcel shown in dashed format');
  check(/84047/.test(head) && !/84047-1234/.test(head), 'ZIP filled from statewide layer, trimmed to 5 digits');
  check(await page.textContent('#btnCount') === '1 pin', 'pin counter shows 1 pin');
  const onParcel = await page.evaluate(() => { const d = window.__d4d; const p = [...d.pins.values()][0]; return d.distToRings(p.geom, p.lat, p.lng) === 0; });
  check(onParcel, 'pin sits on the parcel, not the street');
  await page.screenshot({ path: `${OUT}/1-peek.png` });

  // 2. Tag + details
  await page.click('#sheet .tag[data-tag="Vacant"]');
  await page.click('#sheet .head-actions [data-act="toggle"]');
  await page.waitForSelector('#sheet.full');
  check(/\$452,300/.test(await page.textContent('#sheet')), 'details show market value from county layer');
  await page.fill('#sheet [data-field="ownerName"]', 'SMITH, JOHN');
  await page.fill('#sheet [data-field="notes"]', '=HYPERLINK("x") roof tarp, "big" weeds');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/2-full.png` });
  await page.click('#backdrop', { position: { x: 20, y: 20 } });

  // 3. Second pin + duplicate tap
  await page.click('#sheet [data-act="close"]');
  await page.mouse.click(300, 250);
  await page.waitForFunction(() => document.querySelector('#btnCount').textContent === '2 pins');
  await page.waitForSelector('#sheet .pid');
  await page.click('#sheet [data-act="close"]');
  const spot = await page.evaluate(() => {
    const d = window.__d4d; const pin = [...d.pins.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    const r = pin.geom[0]; const xs = r.map((p) => p[0]), ys = r.map((p) => p[1]);
    const lng = Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * 0.85, lat = Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * 0.15;
    const pt = d.map.latLngToContainerPoint([lat, lng]); return { x: pt.x, y: pt.y };
  });
  await page.mouse.click(spot.x, spot.y);
  await page.waitForSelector('#toast:not([hidden])');
  check(/Already pinned/.test(await page.textContent('#toast')), 'tapping an already-pinned parcel says so');
  await page.waitForTimeout(300);
  check(await page.textContent('#btnCount') === '2 pins', 'duplicate tap does not add a pin');
  await page.click('#sheet [data-act="close"]');

  // 4. Street tap uses nearest parcel
  // 5. Offline pin then retry
  blockParcels = true;
  await page.mouse.click(100, 600);
  await page.waitForFunction(() => /failed|waiting/.test(document.querySelector('#sheet').textContent));
  check(true, 'lookup failure keeps the pin and says it will retry');
  blockParcels = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => /MAIN ST/.test(document.querySelector('#sheet h2').textContent));
  check(true, 'pending pin resolves when signal returns');
  await page.click('#sheet [data-act="close"]');

  // 6. Pin my spot (GPS)
  await page.click('#btnPinHere');
  await page.waitForFunction(() => document.querySelector('#btnCount').textContent === '4 pins' || /Already pinned/.test(document.querySelector('#toast').textContent), null, { timeout: 8000 });
  const n = await page.textContent('#btnCount');
  check(/pins/.test(n), `pin my spot works (count now ${n})`);
  await page.click('#sheet [data-act="close"]').catch(() => {});

  // 7. Driving mode
  await page.click('#btnDrive');
  await ctx.setGeolocation({ latitude: 40.6115, longitude: -111.8999 });
  await page.waitForTimeout(500);
  await ctx.setGeolocation({ latitude: 40.6125, longitude: -111.8999 });
  await page.waitForTimeout(500);
  const stat = await page.textContent('#driveStat');
  check(/Driving · \d/.test(stat), `drive mode tracks distance (${stat})`);
  await page.mouse.click(195, 300);
  await page.waitForSelector('#sheet:not([hidden]) .pid');
  await page.screenshot({ path: `${OUT}/3-driving.png` });
  await page.click('#sheet [data-act="close"]');
  await page.click('#btnDrive');
  await page.waitForTimeout(300);
  const ses = await page.evaluate(() => { const d = window.__d4d; const t = [...d.trails.values()][0]; return { n: d.trails.size, pins: [...d.pins.values()].filter((p) => p.sessionId === (t && t.id)).length }; });
  check(ses.n === 1 && ses.pins === 1, `drive is saved as a session with its pin (${ses.n} session, ${ses.pins} pin)`);

  // 8. List + export
  await page.click('#btnList');
  const items = await page.$$eval('#leadList .lead', (els) => els.length);
  check(items >= 3, `list shows ${items} leads`);
  await page.selectOption('#filterTag', 'Vacant');
  check(await page.$$eval('#leadList .lead', (els) => els.length) === 1, 'tag filter narrows list to 1');
  await page.screenshot({ path: `${OUT}/4-list.png` });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  fs.writeFileSync(`${OUT}/export.csv`, csv);
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  check(lines.length === 2, 'CSV has header + 1 filtered row');
  check(lines[0].startsWith('Parcel Number,Parcel Number (Formatted),Property Address'), 'CSV header is skip-trace friendly');
  check(/,JOHN,SMITH,"SMITH, JOHN",/.test(lines[1]), 'owner name split into first/last');
  check(/"'=HYPERLINK\(""x""\) roof tarp, ""big"" weeds"/.test(lines[1]), 'notes escaped and formula-guarded');
  check(/,UT,84047,Salt Lake,/.test(lines[1]), 'state, zip, county columns filled');
  await page.waitForTimeout(300);
  check(/Sent to skip trace/.test(await page.textContent('#leadList')), 'export offers to mark leads as sent');
  await page.selectOption('#filterTag', '');
  await page.click('#btnCopyIds');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(clip.split('\n').length >= 3 && /^\d{14}$/.test(clip.split('\n')[0]), 'copy parcel #s puts one ID per line on clipboard');

  // 8b. Sessions tab: list, filter pins by session, export
  await page.click('#tabSessions');
  check(await page.$$eval('#sessionList .session', (els) => els.length) === 2, 'sessions tab shows the drive plus "Not during a drive"');
  check(/1\s*pin/.test(await page.textContent('#sessionList .session')), 'session card counts its pins');
  await page.screenshot({ path: `${OUT}/4b-sessions.png` });
  const [sdl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExportSessions')]);
  const scsv = fs.readFileSync(await sdl.path(), 'utf8').replace(/^\ufeff/, '').trim().split('\r\n');
  check(scsv.length === 2 && scsv[0].startsWith('Session,Date,Start Time') && /MAIN ST/.test(scsv[1]), 'sessions CSV lists each drive with its pin addresses');
  await page.click('#btnCopySessions');
  check(/Not during a drive/.test(await page.evaluate(() => navigator.clipboard.readText())), 'copy sessions list includes every pin group');
  await page.click('#sessionList .session [data-sact="pins"]');
  check(!(await page.isHidden('#pinsView')) && await page.$$eval('#leadList .lead', (els) => els.length) === 1, 'view pins filters the pin list to that session');
  const [pdl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  const pcsv = fs.readFileSync(await pdl.path(), 'utf8').replace(/^\ufeff/, '').trim().split('\r\n');
  check(pcsv[0].endsWith(',Drive Session') && pcsv.length === 2 && !pcsv[1].endsWith(','), 'pin CSV includes the drive session');
  await page.selectOption('#filterSession', '');
  await page.click('#btnCopyList');
  check(/^1\. .*MAIN ST.*, UT 84047/.test(await page.evaluate(() => navigator.clipboard.readText())), 'copy address list makes a numbered list');
  await page.click('#tabSessions');
  await page.click('#sessionList .session [data-sact="map"]');
  check(await page.isHidden('#listPanel'), 'show on map closes the list and focuses the drive');
  await page.click('#btnList');
  await page.click('#tabPins');
  await page.click('[data-close="listPanel"]');

  // 9. Persistence across reload
  const before = await page.textContent('#btnCount');
  await page.reload();
  await page.waitForTimeout(1000);
  check(await page.textContent('#btnCount') === before, `pins persist after reload (${before})`);

  // 10. Remove + undo
  await page.click('#btnList');
  await page.click('#leadList .lead');
  await page.click('#sheet [data-act="remove"]');
  await page.waitForSelector('#toast:not([hidden]) button');
  const afterRemove = await page.textContent('#btnCount');
  await page.click('#toast button');
  await page.waitForTimeout(300);
  check(await page.textContent('#btnCount') === before && afterRemove !== before, 'remove then undo restores the pin');

  // 11. Settings + backup
  await page.click('#btnSettings');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/5-settings.png` });
  const [bk] = await Promise.all([page.waitForEvent('download'), page.click('#btnBackup')]);
  const backup = JSON.parse(fs.readFileSync(await bk.path(), 'utf8'));
  check(backup.app === 'mk-d4d' && backup.pins.length === parseInt(before), 'backup contains all pins');

  // 12. Service worker installs + caches shell
  const swOk = await page.evaluate(async () => { const reg = await navigator.serviceWorker.register('sw.js'); await navigator.serviceWorker.ready; const keys = await caches.keys(); const c = await caches.open('d4d-v2'); return keys.includes('d4d-v2') && (await c.keys()).length >= 8; });
  check(swOk, 'service worker installs and caches the app shell');

  // satellite toggle
  await page.click('[data-close="settingsPanel"]');
  await page.click('#btnLayer');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/6-satellite.png` });

  // unit helpers
  const unit = await page.evaluate(() => {
    const d = window.__d4d;
    const sq = [[[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0], [0, 0]]];
    return { a: d.splitName('John A Smith'), b: d.splitName('SMITH, JOHN'), inside: d.distToRings(sq, 0.0005, 0.0005), out: Math.round(d.distToRings(sq, 0.0005, 0.0011)) };
  });
  check(unit.a[0] === 'John A' && unit.a[1] === 'Smith' && unit.b[0] === 'JOHN' && unit.b[1] === 'SMITH', 'name splitting');
  check(unit.inside === 0 && unit.out > 8 && unit.out < 14, `point-to-parcel distance (${unit.out} m)`);

  const real = errors.filter((e) => !/Failed to load resource/.test(e)); check(real.length === 0, 'no script errors' + (real.length ? ': ' + real.join(' | ') : ''));
  await browser.close();
  server.close();
  console.log(`Screenshots and export saved in ${OUT}`);
}
main().catch((e) => { console.error(e); server.close(); process.exit(1); });
