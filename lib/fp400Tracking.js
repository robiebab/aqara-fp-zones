'use strict';

/**
 * FP400 position decoding and software zones.
 *
 * Frame layout and zone logic are ported from the MIT licensed community converter
 * github.com/bobtekkk/aqara-fp400-zone-card (z2m/aqara-fp400.mjs), which builds on
 * the converter by jcastro in Zigbee2MQTT issue #33146.
 *
 * Coordinates are in centimetres from the sensor: x = left/right, y = distance in front.
 */

const MOTION_EVENTS = ['enter', 'leave', 'left_in', 'right_out', 'right_in', 'left_out', 'approach', 'away'];
const FRESH_MS = 30000;

/**
 * Cluster 0xFC0C, Aqara event 0x8B, event id 0: the list of tracked targets.
 * Returns undefined when this frame is not a target list, throws when it is unreadable.
 */
function decodeTrackingFrame(data) {
  if (!Buffer.isBuffer(data) || data.length < 7 || ![0x0c, 0x1c].includes(data[0])
    || data.readUInt16LE(1) !== 0x115f || data[4] !== 0x8b || data.readUInt16LE(5) !== 0) return undefined;
  if (data.length < 10 || data[7] !== 0x4c) throw new Error('Unsupported tracking array');
  const reported = data.readUInt16LE(8);
  if (reported > 10 || data.length > 10 + 25 * reported) throw new Error('Invalid tracking frame');
  const targets = [];
  const ids = new Set();
  const tags = [[0, 9], [1, 0], [2, 0x20], [4, 0x29], [7, 0x29], [10, 0x29], [13, 0x29], [16, 0x21], [19, 0x30], [21, 0x30], [23, 0x20]];
  for (let index = 0; index < reported; index++) {
    const r = data.subarray(10 + index * 25, 35 + index * 25);
    if (r.length < 16) break; // report cut off (some coordinators pass only 80 bytes)
    if (tags.some(([offset, tag]) => offset < r.length && r[offset] !== tag) || ids.has(r[3])) {
      throw new Error('Invalid tracking record');
    }
    ids.add(r[3]);
    targets.push({
      id: r[3],
      x: r.readInt16LE(5),
      y: r.readInt16LE(8),
      activity: r.readInt16LE(14), // 1 moving, 2 still
    });
  }
  return { targets, reported };
}

/** Cluster 0xFC0B, Aqara event 0x8B, event id 0: whole room movement event. */
function decodeMotionEvent(data) {
  if (!Buffer.isBuffer(data) || data.length < 8 || ![0x0c, 0x1c].includes(data[0])
    || data.readUInt16LE(1) !== 0x115f || data[4] !== 0x8b || data.readUInt16LE(5) !== 0) return undefined;
  const value = data.length >= 9 && [0x30, 0x20].includes(data[7]) ? data[8] : data[7];
  return MOTION_EVENTS[value];
}

/*
 * Zones are painted on the FP400 grid: 16 columns x 20 rows of 0.5 x 0.5 m
 * (x from -400 to 400 cm, y from 0 to 1000 cm). A zone is a list of cell indexes,
 * index = row * 16 + column, so any shape is possible.
 */
const GRID = { cols: 16, rows: 20, cell: 50, xMin: -400 };
const CELL_COUNT = GRID.cols * GRID.rows;

function cellOf(x, y) {
  const col = Math.floor((x - GRID.xMin) / GRID.cell);
  const row = Math.floor(y / GRID.cell);
  if (col < 0 || col >= GRID.cols || row < 0 || row >= GRID.rows) return null;
  return row * GRID.cols + col;
}

/** Older zones were rectangles in cm: convert to the cells whose centre lies inside. */
function cellsFromRect(z) {
  const cells = [];
  for (let row = 0; row < GRID.rows; row++) {
    for (let col = 0; col < GRID.cols; col++) {
      const cx = GRID.xMin + col * GRID.cell + GRID.cell / 2;
      const cy = row * GRID.cell + GRID.cell / 2;
      if (cx >= z.x_min && cx < z.x_max && cy >= z.y_min && cy < z.y_max) cells.push(row * GRID.cols + col);
    }
  }
  return cells;
}

/** Validate and normalise a zone coming from the map page or the wizard. */
function parseZone(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Zone must be an object');
  let cells = value.cells;
  if (!Array.isArray(cells) && ['x_min', 'x_max', 'y_min', 'y_max'].every(k => Number.isFinite(Number(value[k])))) {
    cells = cellsFromRect({
      x_min: Number(value.x_min), x_max: Number(value.x_max), y_min: Number(value.y_min), y_max: Number(value.y_max),
    });
  }
  if (!Array.isArray(cells)) throw new Error('Zone needs painted cells');
  const unique = [...new Set(cells.map(Number))].filter(n => Number.isInteger(n) && n >= 0 && n < CELL_COUNT).sort((a, b) => a - b);
  if (!unique.length) throw new Error('Paint at least one block');
  const zone = {
    name: String(value.name || '').trim().slice(0, 32) || 'Zone',
    cells: unique,
    absence_timeout: value.absence_timeout === undefined ? 3 : Number(value.absence_timeout),
  };
  if (!Number.isInteger(zone.absence_timeout) || zone.absence_timeout < 0 || zone.absence_timeout > 300) {
    throw new Error('Absence timeout must be 0 to 300 seconds');
  }
  return zone;
}

function inZone(t, z) {
  const cell = cellOf(t.x, t.y);
  if (cell === null) return false;
  if (!z._set) Object.defineProperty(z, '_set', { value: new Set(z.cells), enumerable: false });
  return z._set.has(cell);
}

class ZoneTracker {

  constructor(zones = {}) {
    this.zones = zones; // { slot: zone }
    this.lastFrameAt = null;
    this.presence = null; // room presence from endpoint 1
    this.slots = {}; // slot -> { occupied, outsideSince, ids:Set, awaiting }
    this.lastSeen = new Map();
    this.targets = [];
  }

  _slot(id) {
    if (!this.slots[id]) this.slots[id] = { occupied: undefined, outsideSince: null, ids: new Set(), awaiting: true };
    return this.slots[id];
  }

  setZones(zones) {
    for (const id of Object.keys({ ...this.zones, ...zones })) {
      if (JSON.stringify(this.zones[id]) !== JSON.stringify(zones[id])) delete this.slots[id];
    }
    this.zones = zones;
  }

  /** New target list. Returns enter/leave events. */
  accept(targets, reported, now) {
    this.lastFrameAt = now;
    this.targets = targets;
    const decoded = new Set(targets.map(t => t.id));
    const missing = reported - targets.length;
    const carried = missing > 0
      ? [...this.lastSeen.values()].filter(t => !decoded.has(t.id)).sort((a, b) => b.at - a.at).slice(0, missing)
      : [];
    const unaccounted = missing > carried.length;
    if (missing <= 0) this.lastSeen.clear();
    for (const t of targets) this.lastSeen.set(t.id, { ...t, at: now });
    const all = [...targets, ...carried];
    const events = [];
    for (const [id, zone] of Object.entries(this.zones)) {
      const slot = this._slot(id);
      const inside = all.filter(t => inZone(t, zone));
      const ids = new Set(inside.map(t => t.id));
      if (inside.length) {
        slot.occupied = true;
        slot.outsideSince = null;
      } else if (!unaccounted && slot.outsideSince === null) {
        slot.outsideSince = now;
      }
      if (!slot.awaiting) {
        for (const t of ids) if (!slot.ids.has(t)) events.push({ slot: Number(id), type: 'enter' });
        for (const t of slot.ids) if (!ids.has(t)) events.push({ slot: Number(id), type: 'leave' });
      }
      slot.ids = ids;
      slot.awaiting = false;
    }
    return events;
  }

  /** Room presence from the sensor itself. An empty room empties every zone. */
  setPresence(occupied) {
    this.presence = occupied;
    if (occupied) return [];
    const events = [];
    for (const id of Object.keys(this.zones)) {
      const slot = this._slot(id);
      for (let n = 0; n < slot.ids.size; n++) events.push({ slot: Number(id), type: 'leave' });
      slot.occupied = false;
      slot.ids = new Set();
      slot.outsideSince = null;
      slot.awaiting = false;
    }
    this.lastSeen.clear();
    this.targets = [];
    return events;
  }

  /** Current state per slot: { available, occupied, count }. */
  state(now) {
    const fresh = this.lastFrameAt !== null && now - this.lastFrameAt < FRESH_MS;
    const emptyRoom = this.presence === false;
    const result = {};
    for (const [id, zone] of Object.entries(this.zones)) {
      const slot = this._slot(id);
      if (slot.outsideSince !== null && now - slot.outsideSince >= zone.absence_timeout * 1000) {
        slot.occupied = false;
      }
      const known = emptyRoom || (!slot.awaiting && slot.occupied !== undefined && (fresh || this.presence === true));
      result[id] = {
        available: known,
        occupied: emptyRoom ? false : Boolean(slot.occupied),
        count: emptyRoom ? 0 : slot.ids.size,
      };
    }
    return result;
  }

  isFresh(now) {
    return this.lastFrameAt !== null && now - this.lastFrameAt < FRESH_MS;
  }

}

module.exports = {
  GRID,
  cellOf,
  cellsFromRect,
  MOTION_EVENTS,
  decodeTrackingFrame,
  decodeMotionEvent,
  parseZone,
  inZone,
  ZoneTracker,
};
