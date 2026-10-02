/* MK Driving for Dollars
 * Tap a property on the map to pin it. The app looks up the parcel from Utah's
 * public parcel layers (UGRC), saves it on this device, and builds a lead list
 * you can export as a CSV for skip tracing.
 *
 * All data stays on the device (IndexedDB). No accounts, no server.
 */
'use strict';
(() => {
  // ── Constants ─────────────────────────────────────────────────────────────
  const UGRC = 'https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services';
  const DEFAULT_SOURCES = [
    `${UGRC}/Parcels_SaltLake_LIR/FeatureServer/0`, // Salt Lake County, includes value, year built, sq ft
    `${UGRC}/Parcels_Utah/FeatureServer/0`,         // statewide basic parcels (address, city, zip)
  ];
  const DEFAULT_TAGS = [
    'Vacant', 'Overgrown yard', 'Boarded up', 'Roof damage', 'Peeling paint',
    'Mail piling up', 'Junk or debris', 'Code violation', 'Fire damage',
    'For rent', 'Tired landlord', 'Needs work',
  ];
  const STATUSES = [
    { id: 'new', label: 'New lead', color: '#D4882A' },
    { id: 'sent', label: 'Sent to skip trace', color: '#1B3D6F' },
    { id: 'traced', label: 'Skip traced', color: '#6a3d9a' },
    { id: 'contacted', label: 'Contacted', color: '#2E7D32' },
    { id: 'dead', label: 'Dead / not interested', color: '#8a8a8a' },
  ];
  const STATUS = Object.fromEntries(STATUSES.map((s) => [s.id, s]));
  const STATE = 'UT';
  const DEFAULT_VIEW = { lat: 40.6111, lng: -111.8999, zoom: 13 }; // Midvale, UT
  const TAP_RADIUS_M = 20;  // tapped the street? use the nearest parcel within this distance
  const GPS_RADIUS_M = 45;  // "Pin my spot" from the street: look a bit farther
  const LINES_MIN_ZOOM = 17;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  const fmtMoney = (n) => (n ? '$' + Math.round(Number(n)).toLocaleString() : '');
  const fmtNum = (n) => (n ? Math.round(Number(n)).toLocaleString() : '');
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  // ── Settings (localStorage) ───────────────────────────────────────────────
  const settings = (() => {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('d4d.settings') || '{}') || {}; } catch { /* ignore */ }
    return Object.assign({
      sources: DEFAULT_SOURCES.slice(), tags: DEFAULT_TAGS.slice(),
      parcelLines: true, showRoutes: true, wakeLock: true, basemap: 'street',
    }, saved);
  })();
  function saveSettings() { try { localStorage.setItem('d4d.settings', JSON.stringify(settings)); } catch { /* ignore */ } }
  function loadView() {
    try { const v = JSON.parse(localStorage.getItem('d4d.view')); if (v && isFinite(v.lat)) return v; } catch { /* ignore */ }
    return DEFAULT_VIEW;
  }
  function saveView() {
    const c = map.getCenter();
    try { localStorage.setItem('d4d.view', JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() })); } catch { /* ignore */ }
  }

  // ── IndexedDB ─────────────────────────────────────────────────────────────
  const DB = (() => {
    let opening;
    function open() {
      if (opening) return opening;
      opening = new Promise((resolve, reject) => {
        const req = indexedDB.open('mk-d4d', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('pins')) d.createObjectStore('pins', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' }).createIndex('pinId', 'pinId');
          if (!d.objectStoreNames.contains('trails')) d.createObjectStore('trails', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return opening;
    }
    async function run(store, mode, fn) {
      const d = await open();
      return new Promise((resolve, reject) => {
        const tx = d.transaction(store, mode);
        let out;
        const req = fn(tx.objectStore(store));
        if (req) req.onsuccess = () => { out = req.result; };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
    return {
      all: (s) => run(s, 'readonly', (st) => st.getAll()),
      get: (s, k) => run(s, 'readonly', (st) => st.get(k)),
      put: (s, v) => run(s, 'readwrite', (st) => st.put(v)),
      del: (s, k) => run(s, 'readwrite', (st) => st.delete(k)),
      clear: (s) => run(s, 'readwrite', (st) => st.clear()),
      byIndex: (s, i, k) => run(s, 'readonly', (st) => st.index(i).getAll(k)),
    };
  })();

  // ── State ─────────────────────────────────────────────────────────────────
  const pins = new Map();     // id -> pin record
  const markers = new Map();  // id -> L.Marker
  const outlines = new Map(); // id -> L.Polygon
  const trails = new Map();   // id -> driving session (route + times)
  let selectedId = null;
  let sheetMode = 'hidden';   // hidden | peek | full

  // ── Map ───────────────────────────────────────────────────────────────────
  const view = loadView();
  const map = L.map('map', { zoomControl: false, attributionControl: true, doubleClickZoom: false }).setView([view.lat, view.lng], view.zoom);
  map.attributionControl.setPrefix(false);
  map.createPane('parcelLines').style.zIndex = 350;
  map.createPane('pinOutlines').style.zIndex = 360;
  map.createPane('trails').style.zIndex = 370;
  const linesRenderer = L.canvas({ pane: 'parcelLines' });
  const outlineRenderer = L.canvas({ pane: 'pinOutlines' });
  const trailRenderer = L.canvas({ pane: 'trails' });

  const BASEMAPS = {
    street: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 21, maxNativeZoom: 19, crossOrigin: true, attribution: '&copy; OpenStreetMap contributors',
    }),
    satellite: () => L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 21, maxNativeZoom: 19, crossOrigin: true, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
      }),
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 21, maxNativeZoom: 19, crossOrigin: true,
      }),
    ]),
  };
  let baseLayer = null;
  function setBasemap(name) {
    if (!BASEMAPS[name]) name = 'street';
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = BASEMAPS[name]().addTo(map);
    settings.basemap = name;
    saveSettings();
    $('btnLayer').classList.toggle('active', name === 'satellite');
    linesLayer.setStyle(lineStyle());
  }
  const lineStyle = () => (settings.basemap === 'satellite'
    ? { color: '#ffffff', weight: 1, opacity: 0.8, fill: false }
    : { color: '#1B3D6F', weight: 1, opacity: 0.55, fill: false });

  const linesLayer = L.featureGroup().addTo(map);
  const outlineLayer = L.featureGroup().addTo(map);
  const pinLayer = L.featureGroup().addTo(map);
  const trailLayer = L.featureGroup();
  const meLayer = L.featureGroup().addTo(map);
  const focusLayer = L.featureGroup().addTo(map); // a session picked from the Sessions list

  // ── ArcGIS parcel queries ─────────────────────────────────────────────────
  async function arcQuery(url, params, signal) {
    const p = new URLSearchParams(Object.assign({
      f: 'json', inSR: '4326', outSR: '4326', returnGeometry: 'true', geometryPrecision: '6',
    }, params));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    if (signal) signal.addEventListener('abort', () => ctrl.abort());
    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}/query?${p}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`Parcel service HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || 'Parcel service error');
      return json.features || [];
    } finally { clearTimeout(timer); }
  }
  const pointQuery = (lat, lng, distance) => Object.assign({
    geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', spatialRel: 'esriSpatialRelIntersects', outFields: '*',
  }, distance ? { distance: String(distance), units: 'esriSRUnit_Meter' } : {});

  // Distance in meters from a point to an Esri polygon (0 when inside).
  function distToRings(rings, lat, lng) {
    if (!rings || !rings.length) return Infinity;
    const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
    let inside = false, best = Infinity;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = (ring[i][0] - lng) * kx, yi = (ring[i][1] - lat) * ky;
        const xj = (ring[j][0] - lng) * kx, yj = (ring[j][1] - lat) * ky;
        if ((yi > 0) !== (yj > 0) && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi) inside = !inside;
        const dx = xj - xi, dy = yj - yi, len = dx * dx + dy * dy;
        const t = len ? Math.max(0, Math.min(1, -(xi * dx + yi * dy) / len)) : 0;
        best = Math.min(best, Math.hypot(xi + t * dx, yi + t * dy));
      }
    }
    return inside ? 0 : best;
  }
  // Area-weighted centroid of an Esri ring ([x, y] = [lng, lat]).
  function ringCentroid(ring) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
    }
    if (!a) return null;
    return { lng: cx / (3 * a), lat: cy / (3 * a) };
  }
  function nearest(features, lat, lng) {
    let best = null, bestD = Infinity;
    for (const f of features) {
      const d = distToRings(f.geometry && f.geometry.rings, lat, lng);
      if (d < bestD || !best) { best = f; bestD = d; }
    }
    return best;
  }

  function pick(attrs, keys) {
    const lower = {};
    for (const k in attrs) lower[k.toLowerCase()] = attrs[k];
    for (const k of keys) {
      const v = lower[k.toLowerCase()];
      if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }
  const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  function normalize(feature) {
    const a = feature.attributes || {};
    const county = pick(a, ['COUNTY_NAME', 'COUNTY']);
    const builtYr = pick(a, ['BUILT_YR', 'YEAR_BUILT', 'YR_BUILT']);
    return {
      parcelId: pick(a, ['PARCEL_ID', 'PARCELID', 'APN', 'PIN', 'SERIAL_NUM', 'PARCEL_NUM']),
      address: pick(a, ['PARCEL_ADD', 'SITUS_ADDR', 'SITE_ADDR', 'ADDRESS', 'PROP_ADDR']),
      city: pick(a, ['PARCEL_CITY', 'SITUS_CITY', 'CITY']),
      zip: pick(a, ['PARCEL_ZIP', 'SITUS_ZIP', 'ZIP', 'ZIPCODE', 'ZIP_CODE']).slice(0, 5),
      county: county ? titleCase(county) : '',
      details: {
        value: pick(a, ['TOTAL_MKT_VALUE', 'MKT_VALUE', 'TOTAL_VALUE']),
        landValue: pick(a, ['LAND_MKT_VALUE']),
        yearBuilt: builtYr && Number(builtYr) > 1700 ? builtYr : '',
        sqft: pick(a, ['BLDG_SQFT', 'SQFT']),
        acres: pick(a, ['PARCEL_ACRES', 'ACRES']),
        propClass: pick(a, ['PROP_CLASS']),
        primaryRes: pick(a, ['PRIMARY_RES']),
        floors: pick(a, ['FLOORS_CNT']),
        subdivision: pick(a, ['SUBDIV_NAME']),
        ownType: pick(a, ['OWN_TYPE']),
      },
      geom: feature.geometry && feature.geometry.rings
        ? feature.geometry.rings.map((ring) => ring.map(([x, y]) => [r6(x), r6(y)]))
        : null,
    };
  }

  // Look up the parcel at (or nearest to) a point. Returns null when the
  // services answered but found nothing; throws when no service answered.
  async function lookupParcel(lat, lng, radius) {
    const sources = settings.sources.filter(Boolean);
    let hit = null, hitIndex = -1, failures = 0, lastErr = null;
    for (let i = 0; i < sources.length && !hit; i++) {
      try {
        let f = nearest(await arcQuery(sources[i], pointQuery(lat, lng)), lat, lng);
        if (!f && radius) f = nearest(await arcQuery(sources[i], pointQuery(lat, lng, radius)), lat, lng);
        if (f) { hit = normalize(f); hitIndex = i; }
      } catch (err) { failures++; lastErr = err; }
    }
    if (!hit) {
      if (failures) throw lastErr;
      return null;
    }
    // Fill gaps (like ZIP, which the county LIR layer may not carry) from later sources.
    for (let i = hitIndex + 1; i < sources.length && (!hit.zip || !hit.address || !hit.city); i++) {
      try {
        const feats = await arcQuery(sources[i], pointQuery(lat, lng, radius || TAP_RADIUS_M));
        const same = feats.find((f) => normalize(f).parcelId === hit.parcelId) || nearest(feats, lat, lng);
        if (same) {
          const extra = normalize(same);
          for (const k of ['address', 'city', 'zip', 'county']) if (!hit[k] && extra[k]) hit[k] = extra[k];
        }
      } catch { /* best effort */ }
    }
    return hit;
  }

  // ── Parcel lines overlay ──────────────────────────────────────────────────
  let linesBounds = null, linesCtrl = null, linesTimer = null;
  function scheduleLines() { clearTimeout(linesTimer); linesTimer = setTimeout(loadLines, 350); }
  async function loadLines() {
    const zoomOk = map.getZoom() >= LINES_MIN_ZOOM;
    $('zoomHint').hidden = !settings.parcelLines || zoomOk || map.getZoom() < 14;
    if (!settings.parcelLines || !zoomOk) { linesLayer.clearLayers(); linesBounds = null; return; }
    if (linesBounds && linesBounds.contains(map.getBounds())) return;
    if (!navigator.onLine) return;
    if (linesCtrl) linesCtrl.abort();
    const ctrl = linesCtrl = new AbortController();
    const b = map.getBounds().pad(0.4);
    const env = { xmin: b.getWest(), ymin: b.getSouth(), xmax: b.getEast(), ymax: b.getNorth(), spatialReference: { wkid: 4326 } };
    for (const url of settings.sources.filter(Boolean)) {
      try {
        const feats = await arcQuery(url, {
          geometry: JSON.stringify(env), geometryType: 'esriGeometryEnvelope', spatialRel: 'esriSpatialRelIntersects',
          maxAllowableOffset: '0.000004',
        }, ctrl.signal);
        if (ctrl.signal.aborted) return;
        if (!feats.length) continue;
        linesLayer.clearLayers();
        const style = Object.assign(lineStyle(), { renderer: linesRenderer, interactive: false });
        for (const f of feats) {
          if (f.geometry && f.geometry.rings) L.polygon(f.geometry.rings.map((r) => r.map(([x, y]) => [y, x])), style).addTo(linesLayer);
        }
        linesBounds = b;
        return;
      } catch { if (ctrl.signal.aborted) return; }
    }
  }

  // ── Pins on the map ───────────────────────────────────────────────────────
  function pinIcon(pin) {
    const st = STATUS[pin.status] || STATUS.new;
    const cls = ['pin', pin.id === selectedId ? 'sel' : '', pin.lookup === 'ok' ? '' : 'pend'].join(' ');
    return L.divIcon({ className: 'pin-wrap', html: `<div class="${cls}" style="--c:${st.color}"></div>`, iconSize: [30, 34], iconAnchor: [15, 32] });
  }
  function drawPin(pin) {
    let m = markers.get(pin.id);
    if (!m) {
      m = L.marker([pin.lat, pin.lng], { icon: pinIcon(pin), keyboard: false, title: pin.address || 'Pinned property' });
      m.on('click', () => select(pin.id, 'peek'));
      m.addTo(pinLayer);
      markers.set(pin.id, m);
    } else {
      m.setLatLng([pin.lat, pin.lng]);
      m.setIcon(pinIcon(pin));
    }
    m.setZIndexOffset(pin.id === selectedId ? 1000 : 0);
    const old = outlines.get(pin.id);
    if (old) { outlineLayer.removeLayer(old); outlines.delete(pin.id); }
    if (pin.geom) {
      const st = STATUS[pin.status] || STATUS.new;
      const poly = L.polygon(pin.geom.map((r) => r.map(([x, y]) => [y, x])), {
        renderer: outlineRenderer, interactive: false, color: st.color, weight: pin.id === selectedId ? 3 : 2,
        fillColor: st.color, fillOpacity: pin.id === selectedId ? 0.25 : 0.12,
      }).addTo(outlineLayer);
      outlines.set(pin.id, poly);
    }
  }
  function undrawPin(id) {
    const m = markers.get(id); if (m) { pinLayer.removeLayer(m); markers.delete(id); }
    const o = outlines.get(id); if (o) { outlineLayer.removeLayer(o); outlines.delete(id); }
  }

  function updateCounts() {
    const n = pins.size;
    $('btnCount').textContent = `${n} pin${n === 1 ? '' : 's'}`;
  }

  // ── Creating + resolving pins ─────────────────────────────────────────────
  const findByParcel = (parcelId, exceptId) => {
    if (!parcelId) return null;
    for (const p of pins.values()) if (p.id !== exceptId && p.parcelId === parcelId) return p;
    return null;
  };

  async function createPinAt(latlng, how) {
    const now = Date.now();
    const pin = {
      id: uid(), lat: r6(latlng.lat), lng: r6(latlng.lng), how,
      parcelId: '', address: '', city: '', zip: '', county: '', details: {}, geom: null,
      tags: [], status: 'new', ownerName: '', notes: '', lookup: 'pending', createdAt: now, updatedAt: now,
      sessionId: driving && trail ? trail.id : '',
    };
    pins.set(pin.id, pin);
    await DB.put('pins', pin);
    drawPin(pin);
    select(pin.id, 'peek');
    updateCounts();
    if (navigator.vibrate) navigator.vibrate(30);
    await resolvePin(pin, how === 'gps' ? GPS_RADIUS_M : TAP_RADIUS_M, true);
  }

  const resolving = new Set();
  async function resolvePin(pin, radius, interactive) {
    if (resolving.has(pin.id)) return;
    resolving.add(pin.id);
    try {
      let res;
      try {
        res = await lookupParcel(pin.lat, pin.lng, radius);
      } catch (err) {
        if (!pins.has(pin.id)) return;
        pin.lookup = 'pending';
        pin.lookupError = navigator.onLine ? String(err && err.message || err) : 'offline';
        await DB.put('pins', pin);
        refreshPin(pin);
        return;
      }
      if (!pins.has(pin.id)) return; // removed while we were looking it up
      if (!res) {
        pin.lookup = 'none';
        delete pin.lookupError;
        pin.updatedAt = Date.now();
        await DB.put('pins', pin);
        refreshPin(pin);
        return;
      }
      const dup = findByParcel(res.parcelId, pin.id);
      if (dup) {
        const wasSelected = selectedId === pin.id;
        await mergeInto(dup, pin);
        if (wasSelected || interactive) select(dup.id, 'peek');
        toast(`Already pinned: ${dup.address || dup.parcelId}`);
        return;
      }
      Object.assign(pin, res, { lookup: 'ok', updatedAt: Date.now() });
      delete pin.lookupError;
      // Tapped the street or sidewalk? Move the pin onto the parcel itself.
      if (pin.geom && distToRings(pin.geom, pin.lat, pin.lng) > 0) {
        const c = ringCentroid(pin.geom[0]);
        if (c && distToRings(pin.geom, c.lat, c.lng) === 0) {
          pin.tapLat = pin.lat; pin.tapLng = pin.lng;
          pin.lat = r6(c.lat); pin.lng = r6(c.lng);
        }
      }
      await DB.put('pins', pin);
      refreshPin(pin);
    } finally {
      resolving.delete(pin.id);
    }
  }

  // A second pin landed on an existing parcel: keep the first, carry over anything new.
  async function mergeInto(keep, extra) {
    keep.tags = [...new Set([...(keep.tags || []), ...(extra.tags || [])])];
    if (extra.notes && !keep.notes.includes(extra.notes)) keep.notes = [keep.notes, extra.notes].filter(Boolean).join('\n');
    if (!keep.ownerName && extra.ownerName) keep.ownerName = extra.ownerName;
    keep.updatedAt = Date.now();
    await DB.put('pins', keep);
    for (const ph of await DB.byIndex('photos', 'pinId', extra.id)) { ph.pinId = keep.id; await DB.put('photos', ph); }
    pins.delete(extra.id);
    undrawPin(extra.id);
    await DB.del('pins', extra.id);
    drawPin(keep);
    updateCounts();
    if (!$('listPanel').hidden) renderList();
  }

  function refreshPin(pin) {
    drawPin(pin);
    if (selectedId === pin.id) renderSheet();
    if (!$('listPanel').hidden) renderList();
  }

  let retryTimer = null;
  async function retryPending() {
    if (!navigator.onLine) return;
    for (const pin of [...pins.values()]) {
      if (pin.lookup === 'pending') await resolvePin(pin, pin.how === 'gps' ? GPS_RADIUS_M : TAP_RADIUS_M, false);
    }
  }

  async function removePin(id) {
    const pin = pins.get(id);
    if (!pin) return;
    const photos = await DB.byIndex('photos', 'pinId', id);
    pins.delete(id);
    undrawPin(id);
    await DB.del('pins', id);
    if (selectedId === id) closeSheet();
    updateCounts();
    if (!$('listPanel').hidden) renderList();
    let undone = false;
    toast(`Pin removed${pin.address ? ': ' + pin.address : ''}`, 'Undo', async () => {
      undone = true;
      pins.set(pin.id, pin);
      await DB.put('pins', pin);
      drawPin(pin);
      updateCounts();
      select(pin.id, 'peek');
      if (!$('listPanel').hidden) renderList();
    }, 6000, async () => {
      if (!undone) for (const ph of photos) await DB.del('photos', ph.id);
    });
  }

  async function savePin(pin) {
    pin.updatedAt = Date.now();
    await DB.put('pins', pin);
    drawPin(pin);
  }

  // ── Sheet (pin details) ───────────────────────────────────────────────────
  function select(id, mode) {
    const prev = selectedId;
    selectedId = id;
    if (prev && prev !== id && pins.has(prev)) drawPin(pins.get(prev));
    if (id && pins.has(id)) drawPin(pins.get(id));
    setSheet(id ? mode || 'peek' : 'hidden');
  }
  function setSheet(mode) {
    sheetMode = mode;
    const sheet = $('sheet');
    sheet.hidden = mode === 'hidden';
    sheet.classList.toggle('full', mode === 'full');
    $('backdrop').hidden = mode !== 'full';
    if (mode !== 'hidden') renderSheet();
  }
  function closeSheet() {
    const prev = selectedId;
    selectedId = null;
    if (prev && pins.has(prev)) drawPin(pins.get(prev));
    setSheet('hidden');
  }

  const isSaltLake = (pin) => /salt\s*lake/i.test(pin.county || '') && /^\d{14}$/.test(pin.parcelId || '');
  const prettyParcel = (pin) => (isSaltLake(pin)
    ? pin.parcelId.replace(/^(\d{2})(\d{2})(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3-$4-$5')
    : pin.parcelId);

  let photoUrls = [];
  async function renderSheet() {
    const pin = pins.get(selectedId);
    const sheet = $('sheet');
    if (!pin) { setSheet('hidden'); return; }
    const st = STATUS[pin.status] || STATUS.new;
    let lookupLine = '';
    if (pin.lookup === 'pending') {
      lookupLine = pin.lookupError
        ? `<div class="status-line warn">Parcel lookup ${pin.lookupError === 'offline' ? 'waiting for signal' : 'failed'}. Pin is saved and will retry.</div>`
        : '<div class="status-line">Looking up parcel...</div>';
    } else if (pin.lookup === 'none') {
      lookupLine = '<div class="status-line warn">No parcel found at this spot. The pin is saved by GPS location. Tap the house itself to try again.</div>';
    } else if (pin.how === 'gps') {
      lookupLine = '<div class="status-line">Pinned from your GPS spot. Check the outline is the right house.</div>';
    }
    const title = pin.address || (pin.lookup === 'pending' ? 'Pinned property' : `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`);
    const sub = [pin.city, pin.zip, pin.county ? pin.county + ' County' : ''].filter(Boolean).join(' · ');
    const tagSet = new Set(pin.tags || []);
    const allTags = [...new Set([...settings.tags, ...tagSet])];
    const d = pin.details || {};
    const facts = [
      [fmtMoney(d.value), 'Market value'], [d.yearBuilt, 'Year built'], [fmtNum(d.sqft), 'Building sq ft'],
      [d.acres ? Number(d.acres).toFixed(2) : '', 'Acres'], [d.propClass, 'Property class'],
      [d.primaryRes ? (/^y/i.test(d.primaryRes) ? 'Yes' : 'No') : '', 'Owner-occupied (primary res.)'],
      [d.subdivision, 'Subdivision'], [d.ownType, 'Owner type'],
    ].filter(([v]) => v);
    const gmaps = `https://www.google.com/maps/search/?api=1&query=${pin.lat},${pin.lng}`;
    const street = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${pin.lat},${pin.lng}`;
    const ses = trails.get(sessionOf(pin));
    const county = isSaltLake(pin) ? `https://slco.org/assessor/new/valuationInfoExpanded.cfm?parcel_id=${encodeURIComponent(pin.parcelId)}` : '';

    sheet.innerHTML = `
      <button class="sheet-grab" type="button" data-act="toggle" aria-label="${sheetMode === 'full' ? 'Collapse' : 'Expand'} details"></button>
      <div class="sheet-head">
        <div class="sheet-title">
          <h2>${esc(title)}</h2>
          <button class="icon-btn" type="button" data-act="close" aria-label="Close">&times;</button>
        </div>
        ${sub ? `<div class="sheet-sub">${esc(sub)}</div>` : ''}
        ${pin.parcelId ? `<div class="pid">Parcel ${esc(prettyParcel(pin))} <button type="button" data-act="copy">Copy</button></div>` : ''}
        ${lookupLine}
        <div class="tags" role="group" aria-label="Quick tags">
          ${allTags.map((t) => `<button type="button" class="tag ${tagSet.has(t) ? 'on' : ''}" data-act="tag" data-tag="${esc(t)}" aria-pressed="${tagSet.has(t)}">${esc(t)}</button>`).join('')}
        </div>
        <div class="head-actions">
          <button class="btn btn-danger" type="button" data-act="remove">Remove</button>
          <button class="btn btn-primary" type="button" data-act="toggle">${sheetMode === 'full' ? 'Less' : 'Details & notes'}</button>
        </div>
      </div>
      <div class="sheet-body">
        ${facts.length ? `<div class="facts">${facts.map(([v, k]) => `<div class="fact"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>` : ''}
        <label class="field"><span>Status</span>
          <select data-field="status">${STATUSES.map((s) => `<option value="${s.id}" ${s.id === pin.status ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Owner name (optional)</span>
          <input data-field="ownerName" type="text" value="${esc(pin.ownerName)}" placeholder="${county ? 'Shown on the county record link below' : 'If you know it'}" autocomplete="off">
        </label>
        <label class="field"><span>Notes</span>
          <textarea data-field="notes" rows="3" placeholder="What did you see?">${esc(pin.notes)}</textarea>
        </label>
        <div class="field"><span>Photos</span>
          <div class="photos" id="sheetPhotos"></div>
          <button class="btn" type="button" data-act="photo">Add photo</button>
        </div>
        <div class="links">
          <a href="${gmaps}" target="_blank" rel="noopener">Google Maps</a>
          <a href="${street}" target="_blank" rel="noopener">Street View</a>
          ${county ? `<a href="${county}" target="_blank" rel="noopener">County record (owner)</a>` : ''}
          ${pin.lookup !== 'ok' ? '<a href="#" data-act="retry">Retry parcel lookup</a>' : ''}
        </div>
        <p class="meta">Status color: <b style="color:${st.color}">${esc(st.label)}</b> · Added ${esc(fmtDate(pin.createdAt))}${ses ? ` on drive ${esc(sessionLabel(ses))}` : ''} · ${pin.lat.toFixed(6)}, ${pin.lng.toFixed(6)}</p>
      </div>`;

    if (sheetMode === 'full') renderPhotos(pin.id);
  }

  async function renderPhotos(pinId) {
    photoUrls.forEach((u) => URL.revokeObjectURL(u));
    photoUrls = [];
    const box = $('sheetPhotos');
    if (!box) return;
    const photos = (await DB.byIndex('photos', 'pinId', pinId)).sort((a, b) => a.createdAt - b.createdAt);
    if (selectedId !== pinId || !document.contains(box)) return;
    box.innerHTML = photos.map((ph) => {
      const u = URL.createObjectURL(ph.blob);
      photoUrls.push(u);
      return `<div class="photo"><img src="${u}" alt="Property photo" data-act="view" data-url="${u}"><button type="button" data-act="delphoto" data-id="${ph.id}" aria-label="Delete photo">&times;</button></div>`;
    }).join('') || '<span class="muted small">No photos yet.</span>';
  }

  let fieldTimer = null;
  $('sheet').addEventListener('input', (e) => {
    const f = e.target.dataset.field;
    const pin = pins.get(selectedId);
    if (!f || !pin) return;
    pin[f] = e.target.value;
    clearTimeout(fieldTimer);
    fieldTimer = setTimeout(() => savePin(pin), 400);
  });
  $('sheet').addEventListener('change', async (e) => {
    const pin = pins.get(selectedId);
    if (e.target.dataset.field === 'status' && pin) {
      pin.status = e.target.value;
      await savePin(pin);
      renderSheet();
    }
  });
  $('sheet').addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    const pin = pins.get(selectedId);
    if (!el || !pin) return;
    const act = el.dataset.act;
    if (act === 'toggle') setSheet(sheetMode === 'full' ? 'peek' : 'full');
    else if (act === 'close') closeSheet();
    else if (act === 'copy') copyText(pin.parcelId, 'Parcel number copied');
    else if (act === 'tag') {
      const t = el.dataset.tag;
      const set = new Set(pin.tags || []);
      set.has(t) ? set.delete(t) : set.add(t);
      pin.tags = [...set];
      el.classList.toggle('on', set.has(t));
      el.setAttribute('aria-pressed', set.has(t));
      await savePin(pin);
    } else if (act === 'remove') removePin(pin.id);
    else if (act === 'photo') $('photoInput').click();
    else if (act === 'view') { const v = $('photoViewer'); v.querySelector('img').src = el.dataset.url; v.hidden = false; }
    else if (act === 'delphoto') {
      if (confirm('Delete this photo?')) { await DB.del('photos', el.dataset.id); renderPhotos(pin.id); }
    } else if (act === 'retry') {
      e.preventDefault();
      pin.lookup = 'pending'; delete pin.lookupError;
      renderSheet();
      await resolvePin(pin, pin.how === 'gps' ? GPS_RADIUS_M : TAP_RADIUS_M, true);
    }
  });
  $('photoViewer').addEventListener('click', () => { $('photoViewer').hidden = true; });
  $('backdrop').addEventListener('click', () => setSheet('peek'));

  $('photoInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    const pin = pins.get(selectedId);
    if (!file || !pin) return;
    try {
      const blob = await compressImage(file, 1600, 0.75);
      await DB.put('photos', { id: uid(), pinId: pin.id, blob, createdAt: Date.now() });
      renderPhotos(pin.id);
    } catch (err) { toast('Could not save that photo.'); }
  });

  async function compressImage(file, maxSide, quality) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { bmp = null; }
    if (!bmp) {
      bmp = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(file);
      });
    }
    const w = bmp.width, h = bmp.height, s = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', quality));
  }

  // ── Tap to pin ────────────────────────────────────────────────────────────
  map.on('click', (e) => {
    if (sheetMode === 'full') { setSheet('peek'); return; }
    createPinAt(e.latlng, 'tap');
  });

  // ── GPS, driving, routes ──────────────────────────────────────────────────
  let watchId = null, lastFix = null, follow = false, driving = false, trail = null, trailLine = null, wakeLock = null;
  let meDot = null, meAcc = null, trailSaveTimer = null;

  function startWatch() {
    if (watchId !== null) return true;
    if (!('geolocation' in navigator)) { toast('This browser has no GPS access.'); return false; }
    watchId = navigator.geolocation.watchPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    return true;
  }
  function stopWatch() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  function onFix(pos) {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    const first = !lastFix;
    lastFix = { lat, lng, accuracy, t: pos.timestamp };
    if (!meDot) {
      meAcc = L.circle([lat, lng], { radius: accuracy, renderer: trailRenderer, color: '#1a73e8', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(meLayer);
      meDot = L.marker([lat, lng], { icon: L.divIcon({ className: 'pin-wrap', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 2000 }).addTo(meLayer);
    } else {
      meDot.setLatLng([lat, lng]);
      meAcc.setLatLng([lat, lng]).setRadius(accuracy);
    }
    if (follow) map.panTo([lat, lng], { animate: !first });
    if (first && follow) map.setView([lat, lng], Math.max(map.getZoom(), 17));
    if (driving && trail && accuracy <= 50) {
      const last = trail.points[trail.points.length - 1];
      if (!last || map.distance(last, [lat, lng]) >= 12) {
        trail.points.push([r6(lat), r6(lng)]);
        trail.lastAt = Date.now();
        if (trailLine) trailLine.addLatLng([lat, lng]);
        clearTimeout(trailSaveTimer);
        trailSaveTimer = setTimeout(() => DB.put('trails', trail), 3000);
        updateDriveStat();
      }
    }
  }
  function onFixError(err) {
    if (err.code === 1) {
      toast('Location is blocked. Allow location access for this site in your phone settings.');
      stopWatch();
      if (driving) stopDriving();
      follow = false;
      updateLocateBtn();
    } else if (!lastFix) {
      toast('Waiting for a GPS signal...');
    }
  }
  function updateLocateBtn() {
    $('btnLocate').classList.toggle('active', follow);
    $('btnLocate').classList.toggle('recenter', !follow && driving);
  }
  map.on('dragstart', () => { if (follow) { follow = false; updateLocateBtn(); } });

  $('btnLocate').addEventListener('click', () => {
    if (!startWatch()) return;
    follow = true;
    updateLocateBtn();
    if (lastFix) map.setView([lastFix.lat, lastFix.lng], Math.max(map.getZoom(), 17));
  });

  function trailMiles(t) {
    let m = 0;
    for (let i = 1; i < t.points.length; i++) m += map.distance(t.points[i - 1], t.points[i]);
    return m / 1609.344;
  }
  function updateDriveStat() {
    const chip = $('driveStat');
    chip.hidden = !driving;
    if (driving && trail) chip.textContent = `Driving · ${trailMiles(trail).toFixed(1)} mi`;
  }
  async function startDriving() {
    if (!startWatch()) return;
    driving = true;
    follow = true;
    trail = { id: uid(), startedAt: Date.now(), points: [] };
    trails.set(trail.id, trail);
    trailLine = L.polyline([], { renderer: trailRenderer, color: '#1a73e8', weight: 4, opacity: 0.7, interactive: false });
    if (settings.showRoutes) trailLine.addTo(trailLayer);
    $('btnDrive').classList.add('on');
    $('btnDriveLabel').textContent = 'Stop driving';
    updateDriveStat();
    updateLocateBtn();
    if (lastFix) map.setView([lastFix.lat, lastFix.lng], Math.max(map.getZoom(), 17));
    requestWakeLock();
  }
  async function stopDriving() {
    driving = false;
    clearTimeout(trailSaveTimer);
    if (trail && (trail.points.length > 1 || pinsInSession(trail.id).length)) {
      trail.endedAt = Date.now();
      await DB.put('trails', trail);
      const n = pinsInSession(trail.id).length;
      toast(`Drive saved: ${trailMiles(trail).toFixed(1)} miles, ${n} pin${n === 1 ? '' : 's'}.`);
    } else if (trail) {
      trails.delete(trail.id);
      await DB.del('trails', trail.id);
      if (trailLine) trailLayer.removeLayer(trailLine);
    }
    trail = null;
    trailLine = null;
    $('btnDrive').classList.remove('on');
    $('btnDriveLabel').textContent = 'Start driving';
    updateDriveStat();
    updateLocateBtn();
    releaseWakeLock();
  }
  $('btnDrive').addEventListener('click', () => (driving ? stopDriving() : startDriving()));

  async function requestWakeLock() {
    if (!settings.wakeLock || !('wakeLock' in navigator) || !driving) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch { wakeLock = null; }
  }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && driving) requestWakeLock();
    if (document.visibilityState === 'hidden' && trail) DB.put('trails', trail);
  });

  $('btnPinHere').addEventListener('click', () => {
    const recent = lastFix && Date.now() - lastFix.t < 30000;
    if (recent) { createPinAt(L.latLng(lastFix.lat, lastFix.lng), 'gps'); return; }
    if (!('geolocation' in navigator)) { toast('This browser has no GPS access.'); return; }
    toast('Getting your location...');
    navigator.geolocation.getCurrentPosition((pos) => {
      onFix(pos);
      hideToast();
      createPinAt(L.latLng(pos.coords.latitude, pos.coords.longitude), 'gps');
      startWatch();
    }, (err) => onFixError(err), { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
  });

  async function drawTrails() {
    trailLayer.clearLayers();
    if (!settings.showRoutes) { map.removeLayer(trailLayer); return; }
    trailLayer.addTo(map);
    for (const t of trails.values()) {
      if (trail && t.id === trail.id) continue;
      if (t.points.length > 1) L.polyline(t.points, { renderer: trailRenderer, color: '#1a73e8', weight: 4, opacity: 0.4, interactive: false }).addTo(trailLayer);
    }
    if (trailLine) trailLine.addTo(trailLayer);
  }

  // ── Driving sessions ──────────────────────────────────────────────────────
  // A session is one drive (Start driving → Stop driving). New pins carry the
  // session id; older pins are matched to a drive by the time they were added.
  const trailEnd = (t) => (trail && t.id === trail.id ? Date.now() : t.endedAt || t.lastAt || t.startedAt + 3 * 3600e3);
  function sessionOf(pin) {
    if (pin.sessionId) return trails.has(pin.sessionId) ? pin.sessionId : '';
    for (const t of trails.values()) if (pin.createdAt >= t.startedAt && pin.createdAt <= trailEnd(t)) return t.id;
    return '';
  }
  const pinsInSession = (id) => [...pins.values()].filter((p) => sessionOf(p) === id);
  const sortedSessions = () => [...trails.values()].sort((a, b) => b.startedAt - a.startedAt);
  const fmtTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtDay = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const sessionLabel = (t) => t.name || `${fmtDay(t.startedAt)} · ${fmtTime(t.startedAt)}`;
  const sessionMinutes = (t) => Math.max(0, Math.round((trailEnd(t) - t.startedAt) / 60000));
  function fmtDuration(min) {
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `${h} h ${m} min` : `${m} min`;
  }

  // ── Lead list + export ────────────────────────────────────────────────────
  let listTab = 'pins';
  function fillFilters() {
    const fs = $('filterStatus'), ft = $('filterTag'), fx = $('filterSession');
    const sv = fs.value, tv = ft.value, xv = fx.value;
    fs.innerHTML = '<option value="">All statuses</option>' + STATUSES.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
    const tags = new Set(settings.tags);
    for (const p of pins.values()) (p.tags || []).forEach((t) => tags.add(t));
    ft.innerHTML = '<option value="">All tags</option>' + [...tags].map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    fs.value = sv; ft.value = [...tags].includes(tv) ? tv : '';
    const sessions = sortedSessions();
    fx.innerHTML = '<option value="">All sessions</option>'
      + sessions.map((t) => `<option value="${esc(t.id)}">${esc(sessionLabel(t))}</option>`).join('')
      + '<option value="none">Not during a drive</option>';
    fx.value = xv === 'none' || trails.has(xv) ? xv : '';
  }
  const SORTS = {
    newest: (a, b) => b.createdAt - a.createdAt,
    oldest: (a, b) => a.createdAt - b.createdAt,
    address: (a, b) => (a.address || '￿').localeCompare(b.address || '￿', undefined, { numeric: true }) || b.createdAt - a.createdAt,
    status: (a, b) => STATUSES.findIndex((s) => s.id === a.status) - STATUSES.findIndex((s) => s.id === b.status) || b.createdAt - a.createdAt,
    value: (a, b) => (Number((b.details || {}).value) || 0) - (Number((a.details || {}).value) || 0) || b.createdAt - a.createdAt,
  };
  function filteredPins() {
    const q = $('listSearch').value.trim().toLowerCase();
    const st = $('filterStatus').value, tg = $('filterTag').value, ses = $('filterSession').value;
    return [...pins.values()]
      .filter((p) => !st || p.status === st)
      .filter((p) => !tg || (p.tags || []).includes(tg))
      .filter((p) => !ses || sessionOf(p) === (ses === 'none' ? '' : ses))
      .filter((p) => !q || [p.address, p.city, p.zip, p.parcelId, prettyParcel(p), p.notes, p.ownerName, (p.tags || []).join(' ')]
        .join(' ').toLowerCase().includes(q))
      .sort(SORTS[$('sortBy').value] || SORTS.newest);
  }
  function renderList() {
    if (listTab === 'sessions') { renderSessions(); return; }
    const list = filteredPins();
    $('listCount').textContent = `(${list.length}${list.length !== pins.size ? ' of ' + pins.size : ''})`;
    const missing = list.filter((p) => !p.parcelId).length;
    $('listNote').textContent = missing ? `${missing} pin${missing === 1 ? ' has' : 's have'} no parcel number yet. They export with GPS coordinates only.` : '';
    $('leadList').innerHTML = list.length ? list.map((p) => {
      const st = STATUS[p.status] || STATUS.new;
      const ses = trails.get(sessionOf(p));
      return `<li class="lead" data-id="${p.id}">
        <span class="lead-dot" style="background:${st.color}" title="${esc(st.label)}"></span>
        <div class="lead-main">
          <div class="lead-addr">${esc(p.address || (p.lookup === 'pending' ? 'Looking up parcel...' : 'No parcel found'))}</div>
          <div class="lead-sub">${esc([p.city, p.zip].filter(Boolean).join(' '))}${p.parcelId ? ` · <span class="lead-pid">${esc(prettyParcel(p))}</span>` : ''}</div>
          <div class="lead-sub">${esc(st.label)} · ${esc(fmtDate(p.createdAt))}${ses ? ` · Drive: ${esc(sessionLabel(ses))}` : ''}</div>
          ${(p.tags || []).length ? `<div class="mini-tags">${p.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
        </div>
      </li>`;
    }).join('') : `<li class="empty">${pins.size ? 'No leads match these filters.' : 'No pins yet. Tap a property on the map to pin it.'}</li>`;
  }

  function statusCounts(list) {
    const counts = {};
    for (const p of list) counts[p.status] = (counts[p.status] || 0) + 1;
    return STATUSES.filter((s) => counts[s.id]).map((s) => ({ ...s, n: counts[s.id] }));
  }
  function renderSessions() {
    const sessions = sortedSessions();
    const loose = pinsInSession('');
    const miles = sessions.reduce((m, t) => m + trailMiles(t), 0);
    const inDrives = pins.size - loose.length;
    $('listCount').textContent = `(${sessions.length} drive${sessions.length === 1 ? '' : 's'})`;
    $('sessionSummary').innerHTML = sessions.length
      ? `<b>${sessions.length}</b> drive${sessions.length === 1 ? '' : 's'} · <b>${miles.toFixed(1)}</b> mi · <b>${inDrives}</b> pin${inDrives === 1 ? '' : 's'} dropped while driving`
      : 'No drives yet. Tap <b>Start driving</b> to record a session.';
    const row = (id, title, sub, list, isDrive, live) => `
      <li class="session" data-id="${esc(id)}">
        <div class="session-top">
          <div class="lead-main">
            <div class="lead-addr">${esc(title)}${live ? ' <span class="badge">Driving now</span>' : ''}</div>
            <div class="lead-sub">${sub}</div>
            ${list.length ? `<div class="mini-tags">${statusCounts(list).map((s) => `<span style="border-color:${s.color}"><i class="lead-dot" style="background:${s.color}"></i>${s.n} ${esc(s.label)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="session-count"><b>${list.length}</b><span>pin${list.length === 1 ? '' : 's'}</span></div>
        </div>
        <div class="session-actions">
          <button class="btn btn-sm" type="button" data-sact="pins" ${list.length ? '' : 'disabled'}>View pins</button>
          <button class="btn btn-sm" type="button" data-sact="map">Show on map</button>
          <button class="btn btn-sm" type="button" data-sact="export" ${list.length ? '' : 'disabled'}>Export CSV</button>
          ${isDrive ? `<button class="btn btn-sm" type="button" data-sact="rename">Rename</button>
          ${live ? '' : '<button class="btn btn-sm btn-danger" type="button" data-sact="delete">Delete</button>'}` : ''}
        </div>
      </li>`;
    const rows = sessions.map((t) => {
      const list = pinsInSession(t.id);
      const live = trail && t.id === trail.id;
      const sub = [
        t.name ? `${fmtDay(t.startedAt)}` : '',
        `${fmtTime(t.startedAt)} to ${live ? 'now' : fmtTime(trailEnd(t))}`,
        fmtDuration(sessionMinutes(t)),
        `${trailMiles(t).toFixed(1)} mi`,
      ].filter(Boolean).map(esc).join(' · ');
      return row(t.id, sessionLabel(t), sub, list, true, live);
    });
    if (loose.length) rows.push(row('none', 'Not during a drive', 'Pins dropped while not recording a drive', loose, false, false));
    $('sessionList').innerHTML = rows.join('') || '<li class="empty">Your drives show up here, with the pins you dropped on each one.</li>';
  }

  function setTab(tab) {
    listTab = tab;
    for (const b of document.querySelectorAll('.tabbar .tab')) {
      const on = b.dataset.tab === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on);
    }
    $('pinsView').hidden = tab !== 'pins';
    $('sessionsView').hidden = tab !== 'sessions';
    if (tab === 'pins') fillFilters();
    renderList();
  }
  document.querySelectorAll('.tabbar .tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  function openList() { fillFilters(); renderList(); $('listPanel').hidden = false; }
  $('btnList').addEventListener('click', openList);
  $('btnCount').addEventListener('click', () => { setTab('pins'); openList(); });
  ['listSearch', 'filterStatus', 'filterTag', 'filterSession', 'sortBy'].forEach((id) => $(id).addEventListener('input', renderList));
  $('leadList').addEventListener('click', (e) => {
    const li = e.target.closest('.lead');
    if (!li) return;
    const pin = pins.get(li.dataset.id);
    if (!pin) return;
    $('listPanel').hidden = true;
    map.setView([pin.lat, pin.lng], Math.max(map.getZoom(), 18));
    follow = false; updateLocateBtn();
    select(pin.id, 'peek');
  });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { $(b.dataset.close).hidden = true; }));

  $('sessionList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-sact]');
    const li = e.target.closest('.session');
    if (!btn || !li) return;
    const id = li.dataset.id === 'none' ? '' : li.dataset.id;
    const t = trails.get(id);
    const act = btn.dataset.sact;
    if (act === 'pins') {
      $('listSearch').value = ''; $('filterStatus').value = ''; $('filterTag').value = '';
      setTab('pins');
      $('filterSession').value = id || 'none';
      renderList();
    } else if (act === 'map') showSessionOnMap(id);
    else if (act === 'export') {
      const name = t ? `drive-${new Date(t.startedAt).toISOString().slice(0, 10)}-leads.csv` : `leads-not-in-a-drive-${stamp()}.csv`;
      await exportLeads(pinsInSession(id).sort(SORTS.oldest), name);
    } else if (act === 'rename' && t) {
      const name = prompt('Name this drive (leave empty to use the date):', t.name || '');
      if (name === null) return;
      t.name = name.trim().slice(0, 80);
      if (!t.name) delete t.name;
      await DB.put('trails', t);
      renderList();
    } else if (act === 'delete' && t) {
      const n = pinsInSession(id).length;
      if (!confirm(`Delete the drive "${sessionLabel(t)}"? Its route is removed.${n ? ` Its ${n} pin${n === 1 ? ' is' : 's are'} kept.` : ''}`)) return;
      // Pins keep their place in the list; pin them to "not during a drive" so time matching can't move them.
      for (const p of pinsInSession(id)) { p.sessionId = 'deleted'; await DB.put('pins', p); }
      trails.delete(id);
      await DB.del('trails', id);
      focusLayer.clearLayers();
      drawTrails();
      renderList();
    }
  });

  function showSessionOnMap(id) {
    focusLayer.clearLayers();
    const t = trails.get(id);
    const list = pinsInSession(id);
    const pts = [...(t ? t.points : []), ...list.map((p) => [p.lat, p.lng])];
    if (!pts.length) { toast('Nothing to show on the map for this session yet.'); return; }
    if (t && t.points.length > 1) {
      L.polyline(t.points, { renderer: trailRenderer, color: '#D4882A', weight: 6, opacity: 0.9, interactive: false }).addTo(focusLayer);
    }
    $('listPanel').hidden = true;
    closeSheet();
    follow = false; updateLocateBtn();
    map.fitBounds(L.latLngBounds(pts), { padding: [48, 48], maxZoom: 18 });
    toast(`${t ? sessionLabel(t) : 'Not during a drive'}: ${list.length} pin${list.length === 1 ? '' : 's'}`, 'Hide route', () => focusLayer.clearLayers(), 8000);
  }

  const CSV_COLUMNS = [
    'Parcel Number', 'Parcel Number (Formatted)', 'Property Address', 'Property City', 'Property State', 'Property Zip',
    'County', 'Owner First Name', 'Owner Last Name', 'Owner Full Name', 'Status', 'Tags', 'Notes',
    'Market Value', 'Year Built', 'Building Sq Ft', 'Acres', 'Owner Occupied', 'Latitude', 'Longitude', 'Date Added', 'Map Link',
    'Drive Session',
  ];
  const FREE_TEXT = new Set([7, 8, 9, 10, 11, 12, 22]); // columns people type into
  function splitName(full) {
    const n = (full || '').trim();
    if (!n) return ['', ''];
    if (n.includes(',')) { const [last, first] = n.split(',', 2); return [first.trim(), last.trim()]; } // "SMITH, JOHN"
    const parts = n.split(/\s+/);
    return parts.length === 1 ? ['', parts[0]] : [parts.slice(0, -1).join(' '), parts[parts.length - 1]];
  }
  function csvCell(v, freeText) {
    let s = String(v ?? '');
    if (freeText && /^[=+@\t\r-]/.test(s)) s = "'" + s; // keep spreadsheets from running it as a formula
    return /[",\n\r]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const csvText = (rows) => '﻿' + rows.map((r) => r.join(',')).join('\r\n') + '\r\n';
  function toCsv(list) {
    const rows = [CSV_COLUMNS];
    for (const p of list) {
      const d = p.details || {};
      const [first, last] = splitName(p.ownerName);
      const ses = trails.get(sessionOf(p));
      rows.push([
        p.parcelId, prettyParcel(p), p.address, p.city, p.address || p.city ? STATE : '', p.zip,
        p.county, first, last, p.ownerName, (STATUS[p.status] || STATUS.new).label, (p.tags || []).join('; '), p.notes,
        d.value || '', d.yearBuilt || '', d.sqft || '', d.acres || '', d.primaryRes || '', p.lat, p.lng,
        new Date(p.createdAt).toISOString().slice(0, 10), `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`,
        ses ? sessionLabel(ses) : '',
      ].map((v, i) => csvCell(v, FREE_TEXT.has(i))));
    }
    return csvText(rows);
  }
  const SESSION_COLUMNS = ['Session', 'Date', 'Start Time', 'End Time', 'Duration (min)', 'Miles', 'Pins', ...STATUSES.map((s) => s.label), 'Pin Addresses'];
  function sessionsCsv() {
    const rows = [SESSION_COLUMNS];
    for (const t of sortedSessions()) {
      const list = pinsInSession(t.id).sort(SORTS.oldest);
      rows.push([
        sessionLabel(t), new Date(t.startedAt).toISOString().slice(0, 10), fmtTime(t.startedAt),
        trail && t.id === trail.id ? 'In progress' : fmtTime(trailEnd(t)), sessionMinutes(t), trailMiles(t).toFixed(2), list.length,
        ...STATUSES.map((s) => list.filter((p) => p.status === s.id).length),
        list.map(addressLine).join('; '),
      ].map((v, i) => csvCell(v, i === 0 || i === SESSION_COLUMNS.length - 1)));
    }
    return csvText(rows);
  }
  // One line per pin, for pasting into a text, email, or notes app.
  function addressLine(p) {
    const where = p.address
      ? `${p.address}${p.city ? ', ' + p.city : ''}, ${STATE}${p.zip ? ' ' + p.zip : ''}`
      : `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
    return where + (p.parcelId ? ` (Parcel ${prettyParcel(p)})` : '');
  }
  function sessionsText() {
    const out = [];
    for (const t of sortedSessions()) {
      const list = pinsInSession(t.id).sort(SORTS.oldest);
      out.push(`${sessionLabel(t)} · ${fmtDuration(sessionMinutes(t))} · ${trailMiles(t).toFixed(1)} mi · ${list.length} pin${list.length === 1 ? '' : 's'}`);
      list.forEach((p, i) => out.push(`  ${i + 1}. ${addressLine(p)}`));
      out.push('');
    }
    const loose = pinsInSession('').sort(SORTS.oldest);
    if (loose.length) {
      out.push(`Not during a drive · ${loose.length} pin${loose.length === 1 ? '' : 's'}`);
      loose.forEach((p, i) => out.push(`  ${i + 1}. ${addressLine(p)}`));
    }
    return out.join('\n').trim();
  }
  async function saveFile(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    if (coarse && navigator.canShare) {
      const file = new File([blob], name, { type: mime });
      if (navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: name }); return true; }
        catch (e) { if (e && e.name === 'AbortError') return false; }
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    return true;
  }
  const stamp = () => new Date().toISOString().slice(0, 10);

  async function exportLeads(list, name) {
    if (!list.length) { toast('Nothing to export with these filters.'); return; }
    const ok = await saveFile(name, toCsv(list), 'text/csv');
    if (!ok) return;
    const fresh = list.filter((p) => p.status === 'new');
    if (fresh.length && confirm(`Exported ${list.length} lead${list.length === 1 ? '' : 's'}.\n\nMark the ${fresh.length} new lead${fresh.length === 1 ? '' : 's'} as "Sent to skip trace"?`)) {
      await markSent(fresh);
    }
  }
  $('btnExport').addEventListener('click', () => exportLeads(filteredPins(), `skip-trace-leads-${stamp()}.csv`));
  $('btnCopyIds').addEventListener('click', () => {
    const ids = filteredPins().map((p) => p.parcelId).filter(Boolean);
    if (!ids.length) { toast('No parcel numbers in this list yet.'); return; }
    copyText(ids.join('\n'), `Copied ${ids.length} parcel number${ids.length === 1 ? '' : 's'}`);
  });
  $('btnCopyList').addEventListener('click', () => {
    const list = filteredPins();
    if (!list.length) { toast('Nothing in this list yet.'); return; }
    copyText(list.map((p, i) => `${i + 1}. ${addressLine(p)}`).join('\n'), `Copied ${list.length} address${list.length === 1 ? '' : 'es'}`);
  });
  $('btnMarkSent').addEventListener('click', async () => {
    const fresh = filteredPins().filter((p) => p.status === 'new');
    if (!fresh.length) { toast('No new leads in this list.'); return; }
    if (confirm(`Mark ${fresh.length} new lead${fresh.length === 1 ? '' : 's'} as "Sent to skip trace"?`)) await markSent(fresh);
  });
  async function markSent(list) {
    for (const p of list) { p.status = 'sent'; await savePin(p); }
    renderList();
    toast(`${list.length} marked as sent to skip trace.`);
  }
  $('btnExportSessions').addEventListener('click', () => {
    if (!trails.size) { toast('No drives to export yet.'); return; }
    saveFile(`driving-sessions-${stamp()}.csv`, sessionsCsv(), 'text/csv');
  });
  $('btnCopySessions').addEventListener('click', () => {
    const text = sessionsText();
    if (!text) { toast('No sessions or pins yet.'); return; }
    copyText(text, 'Sessions list copied');
  });

  async function copyText(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast(msg); } catch { toast('Copy failed.'); }
      ta.remove();
    }
  }

  // ── Settings panel ────────────────────────────────────────────────────────
  function openSettings() {
    $('setLines').checked = settings.parcelLines;
    $('setRoutes').checked = settings.showRoutes;
    $('setWake').checked = settings.wakeLock;
    $('setTags').value = settings.tags.join('\n');
    $('setSources').value = settings.sources.join('\n');
    $('settingsPanel').hidden = false;
    showStorage();
  }
  async function showStorage() {
    const photos = await DB.all('photos');
    const trails = await DB.all('trails');
    const miles = trails.reduce((s, t) => s + trailMiles(t), 0);
    let line = `${pins.size} pins, ${photos.length} photos, ${trails.length} drives (${miles.toFixed(1)} mi).`;
    try {
      if (navigator.storage && navigator.storage.persisted) {
        line += (await navigator.storage.persisted()) ? ' Storage is protected from automatic cleanup.' : ' Storage may be cleared by the browser if the phone runs low on space, so keep backups.';
      }
    } catch { /* ignore */ }
    $('storageInfo').textContent = line;
  }
  $('btnSettings').addEventListener('click', openSettings);
  $('btnSaveSettings').addEventListener('click', () => {
    const lines = (v) => v.split(/\n/).map((s) => s.trim()).filter(Boolean);
    settings.parcelLines = $('setLines').checked;
    settings.showRoutes = $('setRoutes').checked;
    settings.wakeLock = $('setWake').checked;
    settings.tags = [...new Set(lines($('setTags').value))];
    const src = lines($('setSources').value).filter((u) => /^https:\/\//i.test(u));
    settings.sources = src.length ? src : DEFAULT_SOURCES.slice();
    saveSettings();
    linesBounds = null;
    loadLines();
    drawTrails();
    if (!driving) releaseWakeLock(); else requestWakeLock();
    if (selectedId) renderSheet();
    $('settingsPanel').hidden = true;
    toast('Settings saved.');
  });
  $('btnResetSources').addEventListener('click', () => { $('setSources').value = DEFAULT_SOURCES.join('\n'); });

  async function blobToDataUrl(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  }
  $('btnBackup').addEventListener('click', async () => {
    const photos = await Promise.all((await DB.all('photos')).map(async (p) => ({ id: p.id, pinId: p.pinId, createdAt: p.createdAt, dataUrl: await blobToDataUrl(p.blob) })));
    const data = { app: 'mk-d4d', version: 1, exportedAt: new Date().toISOString(), settings, pins: [...pins.values()], trails: await DB.all('trails'), photos };
    await saveFile(`d4d-backup-${stamp()}.json`, JSON.stringify(data), 'application/json');
  });
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'mk-d4d' || !Array.isArray(data.pins)) throw new Error('Not a D4D backup file');
      if (!confirm(`Restore ${data.pins.length} pins from this backup? Pins already on this phone are kept.`)) return;
      let added = 0;
      for (const p of data.pins) {
        if (!p || !p.id || !isFinite(p.lat) || !isFinite(p.lng)) continue;
        if (pins.has(p.id) || findByParcel(p.parcelId, p.id)) continue;
        pins.set(p.id, p); await DB.put('pins', p); drawPin(p); added++;
      }
      for (const t of data.trails || []) {
        if (!t || !t.id || !Array.isArray(t.points) || trails.has(t.id)) continue;
        trails.set(t.id, t); await DB.put('trails', t);
      }
      for (const ph of data.photos || []) {
        if (!ph || !ph.dataUrl || !pins.has(ph.pinId)) continue;
        const blob = await (await fetch(ph.dataUrl)).blob();
        await DB.put('photos', { id: ph.id, pinId: ph.pinId, createdAt: ph.createdAt, blob });
      }
      updateCounts(); drawTrails(); showStorage();
      toast(`Restored ${added} pin${added === 1 ? '' : 's'}.`);
    } catch (err) { toast(`Could not restore: ${err.message}`); }
  });
  $('btnClearRoutes').addEventListener('click', async () => {
    if (!confirm('Delete all saved drives (routes and sessions)? Pins are kept.')) return;
    await DB.clear('trails');
    for (const id of [...trails.keys()]) if (!trail || id !== trail.id) trails.delete(id);
    focusLayer.clearLayers();
    drawTrails(); showStorage();
  });
  $('btnWipe').addEventListener('click', async () => {
    if (!confirm('Delete ALL pins, photos, and routes from this phone?')) return;
    if (!confirm('This cannot be undone. Download a backup first if you might need them. Delete everything?')) return;
    if (driving) await stopDriving();
    await Promise.all(['pins', 'photos', 'trails'].map((s) => DB.clear(s)));
    for (const id of [...pins.keys()]) undrawPin(id);
    pins.clear(); trails.clear(); focusLayer.clearLayers();
    closeSheet(); updateCounts(); drawTrails(); showStorage();
    toast('All data deleted.');
  });

  // ── Toast ─────────────────────────────────────────────────────────────────
  let toastTimer = null, toastDone = null;
  function hideToast() {
    $('toast').hidden = true;
    clearTimeout(toastTimer);
    const done = toastDone; toastDone = null;
    if (done) done();
  }
  function toast(msg, actionLabel, action, ms, onDone) {
    hideToast();
    const el = $('toast');
    el.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
    el.hidden = false;
    toastDone = onDone || null;
    if (actionLabel) el.querySelector('button').addEventListener('click', () => { action(); hideToast(); });
    toastTimer = setTimeout(hideToast, ms || 3500);
  }

  // ── Online/offline ────────────────────────────────────────────────────────
  function updateNet() { $('netStat').hidden = navigator.onLine; }
  window.addEventListener('online', () => { updateNet(); retryPending(); scheduleLines(); });
  window.addEventListener('offline', updateNet);

  // ── Boot ──────────────────────────────────────────────────────────────────
  $('btnLayer').addEventListener('click', () => setBasemap(settings.basemap === 'satellite' ? 'street' : 'satellite'));
  map.on('moveend', () => { saveView(); scheduleLines(); });
  window.addEventListener('pagehide', () => { if (trail) DB.put('trails', trail); });

  (async function boot() {
    setBasemap(settings.basemap);
    updateNet();
    try {
      for (const t of await DB.all('trails')) trails.set(t.id, t);
      for (const p of await DB.all('pins')) { pins.set(p.id, p); drawPin(p); }
    } catch (err) {
      toast('This browser blocked local storage, so pins cannot be saved. Try a normal (not private) window.');
    }
    updateCounts();
    drawTrails();
    loadLines();
    retryPending();
    retryTimer = setInterval(retryPending, 60000);
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* ignore */ }
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  })();

  // Exposed for automated tests only.
  window.__d4d = { map, pins, trails, toCsv, sessionsCsv, sessionOf, splitName, distToRings, normalize };
})();
