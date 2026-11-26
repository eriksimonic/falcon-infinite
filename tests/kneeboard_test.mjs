// Headless acceptance tests for Feature 09:
//   src/ui/kneeboard.js  (KneeboardMap)
//   src/core/betty.js    (BitchingBetty)
//
// Runs under plain `node tests/kneeboard_test.mjs` — no DOM, no browser, no
// Web Speech implementation. The kneeboard renders against a minimal 2D
// canvas mock, exactly like the rest of the HUD stack.

import {
  KneeboardMap, bearingTo, cardinal8, formatGeoPosition, formatPlaceBearing,
  formatWorldOffset, nearestPlace,
} from '../src/ui/kneeboard.js';
import { BitchingBetty } from '../src/core/betty.js';

let checks = 0;
const failures = [];
function ok(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' - ' + detail : ''));
}
function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// ===========================================================================
// 1. Minimal 2D canvas mock
// ===========================================================================
function makeCanvas() {
  const state = {
    texts: [],
    textRuns: [],
    calls: 0,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    dashes: [],
  };
  const bump = (name) => { state.calls++; state.lastCall = name; };
  const ctx = {
    canvas: null,
    save() { bump('save'); },
    restore() { bump('restore'); },
    beginPath() { bump('beginPath'); },
    closePath() { bump('closePath'); },
    moveTo() { bump('moveTo'); },
    lineTo() { bump('lineTo'); },
    arc() { bump('arc'); },
    arcTo() { bump('arcTo'); },
    rect() { bump('rect'); },
    fill() { bump('fill'); },
    stroke() { bump('stroke'); },
    fillRect() { bump('fillRect'); },
    strokeRect() { bump('strokeRect'); },
    clearRect() { bump('clearRect'); },
    translate() { bump('translate'); },
    rotate() { bump('rotate'); },
    clip() { bump('clip'); },
    setLineDash(pattern) {
      bump('setLineDash');
      state.dashes.push(pattern);
    },
    fillText(text, x, y) {
      bump('fillText');
      const s = String(text);
      state.texts.push(s);
      state.textRuns.push({
        text: s,
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0,
        font: state.font,
        align: state.textAlign,
        fill: state.fillStyle,
      });
    },
    strokeText() { bump('strokeText'); },
    measureText(text) {
      bump('measureText');
      return { width: String(text).length * 6 };
    },
  };
  for (const key of ['font', 'fillStyle', 'strokeStyle', 'lineWidth', 'textAlign', 'textBaseline']) {
    Object.defineProperty(ctx, key, {
      get() { return state[key]; },
      set(v) { state[key] = v; },
    });
  }
  ctx.__state = state;
  return ctx;
}

// ===========================================================================
// 2. KneeboardMap — state, zoom, breadcrumbs
// ===========================================================================
{
  const map = new KneeboardMap();
  ok(map.visible === false, 'kneeboard starts hidden');
  ok(map.rangeM === 32000, 'default range is 32 km');
  ok(Array.isArray(map.track) && map.track.length === 0, 'track starts empty');
  ok(map.selectedAirport === null, 'no airport selected initially');

  ok(map.toggle() === true && map.visible === true, 'toggle opens the kneeboard');
  ok(map.toggle() === false && map.visible === false, 'toggle closes the kneeboard');

  // Zoom: 16000 -> 32000 -> 64000 -> 16000
  ok(map.cycleZoom() === 64000, '32 km cycles up to 64 km', String(map.rangeM));
  ok(map.rangeM === 64000, 'range stored at 64 km');
  ok(map.cycleZoom() === 16000, '64 km wraps to 16 km');
  ok(map.cycleZoom() === 32000, '16 km cycles up to 32 km');
  ok(map.cycleZoom() === 64000, '32 km cycles up to 64 km again');

  // Breadcrumb sampling: >= 150 m from the previous sample.
  const crumb = new KneeboardMap();
  ok(crumb.recordPosition(0, 0) === true, 'first breadcrumb recorded');
  ok(crumb.track.length === 1, 'one breadcrumb after first call');
  ok(crumb.recordPosition(0, 149) === false, '149 m does not add a breadcrumb');
  ok(crumb.recordPosition(149, 0) === false, 'still under 150 m from last sample');
  ok(crumb.recordPosition(150, 0) === true, '150 m adds a breadcrumb');
  ok(crumb.track.length === 2, 'two breadcrumbs after threshold crossing');
  ok(crumb.recordPosition(100, 0) === false, 'moving back under threshold is ignored');
  ok(crumb.recordPosition(NaN, 0) === false, 'NaN position ignored');
  ok(crumb.recordPosition(0, Infinity) === false, 'infinite position ignored');
  ok(crumb.track.length === 2, 'invalid positions do not grow the track');

  // Cap at 240 points, dropping the oldest.
  const capped = new KneeboardMap();
  let added = 0;
  for (let i = 0; i < 300; i++) if (capped.recordPosition(i * 200, 0)) added++;
  ok(added === 300, 'every 200 m sample is accepted', 'added=' + added);
  ok(capped.track.length === 240, 'track capped at 240 points', String(capped.track.length));
  ok(capped.track[capped.track.length - 1].x === 299 * 200, 'newest breadcrumb kept');
  ok(capped.track[0].x === (300 - 240) * 200, 'oldest breadcrumbs dropped', String(capped.track[0].x));

  // Clear wipes trail and diversion.
  capped.selectedAirport = { code: 'EDDF', x: 1, z: 2 };
  capped.clearTrack();
  ok(capped.track.length === 0, 'clearTrack empties the trail');
  ok(capped.selectedAirport === null, 'clearTrack clears the selection');
}

// ===========================================================================
// 3. KneeboardMap — airport click picking
// ===========================================================================
{
  const map = new KneeboardMap();
  map.toggle();
  const w = 1200;
  const h = 900;
  const g = map._geometry(w, h);
  ok(g.size > 0 && g.r > 0, 'panel geometry is sane');
  ok(g.x < w * 0.3, 'panel anchored on the centre-left');
  ok(Math.abs(g.cy - h * 0.5) < h * 0.1, 'panel vertically centred');

  const player = { x: 0, z: 0 };
  const airports = [
    { id: 'center', code: 'ZZZZ', heading: 0, x: 0, z: 0 },
    { id: 'east', code: 'EDDF', heading: 90, x: 8000, z: 0 },
    { id: 'east2', code: 'EGLL', heading: 0, x: 8600, z: 0 },
    { id: 'north', code: 'LFPG', heading: 45, x: 0, z: -6000 },
  ];

  const pxFor = (metres) => g.cx + (metres / (map.rangeM * 0.5)) * g.r;

  const centerPick = map.pickAirportAt(g.cx, g.cy, w, h, player, airports);
  ok(centerPick && centerPick.id === 'center', 'clicking the map centre picks the airport there');
  ok(map.selectedAirport === centerPick, 'selectedAirport stores the pick');

  const nearPick = map.pickAirportAt(pxFor(8200), g.cy, w, h, player, airports);
  ok(nearPick && nearPick.id === 'east', 'nearest airport to the click wins', nearPick && nearPick.id);
  ok(map.selectedAirport === nearPick, 'selection follows the nearest pick');

  const northPick = map.pickAirportAt(g.cx, g.cy - (6000 / (map.rangeM * 0.5)) * g.r, w, h, player, airports);
  ok(northPick && northPick.id === 'north', 'north is up on the chart (-Z)', northPick && northPick.id);

  // Flight position offsets the projection.
  const movedFlight = { position: { x: 8000, z: 0 }, heading: 270 };
  const movedPick = map.pickAirportAt(g.cx, g.cy, w, h, movedFlight, airports);
  ok(movedPick && movedPick.id === 'east', 'picking honours flight.position', movedPick && movedPick.id);

  // A click far from any icon clears the selection.
  const miss = map.pickAirportAt(g.x + g.size - 12, g.y + g.headerH + 12, w, h, player, airports);
  ok(miss === null, 'empty chart click returns null');
  ok(map.selectedAirport === null, 'empty chart click clears the selection');

  // Outside the panel, hidden, and degenerate input.
  ok(map.pickAirportAt(2, 2, w, h, player, airports) === null, 'click outside the panel is ignored');
  ok(map.pickAirportAt(NaN, 10, w, h, player, airports) === null, 'NaN click is ignored');
  ok(map.pickAirportAt(g.cx, g.cy, 0, h, player, airports) === null, 'zero width is ignored');

  map.visible = false;
  ok(map.pickAirportAt(g.cx, g.cy, w, h, player, airports) === null, 'hidden kneeboard never picks');

  // Zoom changes the pixel scale.
  map.visible = true;
  map.rangeM = 16000;
  const tightG = map._geometry(w, h);
  const widePick = map.pickAirportAt(
    tightG.cx + (8000 / (map.rangeM * 0.5)) * tightG.r,
    tightG.cy,
    w, h, player, airports,
  );
  ok(widePick && widePick.id === 'east', 'picking respects the current zoom', widePick && widePick.id);
}

// ===========================================================================
// 4. KneeboardMap.draw — terrain, symbology, caching
// ===========================================================================
{
  const canvas = makeCanvas();
  const ctx = canvas;
  const map = new KneeboardMap();
  map.visible = true;

  const state = {
    x: 0,
    z: 0,
    heading: 123,
    heightAt: (x, z) => 400 + Math.sin(x / 6000) * 1200 + Math.cos(z / 5000) * 900,
    airports: [
      { id: 'a1', code: 'EDDF', heading: 90, x: 2000, z: -1500, elevation: 120 },
      { id: 'a2', code: 'EGLL', heading: 0, x: -6000, z: 4000, elevation: 30 },
      { id: 'a3', code: 'LFPG', heading: 45, x: 12000, z: 9000, elevation: 90 },
    ],
    targets: [
      { id: 'sam-1', kind: 'SAM', alive: true, x: 5000, z: -5000 },
      { id: 'mig-1', kind: 'BANDIT', alive: true, airborne: true, position: { x: -3000, z: -4000 } },
      { id: 'dead-1', kind: 'DEPOT', alive: false, x: 1000, z: 1000 },
    ],
    tanker: { x: -8000, z: 6000, label: 'TEXACO' },
    steerpoint: { label: 'ALPHA', x: 9000, z: 8000 },
    wind: { dirDeg: 270, kts: 18 },
  };

  map.recordPosition(0, 0);
  map.recordPosition(600, -200);

  let threw = null;
  try {
    map.draw(ctx, 1200, 900, state);
  } catch (err) {
    threw = err;
  }
  ok(!threw, 'draw runs headless with full state', threw && threw.message);
  ok(canvas.__state.calls > 300, 'draw issues a substantial number of canvas calls',
    'calls=' + canvas.__state.calls);

  const texts = canvas.__state.texts;
  ok(texts.includes('KNEEBOARD'), 'kneeboard title rendered');
  ok(texts.includes('RNG 32 KM'), 'range label rendered', texts.filter((t) => t.startsWith('RNG')).join('|'));
  ok(texts.includes('HDG 123'), 'heading readout rendered');
  ok(texts.includes('N') && texts.includes('E') && texts.includes('S') && texts.includes('W'),
    'compass cardinals rendered');
  ok(texts.includes('EDDF'), 'airport ICAO code rendered');
  ok(texts.includes('EGLL'), 'second airport ICAO code rendered');
  ok(texts.includes('TKR'), 'tanker TKR symbol rendered');
  ok(texts.includes('SAM'), 'target tactical symbol labelled');
  ok(texts.includes('STPT') && texts.includes('ALPHA'), 'steerpoint callout rendered');
  ok(texts.includes('270/18'), 'wind barb direction/speed rendered',
    texts.filter((t) => t.includes('/')).join('|'));

  // Terrain cache: built once, then reused until the aircraft moves > 8%.
  ok(map.gridBuilds === 1, 'terrain grid built on first draw', String(map.gridBuilds));
  const grid = map._grid;
  ok(grid && grid.rangeM === 32000, 'grid tagged with current range');
  ok(grid && grid.res === 15 && grid.heights.length === 15 * 15, 'grid resolution 15x15');
  ok(grid && Number.isFinite(grid.heights[7 * 15 + 7]), 'grid centre sample is finite');
  ok(grid && Math.abs(grid.heights[7 * 15 + 7] - state.heightAt(0, 0)) < 1e-3,
    'grid samples the real height field');

  map.draw(ctx, 1200, 900, state);
  ok(map.gridBuilds === 1, 'same position reuses the cached terrain grid', String(map.gridBuilds));

  map.draw(ctx, 1200, 900, { ...state, x: 2000 });
  ok(map.gridBuilds === 1, 'small move inside 8% of range keeps the cache', String(map.gridBuilds));

  map.draw(ctx, 1200, 900, { ...state, x: 3000 });
  ok(map.gridBuilds === 2, 'move beyond 8% of range resamples terrain', String(map.gridBuilds));

  // Zoom change invalidates the cache.
  map.cycleZoom();
  map.draw(ctx, 1200, 900, { ...state, x: 3000 });
  ok(map.gridBuilds === 3, 'zoom change rebuilds the grid', String(map.gridBuilds));
  ok(canvas.__state.texts.includes('RNG 64 KM'), 'header follows the zoom level');

  // Selected diversion must be plotted with a course line.
  canvas.__state.texts.length = 0;
  map.selectedAirport = state.airports[0];
  map.draw(ctx, 1200, 900, state);
  ok(canvas.__state.texts.includes('DIV EDDF'), 'selected airport diversion rendered',
    canvas.__state.texts.filter((t) => t.startsWith('DIV')).join('|'));

  // Nested flight state is accepted.
  canvas.__state.texts.length = 0;
  map.draw(ctx, 1000, 800, {
    flight: { position: { x: 0, z: 0 }, heading: 90 },
    heightAt: () => 200,
    airports: [],
    wind: {
      dirDeg: 0, kts: 7,
    },
  });
  ok(canvas.__state.texts.includes('HDG 090'), 'nested flight heading used');

  // Tolerant of missing / hostile state.
  threw = null;
  try {
    map.draw(ctx, 1200, 900, {});
    map.draw(ctx, 1200, 900, null);
    map.draw(ctx, 0, 0, state);
    map.draw(ctx, 1200, 900, { heightAt: () => NaN, airports: 'nope', targets: [null], wind: null });
    map.draw(null, 1200, 900, state);
  } catch (err) {
    threw = err;
  }
  ok(!threw, 'draw tolerates empty, invalid and null inputs', threw && threw.message);

  // Hidden map draws nothing at all.
  const hiddenCanvas = makeCanvas();
  const hidden = new KneeboardMap();
  hidden.draw(hiddenCanvas, 1200, 900, state);
  ok(hiddenCanvas.__state.calls === 0, 'hidden kneeboard draws nothing');
}

// ===========================================================================
// 5. KneeboardMap — place labels & live location bar
// ===========================================================================
{
  // ---- pure readout helpers ----------------------------------------------
  ok(formatPlaceBearing(900, 0, 'Grado') === 'OVER GRADO',
    'inside 1.5 km reads OVER <NAME>', formatPlaceBearing(900, 0, 'Grado'));
  ok(formatPlaceBearing(1500, 90, 'grado') === '1.5 KM E OF GRADO',
    'beyond 1.5 km reads DIST CARDINAL OF NAME', formatPlaceBearing(1500, 90, 'grado'));
  ok(formatPlaceBearing(12400, 225, 'Monfalcone') === '12 KM SW OF MONFALCONE',
    'kilometres round above 10 km', formatPlaceBearing(12400, 225, 'Monfalcone'));

  ok(cardinal8(0) === 'N' && cardinal8(45) === 'NE' && cardinal8(90) === 'E'
    && cardinal8(180) === 'S' && cardinal8(225) === 'SW' && cardinal8(270) === 'W'
    && cardinal8(359) === 'N', 'compass cardinals follow the bearing');
  ok(bearingTo({ x: 0, z: 0 }, { x: 0, z: -1000 }) === 0,
    'north (-Z) is 000');
  ok(Math.abs(bearingTo({ x: 0, z: 0 }, { x: 1000, z: 0 }) - 90) < 1e-9,
    'east (+X) is 090');
  ok(Math.abs(bearingTo({ x: 0, z: 0 }, { x: 0, z: 1000 }) - 180) < 1e-9,
    'south (+Z) is 180');
  ok(Math.abs(bearingTo({ x: 0, z: 0 }, { x: -1000, z: 0 }) - 270) < 1e-9,
    'west (-X) is 270');

  const origin = { lat0: 45.89, lon0: 13.89 };
  ok(formatGeoPosition({ x: 0, z: 0 }, origin) === '45.89°N 13.89°E',
    'GPS readout at the geo origin', formatGeoPosition({ x: 0, z: 0 }, origin));
  ok(formatGeoPosition({ x: 0, z: -11132 }, origin) === '45.99°N 13.89°E',
    'north (-Z) raises the latitude', formatGeoPosition({ x: 0, z: -11132 }, origin));
  ok(formatGeoPosition({ x: 0, z: 11132 }, { lat0: -33.9, lon0: 18.4 }) === '34.00°S 18.40°E',
    'southern latitudes keep the S hemisphere',
    formatGeoPosition({ x: 0, z: 11132 }, { lat0: -33.9, lon0: 18.4 }));
  ok(String(formatGeoPosition({ x: -2000000, z: 0 }, origin)).endsWith('°W'),
    'west offsets flip the longitude hemisphere',
    formatGeoPosition({ x: -2000000, z: 0 }, origin));
  ok(formatGeoPosition({ x: 0, z: 0 }, null) === null, 'no geoOrigin yields no GPS string');
  ok(formatGeoPosition({ x: NaN, z: 0 }, origin) === null, 'NaN position yields no GPS string');
  ok(formatWorldOffset({ x: 3000, z: -2000 }) === '3.0E 2.0N KM',
    'world-offset fallback keeps east/north signs', formatWorldOffset({ x: 3000, z: -2000 }));
  ok(nearestPlace({ x: 0, z: 0 }, null) === null, 'no places yields no nearest entry');
  const near1 = nearestPlace({ x: 0, z: 0 }, [
    { name: 'Far', x: 9000, z: 0 }, { name: 'Near', x: 300, z: 400 },
  ]);
  ok(near1 && near1.place.name === 'Near' && Math.abs(near1.distM - 500) < 1e-9,
    'nearestPlace picks the closest entry', near1 && near1.place.name);

  // ---- place labels on the chart ----------------------------------------
  const W = 1200;
  const H = 900;
  const labels = new KneeboardMap();
  labels.visible = true;
  const g = labels._geometry(W, H);
  const chartTop = g.y + g.headerH;
  const chartBottom = chartTop + g.size;

  const placeCanvas = makeCanvas();
  const places = [
    { name: 'Monfalcone', kind: 'city', x: 0, z: -6000 },
    { name: 'Grado', kind: 'town', x: 6000, z: -2000 },
    { name: 'Aquileia', kind: 'landmark', x: -6000, z: 3000 },
  ];
  labels.draw(placeCanvas, W, H, { x: 0, z: 0, heading: 90, places });
  const placeTexts = placeCanvas.__state.texts;
  ok(placeTexts.includes('MONFALCONE'), 'city name label rendered', placeTexts.join('|'));
  ok(placeTexts.includes('GRADO'), 'town name label rendered');
  ok(placeTexts.includes('AQUILEIA'), 'landmark name label rendered');
  ok(labels.placesPlotted === 3, 'every visible place is labelled', String(labels.placesPlotted));

  let outsideSquare = 0;
  for (const run of placeCanvas.__state.textRuns) {
    if (!['MONFALCONE', 'GRADO', 'AQUILEIA'].includes(run.text)) continue;
    if (run.x < g.x || run.x > g.x + g.size || run.y < chartTop || run.y > chartBottom) {
      outsideSquare++;
    }
  }
  ok(outsideSquare === 0, 'place labels stay clipped inside the map square',
    `outside=${outsideSquare}`);

  // Overlapping labels are suppressed instead of smearing together.
  const clutter = new KneeboardMap();
  clutter.visible = true;
  const clutterCanvas = makeCanvas();
  clutter.draw(clutterCanvas, W, H, {
    x: 0, z: 0,
    places: [
      { name: 'Duino', kind: 'city', x: 0, z: -6000 },
      { name: 'Duino East', kind: 'city', x: 200, z: -6000 },
    ],
  });
  ok(clutter.placesPlotted === 1, 'colliding labels are dropped', String(clutter.placesPlotted));
  ok(clutterCanvas.__state.texts.includes('DUINO'), 'first label survives the clutter filter');
  ok(!clutterCanvas.__state.texts.includes('DUINO EAST'), 'colliding label is not drawn');

  // Off-chart places are neither labelled nor dotted.
  const offMap = new KneeboardMap();
  offMap.visible = true;
  const offCanvas = makeCanvas();
  offMap.draw(offCanvas, W, H, {
    x: 0, z: 0, places: [{ name: 'Udine', kind: 'city', x: 40000, z: 0 }],
  });
  ok(offMap.placesPlotted === 0, 'places outside the chart radius are not labelled');
  ok(!offCanvas.__state.texts.includes('UDINE'), 'off-chart place name is not drawn');

  // Label budget keeps the chart from turning into text soup.
  const busy = new KneeboardMap();
  busy.visible = true;
  const busyCanvas = makeCanvas();
  const gridPlaces = [];
  for (let i = 0; i < 40; i++) {
    gridPlaces.push({
      name: 'P' + i, kind: 'city', x: -7000 + (i % 8) * 2000, z: -7000 + Math.floor(i / 8) * 2000,
    });
  }
  busy.draw(busyCanvas, W, H, { x: 0, z: 0, places: gridPlaces });
  ok(busy.placesPlotted <= 10, 'place labels are capped at 10', String(busy.placesPlotted));
  ok(busy.placesPlotted > 0, 'the nearest grid places still label', String(busy.placesPlotted));

  // Hostile place payloads never throw.
  const junk = new KneeboardMap();
  junk.visible = true;
  let threw = null;
  try {
    junk.draw(makeCanvas(), W, H, {
      x: 0, z: 0,
      places: [null, undefined, {}, { name: '', x: 1, z: 2 }, { name: 'Bad', x: NaN, z: 0 }],
    });
    junk.draw(makeCanvas(), W, H, { x: 0, z: 0, places: 'nope', geoOrigin: 42 });
    junk.draw(makeCanvas(), W, H, { x: 0, z: 0, places: null, geoOrigin: null });
  } catch (err) {
    threw = err;
  }
  ok(!threw, 'hostile places / geoOrigin payloads are tolerated', threw && threw.message);
  ok(junk.placesPlotted === 0, 'invalid places plot nothing', String(junk.placesPlotted));

  // ---- live location bar -------------------------------------------------
  const live = new KneeboardMap();
  live.visible = true;
  const liveCanvas = makeCanvas();
  live.draw(liveCanvas, W, H, {
    x: 0, z: 0, heading: 0,
    places: [{ name: 'Grado', kind: 'city', x: 0, z: -1200 }],
    geoOrigin: origin,
  });
  ok(liveCanvas.__state.texts.includes('OVER GRADO'),
    'location bar reads OVER <NAME> inside 1.5 km', liveCanvas.__state.texts.join('|'));
  ok(liveCanvas.__state.texts.includes('45.89°N 13.89°E'),
    'location bar shows live GPS lat/lon', liveCanvas.__state.texts.join('|'));
  ok(live.location && Math.abs(live.location.nearest.distM - 1200) < 1e-6,
    'readout stores the nearest-place distance');

  const barBar = makeCanvas();
  live.draw(barBar, W, H, {
    x: 0, z: -2400, heading: 0,
    places: [{ name: 'Grado', kind: 'city', x: 0, z: 0 }],
    geoOrigin: origin,
  });
  ok(barBar.__state.texts.includes('2.4 KM S OF GRADO'),
    'location bar reads DIST CARDINAL OF NAME beyond 1.5 km',
    barBar.__state.texts.join('|'));
  ok(barBar.__state.texts.includes('45.91°N 13.89°E'),
    'GPS follows the aircraft north', barBar.__state.texts.join('|'));

  // Without a geo origin the bar falls back to world offsets.
  const noGeo = makeCanvas();
  live.draw(noGeo, W, H, { x: 3000, z: -2000, heading: 0, places: [] });
  ok(noGeo.__state.texts.includes('3.0E 2.0N KM'),
    'world-offset readout when no geoOrigin is supplied', noGeo.__state.texts.join('|'));
  ok(live.location && live.location.nearest === null, 'no places means no nearest-place line');

  // Nested flight state still feeds the bar.
  const nested = makeCanvas();
  live.draw(nested, W, H, {
    flight: { position: { x: 0, z: 0 }, heading: 270 },
    places: [{ name: 'Duino', kind: 'city', x: 4000, z: 0 }],
    geoOrigin: origin,
  });
  ok(nested.__state.texts.includes('4.0 KM E OF DUINO'),
    'nested flight.position feeds the location bar', nested.__state.texts.join('|'));
}

// ===========================================================================
// 6. BitchingBetty — priority, cooldowns, mute, announce
// ===========================================================================
function advance(betty, seconds, state, step = 0.05) {
  const results = [];
  const n = Math.max(1, Math.round(seconds / step));
  for (let i = 0; i < n; i++) results.push(betty.update(step, state));
  return results;
}

const PULL_UP_STATE = {
  onGround: false,
  crashed: false,
  aglFt: 600,
  vsFpm: -1200,
  stall: false,
  kts: 300,
  bingoFuel: false,
  missileLaunch: false,
  pullUpOverride: false,
};

{
  const chimes = [];
  const betty = new BitchingBetty({ onChime: (text, id) => chimes.push({ text, id }) });
  ok(betty.enabled === true, 'Betty enabled by default');
  ok(betty.muted === false, 'Betty unmuted by default');
  ok(betty.lastCallout === null, 'no callout yet');
  ok(betty.ttsAvailable === false, 'Node has no Web Speech, fallback path active');

  const first = betty.update(1 / 60, { ...PULL_UP_STATE, bingoFuel: true });
  ok(first.alertId === 'PULL_UP', 'PULL_UP wins over BINGO', String(first.alertId));
  ok(first.spoke === 'Pull up. Pull up.', 'pull-up phrase spoken', String(first.spoke));
  ok(betty.lastCallout === 'Pull up. Pull up.', 'lastCallout updated');
  ok(chimes.length === 1 && chimes[0].id === 'PULL_UP', 'fallback chime fired once');
  ok(chimes[0].text === 'Pull up. Pull up.', 'chime carries the phrase');

  const repeat = betty.update(1 / 60, { ...PULL_UP_STATE, bingoFuel: true });
  ok(repeat.alertId === 'BINGO', 'while PULL_UP cools, the next-priority alert may speak', String(repeat.alertId));
  const sameOnly = betty.update(1 / 60, PULL_UP_STATE);
  ok(sameOnly.spoke === null && sameOnly.alertId === null, 'same condition is suppressed by cooldown');

  const cooling = advance(betty, 3.3, PULL_UP_STATE);
  ok(cooling.every((r) => r.spoke === null), 'silent for the first 3.3 s of the 3.5 s cooldown');
  const rearmed = advance(betty, 0.3, PULL_UP_STATE);
  ok(rearmed.some((r) => r.alertId === 'PULL_UP'), 'PULL_UP re-fires after its cooldown');

  // Priority: missile beats stall.
  const missile = new BitchingBetty({ onChime: () => {} });
  const mr = missile.update(0.01, {
    aglFt: 5000, vsFpm: 0, stall: true, missileLaunch: true, kts: 0, bingoFuel: false,
  });
  ok(mr.alertId === 'MISSILE' && mr.spoke === 'Chaff. Flare.', 'missile launch outranks stall');
  const mr2 = missile.update(0.01, {
    aglFt: 5000, vsFpm: 0, stall: true, missileLaunch: true, kts: 0, bingoFuel: false,
  });
  ok(mr2.alertId === 'STALL', 'stall still announced once missile is cooling down', String(mr2.alertId));

  // Stall + its own 4.0 s cooldown.
  const stallBetty = new BitchingBetty({ onChime: () => {} });
  const sr = stallBetty.update(0.01, { aglFt: 5000, vsFpm: 0, stall: true });
  ok(sr.alertId === 'STALL' && sr.spoke === 'Warning. Stall.', 'stall warning spoken');
  const stallQuiet = advance(stallBetty, 3.8, { aglFt: 5000, vsFpm: 0, stall: true });
  ok(stallQuiet.every((r) => r.spoke === null), 'stall stays quiet inside 4 s cooldown');
  const stallAgain = advance(stallBetty, 0.3, { aglFt: 5000, vsFpm: 0, stall: true });
  ok(stallAgain.some((r) => r.alertId === 'STALL'), 'stall re-fires after 4 s');

  // Overspeed.
  const fast = new BitchingBetty({ onChime: () => {} });
  const fr = fast.update(0.01, { aglFt: 5000, vsFpm: 0, kts: 640 });
  ok(fr.alertId === 'OVERSPEED' && fr.spoke === 'Warning. Overspeed.', 'overspeed warning spoken');
  const notFast = fast.update(0.01, { aglFt: 5000, vsFpm: 0, kts: 620 });
  ok(notFast.spoke === null, 'exactly 620 kt does not trigger overspeed');

  // Bingo fuel with the long 18 s cooldown.
  const bingo = new BitchingBetty({ onChime: () => {} });
  const br = bingo.update(0.01, { aglFt: 5000, vsFpm: 0, bingoFuel: true });
  ok(br.alertId === 'BINGO' && br.spoke === 'Bingo fuel.', 'bingo fuel spoken');
  const bingoQuiet = advance(bingo, 17, { aglFt: 5000, vsFpm: 0, bingoFuel: true });
  ok(bingoQuiet.every((r) => r.spoke === null), 'bingo stays quiet inside 18 s cooldown');
  const bingoAgain = advance(bingo, 1.2, { aglFt: 5000, vsFpm: 0, bingoFuel: true });
  ok(bingoAgain.some((r) => r.alertId === 'BINGO'), 'bingo re-fires after 18 s');

  // Low altitude sink rate.
  const low = new BitchingBetty({ onChime: () => {} });
  const lr = low.update(0.01, { aglFt: 250, vsFpm: -300 });
  ok(lr.alertId === 'ALTITUDE' && lr.spoke === 'Altitude. Altitude.', 'altitude warning spoken');

  // Pull-up override forces the cue while airborne.
  const overrideBetty = new BitchingBetty({ onChime: () => {} });
  const or = overrideBetty.update(0.01, { aglFt: 5000, vsFpm: 0, pullUpOverride: true });
  ok(or.alertId === 'PULL_UP', 'pullUpOverride forces the pull-up cue');

  // Ground / crashed / muted silence.
  const ground = new BitchingBetty({ onChime: () => {} });
  const gr = ground.update(1 / 60, {
    onGround: true, aglFt: 0, vsFpm: -5000, stall: true, kts: 800,
    bingoFuel: true, missileLaunch: true,
  });
  ok(gr.spoke === null && gr.alertId === null, 'silent on the ground');
  ok(ground.chimeCount === 0 && ground.lastCallout === null, 'ground silence emits nothing');

  const crashed = new BitchingBetty({ onChime: () => {} });
  const cr = crashed.update(1 / 60, { ...PULL_UP_STATE, crashed: true });
  ok(cr.spoke === null && cr.alertId === null, 'silent after a crash');
  ok(crashed.chimeCount === 0, 'crash silence emits nothing');

  const muted = new BitchingBetty({ onChime: () => {} });
  ok(muted.setMuted(true) === true && muted.muted === true, 'setMuted(true) mutes Betty');
  const mrMuted = muted.update(1 / 60, PULL_UP_STATE);
  ok(mrMuted.spoke === null && mrMuted.alertId === null, 'muted Betty is silent');
  ok(muted.chimeCount === 0, 'muted Betty emits no chime');
  ok(muted.announce('Minimums') === false, 'muted announce is suppressed');
  ok(muted.setMuted(false) === false && muted.muted === false, 'setMuted(false) unmutes');
  const afterMute = muted.update(1 / 60, PULL_UP_STATE);
  ok(afterMute.alertId === 'PULL_UP', 'unmuting restores the alert immediately (cooldown untouched)');

  // announce()
  const announcing = new BitchingBetty({ onChime: (text, id) => chimes.push({ text, id }) });
  const announced = announcing.announce('Minimums');
  ok(announced === true, 'announce returns true when spoken');
  ok(announcing.lastCallout === 'Minimums', 'announce updates lastCallout');
  ok(chimes[chimes.length - 1].id === 'ANNOUNCE', 'announce uses the ANNOUNCE channel');
  ok(announcing.announce('') === false, 'empty announce is ignored');
  ok(announcing.announce(null) === false, 'non-string announce is ignored');

  // Hostile inputs never throw and never invent alerts.
  let threw = null;
  try {
    announcing.update(NaN, undefined);
    announcing.update(-1, null);
    announcing.update(Infinity, { ...PULL_UP_STATE });
    const hostile = announcing.update(1, { aglFt: NaN, vsFpm: NaN, kts: NaN, stall: 'yes' });
    ok(hostile.spoke === null, 'NaN telemetry does not trigger a callout');
  } catch (err) {
    threw = err;
  }
  ok(!threw, 'hostile inputs are safe', threw && threw.message);

  ok(finite(new BitchingBetty().chimeCount), 'chime counter is a number');
}

// ===========================================================================
// Summary
// ===========================================================================
console.log(`kneeboard checks: ${checks}, failures: ${failures.length}`);
for (const f of failures) console.log('  FAIL ' + f);
if (failures.length) {
  process.exitCode = 1;
} else {
  console.log('ALL KNEEBOARD CHECKS PASSED');
}