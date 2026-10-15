/*
 * FP400 floor map with paintable cells, like the Aqara app.
 * Grid: 16 columns x 20 rows of 0.5 m; x from -400 to 400 cm, y from 0 to 1000 cm in front of the sensor.
 * Cell index = row * 16 + column (row 0 is closest to the sensor).
 */
var FP_ZONE_COLORS = ['#0f7c8c', '#6b5bd2', '#d9488b', '#c98a00', '#2e9e5b', '#3a7bd5', '#b4532a', '#6c7a89'];
var FP_GRID = { cols: 16, rows: 20, cell: 50, xMin: -400 };

/*
 * Colours: follow Homey's look (light or dark). Signals, strongest first:
 *   1. the user's own choice in the app settings ("light" or "dark")
 *   2. a Homey dark mode class on the page
 *   3. Homey's CSS variables (--homey-background-color / --homey-text-color), if this page has them
 *   4. the real background colour of the page
 *   5. the phone setting
 * When the chosen look does not match the page background, the page background is painted too,
 * so there is never a dark block on a white page or the other way around.
 */
function fpParseColor(c) {
  if (!c || c === 'transparent') return null;
  var v = c.match(/[\d.]+/g);
  if (!v || v.length < 3) return null;
  if (v.length > 3 && Number(v[3]) === 0) return null;
  return v.slice(0, 3).map(Number);
}
function fpLum(rgb) { return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255; }
function fpResolveVar(name, prop) {
  var probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;' + prop + ':var(' + name + ')';
  document.body.appendChild(probe);
  var value = getComputedStyle(probe)[prop === 'color' ? 'color' : 'backgroundColor'];
  document.body.removeChild(probe);
  var raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? fpParseColor(value) : null;
}
function fpTheme(pref) {
  var root = document.documentElement, body = document.body;
  var info = { pref: pref || 'auto' };
  // measure Homey's page without our own paint
  root.style.removeProperty('background'); body.style.removeProperty('background');
  var classes = (root.className + ' ' + body.className).toLowerCase();
  info.classes = classes.trim();
  var pageBg = null;
  for (var el = body; el && !pageBg; el = el.parentElement) {
    pageBg = fpParseColor(getComputedStyle(el).backgroundColor);
  }
  info.pageBg = pageBg;
  info.homeyBg = fpResolveVar('--homey-background-color', 'background-color');
  info.homeyText = fpResolveVar('--homey-text-color', 'color');
  info.prefersDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);

  var dark, source;
  if (pref === 'light' || pref === 'dark') { dark = pref === 'dark'; source = 'choice'; }
  else if (/homey-dark-mode|\bdark\b/.test(classes)) { dark = true; source = 'class'; }
  else if (info.homeyBg) { dark = fpLum(info.homeyBg) < 0.5; source = 'homey-background'; }
  else if (info.homeyText) { dark = fpLum(info.homeyText) > 0.5; source = 'homey-text'; }
  else if (pageBg) { dark = fpLum(pageBg) < 0.5; source = 'page'; }
  else { dark = info.prefersDark; source = 'phone'; }
  info.dark = dark; info.source = source;

  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  function fits(c) { return c && (fpLum(c) < 0.5) === dark; }
  var paper = fits(info.homeyBg) ? info.homeyBg : fits(pageBg) ? pageBg : null;
  if (paper) root.style.setProperty('--paper', 'rgb(' + paper.join(',') + ')'); else root.style.removeProperty('--paper');
  var matches = fits(pageBg);
  if (!matches) {
    // The page behind this view does not match the chosen look: paint it ourselves.
    root.style.setProperty('background', 'var(--paper)', 'important');
    body.style.setProperty('background', 'var(--paper)', 'important');
  }
  info.painted = !matches;
  return info;
}

/** Re-check the look a few times and whenever Homey or the phone changes it. */
function fpWatchTheme(getPref, onChange) {
  function run() { var info = fpTheme(getPref()); if (onChange) onChange(info); return info; }
  [0, 300, 1000, 2500].forEach(function (ms) { setTimeout(run, ms); });
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', run); else if (mq.addListener) mq.addListener(run);
  }
  if (window.MutationObserver) {
    var obs = new MutationObserver(function () { run(); });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
  return run;
}

function fpCellInfo(cells) {
  var rows = cells.map(function (c) { return Math.floor(c / FP_GRID.cols); });
  return {
    count: cells.length,
    area: cells.length * 0.25,
    from: rows.length ? Math.min.apply(null, rows) * 0.5 : 0,
    to: rows.length ? (Math.max.apply(null, rows) + 1) * 0.5 : 0,
  };
}

function FpMap(canvas, options) {
  var self = this;
  var G = FP_GRID;
  // Free space around the grid (in cells), so people at the edge or right in front of the sensor stay visible.
  var PAD = { side: 1, top: 1.9, bottom: 1.6 };
  var ctx = canvas.getContext('2d');
  var css = getComputedStyle(document.documentElement);
  var data = { zones: {}, targets: [], zoneStates: {}, areas: { ignore: [], outside: [] } };
  var draft = new Set(), editing = null, mode = null, last = null;
  var drawnTargets = [], tap = null;
  self.mirror = false;

  function color(name) { return css.getPropertyValue(name).trim(); }

  function resize() {
    var w = canvas.clientWidth || 340;
    var size = w / (G.cols + 2 * PAD.side);
    var h = Math.round(size * (G.rows + PAD.top + PAD.bottom));
    var r = window.devicePixelRatio || 1;
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * r);
    canvas.height = Math.round(h * r);
    ctx.setTransform(r, 0, 0, r, 0, 0);
    self.w = w; self.h = h; self.size = size;
    self.left = PAD.side * size;              // x of the grid's left edge
    self.base = h - PAD.bottom * size;        // y of the grid's bottom edge (the sensor's wall)
    render();
  }

  /* screen position of a cell (mirroring swaps columns) */
  function cellRect(index) {
    var col = index % G.cols, row = Math.floor(index / G.cols);
    if (self.mirror) col = G.cols - 1 - col;
    return { x: self.left + col * self.size, y: self.base - (row + 1) * self.size, s: self.size };
  }
  function cellAt(evt) {
    var b = canvas.getBoundingClientRect();
    var col = Math.floor((evt.clientX - b.left - self.left) / self.size);
    var row = Math.floor((self.base - (evt.clientY - b.top)) / self.size);
    if (col < 0 || col >= G.cols || row < 0 || row >= G.rows) return null;
    if (self.mirror) col = G.cols - 1 - col;
    return row * G.cols + col;
  }
  function sx(xcm) { var x = self.mirror ? -xcm : xcm; return self.left + (x - G.xMin) / G.cell * self.size; }
  function sy(ycm) { return self.base - ycm / G.cell * self.size; }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function fillCell(index, style, alpha, inset) {
    var c = cellRect(index), i = inset || 1.5;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = style;
    roundRect(c.x + i, c.y + i, c.s - 2 * i, c.s - 2 * i, Math.min(5, c.s / 5));
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawArea(cell, type, strength) {
    var c = cellRect(cell), i = 1.5;
    if (type === 'ignore') {
      fillCell(cell, '#c2352b', Math.min(1, 0.32 * strength));
    } else {
      fillCell(cell, color('--ink'), Math.min(1, 0.12 * strength));
      ctx.save();
      ctx.beginPath(); ctx.rect(c.x + i, c.y + i, c.s - 2 * i, c.s - 2 * i); ctx.clip();
      ctx.strokeStyle = color('--muted'); ctx.lineWidth = 1; ctx.globalAlpha = Math.min(1, 0.5 * strength);
      for (var k = -c.s; k < c.s; k += 6) { ctx.beginPath(); ctx.moveTo(c.x + k, c.y + c.s); ctx.lineTo(c.x + k + c.s, c.y); ctx.stroke(); }
      ctx.restore();
    }
  }

  function render() {
    if (!self.w) return;
    var W = self.w, H = self.h;
    ctx.clearRect(0, 0, W, H);

    var ox = sx(0), oy = self.base;

    // empty cells
    for (var i = 0; i < G.cols * G.rows; i++) fillCell(i, color('--line'), 0.45, 2.5);

    // metre labels every 2 m on the left edge
    ctx.fillStyle = color('--muted'); ctx.font = '11px ' + color('--font');
    for (var m = 2; m <= 10; m += 2) ctx.fillText(m + ' m', self.left + 4, sy(m * 100) + 12);

    // the sensor's own areas: ignore spots (red) and outside the room (hatched)
    ['outside', 'ignore'].forEach(function (type) {
      if (editing === 'area:' + type) return;
      (data.areas[type] || []).forEach(function (cell) { drawArea(cell, type, 1); });
    });

    // saved zones; the one being edited is drawn from the draft instead
    Object.keys(data.zones).forEach(function (id) {
      if (String(id) === String(editing)) return;
      var z = data.zones[id], c = FP_ZONE_COLORS[(id - 1) % 8], st = data.zoneStates[id] || {};
      (z.cells || []).forEach(function (cell) { fillCell(cell, c, st.occupied ? 0.75 : 0.4); });
      label(z.name, z.cells, c);
    });

    // draft (painting)
    if (typeof editing === 'string' && editing.indexOf('area:') === 0) {
      var type = editing.slice(5);
      draft.forEach(function (cell) { drawArea(cell, type, 1.6); });
    } else {
      var draftColor = editing && editing !== 'new' ? FP_ZONE_COLORS[(editing - 1) % 8] : color('--ink');
      draft.forEach(function (cell) { fillCell(cell, draftColor, 0.95); });
    }

    // people
    // people: never drawn off the map; outside the grid they are clamped to the edge and shown with a ring.
    // Targets on an ignore spot or outside the room are grey: they do not count for zones.
    drawnTargets = [];
    data.targets.forEach(function (p) {
      var rad = Math.max(6, self.size * 0.32);
      var px = sx(p.x), py = sy(p.y);
      var cx = Math.min(Math.max(px, rad + 2), W - rad - 2), cy = Math.min(Math.max(py, rad + 2), H - rad - 2);
      var outside = cx !== px || cy !== py || p.y < 0 || p.y >= G.rows * G.cell || p.x < G.xMin || p.x >= -G.xMin;
      drawnTargets.push({ t: p, x: cx, y: cy, r: rad });
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, 6.29);
      if (p.ignored) {
        ctx.fillStyle = color('--paper'); ctx.fill();
        ctx.strokeStyle = color('--muted'); ctx.lineWidth = 3; ctx.stroke();
      } else if (outside) {
        ctx.strokeStyle = color('--target'); ctx.lineWidth = 3; ctx.stroke();
      } else {
        ctx.fillStyle = color('--target');
        ctx.fill();
        ctx.strokeStyle = color('--paper'); ctx.lineWidth = 2; ctx.stroke();
      }
    });

    // sensor, on the wall just below the grid
    ctx.fillStyle = color('--ink');
    roundRect(ox - 16, oy + self.size * 0.55, 32, 6, 3); ctx.fill();
  }

  function label(name, cells, c) {
    if (!cells || !cells.length) return;
    // top row of the zone, leftmost cell on screen
    var best = null;
    cells.forEach(function (cell) {
      var r = cellRect(cell);
      if (!best || r.y < best.y || (r.y === best.y && r.x < best.x)) best = r;
    });
    ctx.font = '600 11px ' + color('--font');
    var tw = ctx.measureText(name).width + 10;
    var x = Math.min(best.x, self.w - tw - 2), y = Math.max(best.y - 18, 2);
    ctx.fillStyle = color('--paper'); ctx.globalAlpha = 0.9; roundRect(x, y, tw, 16, 8); ctx.fill(); ctx.globalAlpha = 1;
    ctx.fillStyle = c; ctx.fillText(name, x + 5, y + 12);
  }

  /* painting: the first cell decides whether this stroke paints or erases */
  function apply(cell) {
    if (cell === null) return;
    if (mode === 'paint') draft.add(cell); else draft.delete(cell);
  }
  function line(a, b) {
    // walk the grid between two cells so a fast swipe leaves no gaps
    var ac = a % G.cols, ar = Math.floor(a / G.cols), bc = b % G.cols, br = Math.floor(b / G.cols);
    var steps = Math.max(Math.abs(bc - ac), Math.abs(br - ar));
    for (var s = 1; s <= steps; s++) {
      apply(Math.round(ar + (br - ar) * s / steps) * G.cols + Math.round(ac + (bc - ac) * s / steps));
    }
  }
  function hitTarget(e) {
    var b = canvas.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    for (var i = drawnTargets.length - 1; i >= 0; i--) {
      var d = drawnTargets[i];
      if (Math.hypot(d.x - x, d.y - y) <= d.r + 6) return d;
    }
    return null;
  }
  canvas.addEventListener('pointerdown', function (e) {
    if (options.onTargetTap) {
      var hit = hitTarget(e);
      if (hit) { tap = { t: hit.t, x: e.clientX, y: e.clientY }; return; }
    }
    if (!options.paint) return;
    var cell = cellAt(e);
    if (cell === null) return;
    mode = draft.has(cell) ? 'erase' : 'paint';
    apply(cell); last = cell;
    canvas.setPointerCapture(e.pointerId);
    render(); changed();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!mode) return;
    var cell = cellAt(e);
    if (cell === null || cell === last) return;
    line(last, cell); last = cell;
    render(); changed();
  });
  function end() { mode = null; last = null; }
  canvas.addEventListener('pointerup', function (e) {
    if (tap) {
      var moved = Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10;
      var t = tap.t; tap = null;
      if (!moved) options.onTargetTap(t);
    }
    end();
  });
  canvas.addEventListener('pointercancel', function () { tap = null; end(); });
  window.addEventListener('resize', resize);

  function changed() { if (options.onChange) options.onChange(self.getDraft()); }

  self.setData = function (d) {
    data = { zones: d.zones || {}, targets: d.targets || [], zoneStates: d.zoneStates || {}, areas: d.areas || { ignore: [], outside: [] } };
    if (!mode) render();
  };
  /* editing: slot id of the zone being edited, 'new' for a new zone, null for none */
  self.edit = function (slot, cells) {
    editing = slot;
    draft = new Set(cells || []);
    render();
  };
  self.clear = function () { draft = new Set(); render(); changed(); };
  self.getDraft = function () { return Array.from(draft).sort(function (a, b) { return a - b; }); };
  self.cellsAround = function (t) {
    var col = Math.floor((t.x - G.xMin) / G.cell), row = Math.floor(t.y / G.cell), out = [];
    // the 2 x 2 cells (1 x 1 m) whose shared corner is nearest to the target
    var c0 = (t.x - G.xMin) / G.cell - col < 0.5 ? col - 1 : col;
    var r0 = t.y / G.cell - row < 0.5 ? row - 1 : row;
    for (var r = r0; r <= r0 + 1; r++) for (var c = c0; c <= c0 + 1; c++) {
      if (r >= 0 && r < G.rows && c >= 0 && c < G.cols) out.push(r * G.cols + c);
    }
    return out;
  };
  self.render = render;
  self.resize = resize;
  resize();
}

/*
 * "Zone is empty after": quick choices plus "Custom" with a number field (0 to 300 seconds,
 * the range the zone logic accepts). Built once, so typing in the field never loses focus.
 * onChange(seconds) gets a whole number, or null while the field holds something invalid.
 */
function FpTimeoutPicker(seg, field, input, error, labels, onChange) {
  var PRESETS = [0, 5, 15, 30];
  var MAX = 300;
  var custom = false;
  var buttons = [];
  seg.innerHTML = '';
  PRESETS.concat(['custom']).forEach(function (p) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'num';
    b.textContent = p === 'custom' ? labels.custom : p + ' s';
    b.addEventListener('click', function () {
      if (p === 'custom') {
        custom = true;
        render();
        input.focus();
        report();
      } else {
        custom = false;
        input.value = String(p);
        render();
        onChange(p);
      }
    });
    buttons.push({ el: b, value: p });
    seg.appendChild(b);
  });
  input.setAttribute('min', '0');
  input.setAttribute('max', String(MAX));
  input.setAttribute('step', '1');
  input.setAttribute('inputmode', 'numeric');
  input.addEventListener('input', report);

  function parse() {
    var raw = String(input.value).trim();
    if (!/^\d+$/.test(raw)) return null;
    var n = Number(raw);
    return n >= 0 && n <= MAX ? n : null;
  }
  function report() {
    var n = parse();
    error.hidden = n !== null;
    error.textContent = labels.invalid;
    input.classList.toggle('invalid', n === null);
    onChange(n);
  }
  function render() {
    var current = parse();
    buttons.forEach(function (b) {
      var on = b.value === 'custom' ? custom : (!custom && current === b.value);
      b.el.setAttribute('aria-pressed', String(on));
    });
    field.hidden = !custom;
    if (!custom) { error.hidden = true; input.classList.remove('invalid'); }
  }
  return {
    set: function (seconds) {
      if (document.activeElement === input) return;
      input.value = String(seconds);
      custom = PRESETS.indexOf(seconds) < 0;
      render();
    },
  };
}

/*
 * FP300 distance strip: 24 blocks of 0.25 m in front of the sensor (0 m at the bottom, 6 m at the top).
 * Same interface as FpMap (setData, edit, clear, getDraft, render, resize), so pages can swap them.
 * The block where the sensor measures the nearest person lights up.
 */
var FP_BLOCKS = 24, FP_BLOCK = 0.25;

function fpBlockInfo(blocks) {
  return {
    count: blocks.length,
    from: blocks.length ? Math.min.apply(null, blocks) * FP_BLOCK : 0,
    to: blocks.length ? (Math.max.apply(null, blocks) + 1) * FP_BLOCK : 0,
  };
}

function FpRow(canvas, options) {
  var self = this;
  var ctx = canvas.getContext('2d');
  var css = getComputedStyle(document.documentElement);
  var data = { zones: {}, zoneStates: {}, block: null, presence: null };
  var draft = new Set(), editing = null, mode = null, last = null, pulse = 0, timer = null;
  var LANE = 9, LABEL = 40, BOTTOM = 26;
  self.top = options.topPad || 14;
  self.mirror = false; // not used for a strip, kept for the same interface

  function color(name) { return css.getPropertyValue(name).trim(); }
  function zoneBlocks(z) { return z.blocks || z.cells || []; }

  function resize() {
    var w = canvas.clientWidth || 340;
    var rowH = Math.max(18, Math.min(26, Math.round(w / 15)));
    if (options.fitHeight) {
      // make all 6 m fit in the space the page has left, so nobody has to scroll over the strip
      var avail = options.fitHeight();
      if (avail > 0) rowH = Math.max(12, Math.min(26, Math.floor((avail - self.top - BOTTOM) / FP_BLOCKS)));
    }
    var h = self.top + FP_BLOCKS * rowH + BOTTOM;
    var r = window.devicePixelRatio || 1;
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * r); canvas.height = Math.round(h * r);
    ctx.setTransform(r, 0, 0, r, 0, 0);
    self.w = w; self.h = h; self.rowH = rowH;
    render();
  }
  function lanesWidth() { return Object.keys(data.zones).length * (LANE + 4); }
  function blockRect(b) {
    var x = LABEL, wid = self.w - LABEL - 8 - lanesWidth();
    return { x: x, y: self.top + (FP_BLOCKS - 1 - b) * self.rowH, w: wid, h: self.rowH };
  }
  function blockAt(evt) {
    var bb = canvas.getBoundingClientRect(), y = evt.clientY - bb.top, x = evt.clientX - bb.left;
    if (x < LABEL - 10) return null;
    var b = FP_BLOCKS - 1 - Math.floor((y - self.top) / self.rowH);
    return b >= 0 && b < FP_BLOCKS ? b : null;
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function render() {
    if (!self.w) return;
    ctx.clearRect(0, 0, self.w, self.h);
    var draftColor = editing === 'range' ? color('--radar')
      : editing && editing !== 'new' ? FP_ZONE_COLORS[(editing - 1) % 8] : color('--ink');
    ctx.font = '11px ' + color('--font');
    for (var b = 0; b < FP_BLOCKS; b++) {
      var r = blockRect(b), on = draft.has(b), here = data.block === b;
      ctx.globalAlpha = on ? 0.9 : 0.45;
      ctx.fillStyle = on ? draftColor : color('--line');
      roundRect(r.x, r.y + 1.5, r.w, r.h - 3, 5); ctx.fill();
      ctx.globalAlpha = 1;
      if (here) {
        // the block where the sensor sees someone: bright outline and a dot, gently pulsing
        var glow = 0.55 + 0.45 * Math.abs(Math.sin(pulse));
        ctx.strokeStyle = color('--target'); ctx.lineWidth = 3; ctx.globalAlpha = glow;
        roundRect(r.x + 1.5, r.y + 3, r.w - 3, r.h - 6, 5); ctx.stroke(); ctx.globalAlpha = 1;
        ctx.fillStyle = color('--target');
        ctx.beginPath(); ctx.arc(r.x + r.w / 2, r.y + r.h / 2, Math.min(7, r.h / 3), 0, 6.29); ctx.fill();
      }
      if (b % 4 === 0) {
        ctx.fillStyle = color('--muted');
        ctx.fillText((b * FP_BLOCK).toFixed(0) + ' m', 4, r.y + r.h + 4);
      }
      if (b % 2 === 0 && b % 4 !== 0 && self.rowH >= 16) {
        ctx.fillStyle = color('--muted'); ctx.globalAlpha = 0.6;
        ctx.fillText((b * FP_BLOCK).toFixed(1).replace('.', ','), 4, r.y + r.h + 4);
        ctx.globalAlpha = 1;
      }
    }
    ctx.fillStyle = color('--muted');
    ctx.fillText('6 m', 4, self.top + 4);

    // other zones as coloured lanes on the right
    var ids = Object.keys(data.zones), lx = self.w - 8 - lanesWidth();
    ids.forEach(function (id, i) {
      var z = data.zones[id], c = FP_ZONE_COLORS[(id - 1) % 8], st = data.zoneStates[id] || {};
      var x = lx + 4 + i * (LANE + 4);
      zoneBlocks(z).forEach(function (blk) {
        var r = blockRect(blk);
        ctx.globalAlpha = String(id) === String(editing) ? 1 : (st.occupied ? 0.9 : 0.5);
        ctx.fillStyle = c; roundRect(x, r.y + 1.5, LANE, r.h - 3, 3); ctx.fill();
      });
      ctx.globalAlpha = 1;
    });

    // sensor at the bottom
    ctx.fillStyle = color('--ink');
    roundRect(LABEL + (self.w - LABEL - 8 - lanesWidth()) / 2 - 16, self.h - BOTTOM + 14, 32, 6, 3); ctx.fill();
  }

  function apply(b) { if (b === null) return; if (mode === 'paint') draft.add(b); else draft.delete(b); }
  canvas.addEventListener('pointerdown', function (e) {
    if (!options.paint) return;
    var b = blockAt(e); if (b === null) return;
    mode = draft.has(b) ? 'erase' : 'paint';
    apply(b); last = b; canvas.setPointerCapture(e.pointerId); render(); changed();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!mode) return;
    var b = blockAt(e); if (b === null || b === last) return;
    var step = b > last ? 1 : -1;
    for (var k = last + step; k !== b + step; k += step) apply(k);
    last = b; render(); changed();
  });
  function end() { mode = null; last = null; }
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  window.addEventListener('resize', resize);
  function changed() { if (options.onChange) options.onChange(self.getDraft()); }

  function animate() {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (timer) clearInterval(timer);
    timer = null;
    if (data.block !== null && !reduce) timer = setInterval(function () { pulse += 0.25; render(); }, 60);
  }

  self.setData = function (d) {
    data = { zones: d.zones || {}, zoneStates: d.zoneStates || {}, block: d.block === undefined ? null : d.block, presence: d.presence };
    if ((data.block !== null) !== (timer !== null)) animate();
    if (!mode) render();
  };
  self.edit = function (slot, blocks) { editing = slot; draft = new Set(blocks || []); render(); };
  self.clear = function () { draft = new Set(); render(); changed(); };
  self.getDraft = function () { return Array.from(draft).sort(function (a, b) { return a - b; }); };
  self.setPaint = function (on) { options.paint = on; };
  self.destroy = function () { if (timer) clearInterval(timer); timer = null; };
  self.render = render;
  self.resize = resize;
  resize();
}
