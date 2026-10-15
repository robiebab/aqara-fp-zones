'use strict';

/**
 * One table for every FP300 setting that lives in the sensor, used for all directions:
 *   writing   (Homey setting -> sensor attribute)    onSettings
 *   reading   (sensor attribute -> Homey setting)    after start, in reports and read answers
 *   checking  (read back after writing)              revert the Homey setting when the sensor differs
 * Having one table means writing and reading can never disagree.
 *
 * Values and ranges follow zigbee-herdsman-converters (src/devices/lumi.ts, model PS-S04D).
 */

const { AqaraLumiCluster } = require('./AqaraClusters');
const { REPORTING, toSensor: reportToSensor, fromSensor: reportFromSensor } = require('./fp300Reporting');

const RANGE_STEP = 0.25; // metres per detection block
const RANGE_BLOCKS = 24;

const intIn = (min, max) => r => (Number.isInteger(r) && r >= min && r <= max ? r : undefined);
const enumOf = values => r => (values.includes(r) ? String(r) : undefined);
const onOff = r => (r === 1 ? true : r === 0 ? false : undefined);

/** Plain settings: one setting <-> one attribute. */
// `values` / `min` `max` `step` describe what the Homey setting must allow (checked by npm test
// against driver.settings.compose.json, so the settings screen can never drift from this table).
const PLAIN = [
  { setting: 'sensitivity', attribute: 'motionSensitivity', toSensor: v => Number(v), fromSensor: enumOf([1, 2, 3]), values: [1, 2, 3] }, // 1 low, 2 medium, 3 high
  { setting: 'detection_mode', attribute: 'detectionMode', toSensor: v => Number(v), fromSensor: enumOf([0, 1, 2]), values: [0, 1, 2] }, // 0 both, 1 mmWave, 2 PIR
  { setting: 'absence_delay', attribute: 'absenceDelay', toSensor: v => Math.round(v), fromSensor: intIn(1, 300), min: 1, max: 300, step: 1 }, // Z2M 1 to 300 s
  { setting: 'pir_interval', attribute: 'pirInterval', toSensor: v => Math.round(v), fromSensor: intIn(2, 300), min: 2, max: 300, step: 1 }, // Z2M 2 to 300 s
  { setting: 'ai_adaptive', attribute: 'aiAdaptiveSensitivity', toSensor: v => (v ? 1 : 0), fromSensor: onOff, boolean: true },
  { setting: 'ai_interference', attribute: 'aiInterference', toSensor: v => (v ? 1 : 0), fromSensor: onOff, boolean: true },
  ...REPORTING.map(e => ({
    setting: e.setting,
    attribute: e.attribute,
    toSensor: v => reportToSensor(e, v),
    fromSensor: r => reportFromSensor(e, r),
    ...(e.type === 'enum' ? { values: e.values } : { min: e.min, max: e.max, step: e.step }),
  })),
];

const ATTRS = AqaraLumiCluster.ATTRIBUTES;
const BY_ID = new Map(PLAIN.map(e => [ATTRS[e.attribute].id, e]));
const RANGE_ID = ATTRS.detectionRange.id;

/** Blocks (0..23) that are on in a detection range value (2 bytes prefix + 24 bit mask). */
function rangeBlocks(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return null;
  const mask = buffer.readUIntLE(2, 3);
  return [...Array(RANGE_BLOCKS).keys()].filter(i => (mask >>> i) & 1);
}

function rangeBuffer(prefix, blocks) {
  const buffer = Buffer.alloc(5);
  buffer.writeUInt16LE(prefix, 0);
  buffer.writeUIntLE(blocks.reduce((m, b) => (m | (1 << b)) >>> 0, 0), 2, 3);
  return buffer;
}

function blocksFromTo(min, max) {
  const first = Math.max(0, Math.round(min / RANGE_STEP));
  const last = Math.min(RANGE_BLOCKS, Math.round(max / RANGE_STEP)) - 1;
  return [...Array(RANGE_BLOCKS).keys()].filter(i => i >= first && i <= last);
}

/** The from/to settings that show the outer limits of a set of blocks. */
function fromToOf(blocks) {
  if (!blocks || !blocks.length) return {};
  return { range_min: blocks[0] * RANGE_STEP, range_max: (blocks[blocks.length - 1] + 1) * RANGE_STEP };
}

/**
 * Homey settings for the attributes in `attrs` (keyed by numeric id, as parsed from a frame,
 * or by attribute name, as returned by readAttributes). Unknown or out-of-range values are skipped.
 * Returns { settings, blocks } where blocks is the detection range, if present.
 */
function settingsFromAttributes(attrs) {
  const settings = {};
  let blocks = null;
  for (const [key, raw] of Object.entries(attrs)) {
    const id = /^\d+$/.test(key) ? Number(key) : (ATTRS[key] && ATTRS[key].id);
    if (id === RANGE_ID) {
      blocks = rangeBlocks(raw);
      if (blocks) Object.assign(settings, fromToOf(blocks));
      continue;
    }
    const entry = BY_ID.get(id);
    if (!entry) continue;
    const value = entry.fromSensor(raw);
    if (value !== undefined) settings[entry.setting] = value;
  }
  return { settings, blocks };
}

/** Does the value read back from the sensor match what was written? Range: compare the mask only. */
function sameValue(attribute, written, read) {
  if (attribute === 'detectionRange') {
    const a = rangeBlocks(written);
    const b = rangeBlocks(read);
    return Boolean(a && b) && a.join() === b.join();
  }
  if (Buffer.isBuffer(written)) return Buffer.isBuffer(read) && read.equals(written);
  return read === written;
}

module.exports = {
  PLAIN, RANGE_STEP, RANGE_BLOCKS, rangeBlocks, rangeBuffer, blocksFromTo, fromToOf, settingsFromAttributes, sameValue,
};
