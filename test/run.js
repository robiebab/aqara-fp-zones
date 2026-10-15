'use strict';

/*
 * Core tests for the pure logic of the app (no Homey, no sensor needed).
 * Run from the project root:  npm test
 * Every test uses real frames or values seen in the user's logs or in the community sources.
 */

const assert = require('assert');
const raw = require('../lib/zclRaw');
const trk = require('../lib/fp400Tracking');
const areas = require('../lib/fp400Areas');
const fp300z = require('../lib/fp300Zones');
const rep = require('../lib/fp300Reporting');
const time = require('../lib/zigbeeTime');
const { WakePattern } = require('../lib/wakePattern');
const fp300s = require('../lib/fp300Settings');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}\n     ${err.message}`);
    process.exitCode = 1;
  }
}

test('zclRaw: FP300 report with presence and learning (from log)', () => {
  const f = Buffer.from('1c5f117a0a420120004d012000', 'hex');
  const h = raw.parseHeader(f);
  assert.deepStrictEqual([h.manufacturerId, h.cmdId, h.disableDefaultResponse], [0x115f, 0x0a, true]);
  assert.deepStrictEqual(raw.parseAttributeRecords(f, h), { 0x0142: 0, 0x014d: 0 });
});

test('zclRaw: Lumi status struct 0x00F7 (battery 100 %, 3014 mV, from log)', () => {
  const s = raw.parseLumiStruct(Buffer.from('052103000a2173670c200a0d232a4100001320001721c60b1820641c1000642000652002672000', 'hex'));
  assert.strictEqual(s[0x18], 100);
  assert.strictEqual(s[0x17], 3014);
});

test('zclRaw: unknown type stops parsing without throwing', () => {
  const f = Buffer.from('1c5f11070a420120019900' + '4c010203', 'hex');
  assert.deepStrictEqual(raw.parseAttributeRecords(f, raw.parseHeader(f)), { 0x0142: 1 });
});

test('FP400: tracking frame decodes positions', () => {
  const rec = (id, x, y, act) => {
    const r = Buffer.alloc(25);
    r[0] = 9; r[2] = 0x20; r[3] = id; r[4] = 0x29; r.writeInt16LE(x, 5); r[7] = 0x29; r.writeInt16LE(y, 8);
    r[10] = 0x29; r[13] = 0x29; r.writeInt16LE(act, 14); r[16] = 0x21; r[19] = 0x30; r[21] = 0x30; r[23] = 0x20;
    return r;
  };
  const f = Buffer.concat([Buffer.from('0c5f11018b00004c0200', 'hex'), rec(1, -120, 250, 1), rec(2, 200, 600, 2)]);
  assert.deepStrictEqual(trk.decodeTrackingFrame(f).targets.map(t => [t.id, t.x, t.y]), [[1, -120, 250], [2, 200, 600]]);
});

test('FP400: painted zone counts a person inside and empties on room absence', () => {
  const z = { 1: trk.parseZone({ name: 'L', cells: [16 * 5 + 3, 16 * 5 + 4] }) };
  const t = new trk.ZoneTracker(z);
  t.accept([{ id: 1, x: -400 + 4 * 50 + 10, y: 5 * 50 + 10 }], 1, 1000);
  assert.strictEqual(t.state(1000)[1].count, 1);
  t.setPresence(false);
  assert.strictEqual(t.state(2000)[1].occupied, false);
});

test('FP400: area mask uses mirrored native columns (MSB first)', () => {
  assert.strictEqual(areas.cellsToMask([15]).toString('hex').slice(0, 2), '80'); // my col 15 = native col 0
  const cells = [0, 5, 17, 100, 319];
  assert.deepStrictEqual(areas.maskToCells(areas.cellsToMask(cells)), cells);
});

test('FP300: distance blocks of 0.25 m and zone enter/leave', () => {
  assert.strictEqual(fp300z.blockOf(1.6), 6);
  assert.strictEqual(fp300z.blockOf(6), null);
  const t = new fp300z.BlockTracker({ 1: fp300z.parseBlockZone({ name: 'K', blocks: [6, 7], absence_timeout: 0 }) });
  assert.deepStrictEqual(t.update(true, 1.8, 0), [{ slot: 1, type: 'enter' }]);
  assert.deepStrictEqual(t.update(false, 1.8, 1000), [{ slot: 1, type: 'leave' }]);
});

test('FP300: reporting settings convert to sensor units (Z2M scales)', () => {
  const E = n => rep.REPORTING.find(e => e.setting === n);
  assert.strictEqual(rep.toSensor(E('light_report_interval'), 120), 120000);
  assert.strictEqual(rep.toSensor(E('humidity_report_threshold'), 5.5), 550);
  assert.strictEqual(rep.fromSensor(E('temp_report_interval'), 3600000), 3600);
  assert.strictEqual(rep.fromSensor(E('temp_report_threshold'), 5), undefined); // 0.05 °C is out of range
});

test('Time cluster: answers the FP300 time request from the log', () => {
  const req = Buffer.from('101b00000002000500', 'hex');
  const out = time.buildTimeReadResponse(req, raw.parseHeader(req), 'Europe/Amsterdam', new Date('2026-10-09T08:52:30Z'));
  assert.strictEqual(out.toString('hex'), '181b01000000e2ce675b320200002b100e00000500002b100e0000');
});

test('Wake pattern: median gap and next wake up', () => {
  const w = new WakePattern();
  let t = 0;
  for (const g of [240, 250, 230, 260, 600, 245]) { t += g * 1000; w.note(t); w.note(t + 1000); }
  const s = w.stats(t + 60000);
  assert.strictEqual(Math.round(s.median / 1000), 250);
});

test('FP300 settings: one table for reading and writing (same values both ways)', () => {
  for (const e of fp300s.PLAIN) {
    const sample = { sensitivity: '3', detection_mode: '1', absence_delay: 5, pir_interval: 10, ai_adaptive: true, ai_interference: false }[e.setting];
    if (sample === undefined) continue;
    const raw = e.toSensor(sample);
    assert.deepStrictEqual(e.fromSensor(raw), sample, e.setting);
  }
  const { settings } = fp300s.settingsFromAttributes({ 0x0199: 2, 0x0197: 1, motionSensitivity: 1, 0x019a: Buffer.from('0003703000', 'hex') });
  assert.deepStrictEqual(settings, { detection_mode: '2', absence_delay: 1, sensitivity: '1', range_min: 1, range_max: 3.5 });
});

test('FP300 detection range: read back compares the blocks, not the prefix', () => {
  const blocks = [4, 5, 6, 12, 13];
  const a = fp300s.rangeBuffer(0x0300, blocks);
  const b = fp300s.rangeBuffer(0x0100, blocks);
  assert.ok(fp300s.sameValue('detectionRange', a, b));
  assert.ok(!fp300s.sameValue('detectionRange', a, fp300s.rangeBuffer(0x0300, [4, 5])));
  assert.deepStrictEqual(fp300s.blocksFromTo(1, 2), [4, 5, 6, 7]);
});

test('Drivers: settings screens match the sensor tables (ranges, steps, choices)', () => {
  const flat = file => JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', file), 'utf8'))
    .flatMap(g => (g.type === 'group' ? g.children : [g]));
  const fp300 = flat('drivers/fp300/driver.settings.compose.json');
  for (const e of fp300s.PLAIN) {
    const s = fp300.find(x => x.id === e.setting);
    assert.ok(s, `FP300 setting ${e.setting} is missing in the driver`);
    if (e.values) assert.deepStrictEqual(s.values.map(v => v.id), e.values.map(String), `${e.setting} choices`);
    if (e.min !== undefined) assert.deepStrictEqual([s.min, s.max, s.step], [e.min, e.max, e.step], `${e.setting} range`);
    if (e.boolean) assert.strictEqual(s.type, 'checkbox', `${e.setting} type`);
    if (s.type === 'number') assert.ok(s.value >= s.min && s.value <= s.max, `${e.setting} default inside range`);
  }
  const range = ['range_min', 'range_max'].map(id => fp300.find(x => x.id === id));
  assert.deepStrictEqual(range.map(r => [r.min, r.max, r.step]), [[0, 5.75, 0.25], [0.25, 6, 0.25]], 'detection range = 24 blocks of 0.25 m');
  const fp400 = flat('drivers/fp400/driver.settings.compose.json');
  assert.deepStrictEqual([fp400.find(x => x.id === 'absence_timeout').min, fp400.find(x => x.id === 'absence_timeout').max], [0, 300]);
  assert.deepStrictEqual(fp400.find(x => x.id === 'sensitivity').values.map(v => v.id), ['0', '1', '2']);
});

console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}`);
