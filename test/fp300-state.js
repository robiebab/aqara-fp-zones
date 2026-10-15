'use strict';

/*
 * State machine of the FP300 (presence, PIR, motion alarm, session, distance measurement), replayed
 * with the order of messages from real logs. No Homey or sensor needed: the Homey driver class is
 * replaced by a small fake. Run with: node test/fp300-state.js (also part of npm test).
 */

const Module = require('module');
const assert = require('assert');
const EventEmitter = require('events');

class FakeDevice extends EventEmitter {
  constructor(settings) {
    super();
    this._store = { zones: { 1: { uid: 'z1', name: 'Gang', blocks: [4, 5, 6, 7], absence_timeout: 0 } } };
    this._caps = { alarm_motion: false, target_distance: null };
    this._settings = Object.assign({ detection_mode: '0', motion_source: 'both', distance_mode: 'auto' }, settings);
    this.logs = []; this.titles = []; this.cards = [];
  }
  getStoreValue(k) { return this._store[k]; } async setStoreValue(k, v) { this._store[k] = v; }
  getCapabilityValue(c) { return this._caps[c] ?? null; } async setCapabilityValue(c, v) { this._caps[c] = v; }
  async setCapabilityOptions(c, o) { this.titles.push(o.title.en); }
  getSetting(k) { return this._settings[k]; } async setSettings(o) { Object.assign(this._settings, o); }
  getName() { return 'Hallway'; } getData() { return { token: 'S' }; } async setWarning() {} async unsetWarning() {}
  log(...a) { this.logs.push(a.join(' ').replace(/^\[Hallway\] /, '')); } error(e) { this.logs.push(`ERROR ${e && e.message}`); }
}
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'homey-zigbeedriver' ? { ZigBeeDevice: FakeDevice } : load.call(this, req, ...rest); };
const FP300 = require('../drivers/fp300/device');
const { BlockTracker } = require('../lib/fp300Zones');
const { WakePattern } = require('../lib/wakePattern');
const { parseHeader } = require('../lib/zclRaw');
Module._load = load;

let clock = Date.parse('2026-10-15T13:00:00Z');
const realNow = Date.now;
Date.now = () => clock;

/** A device with a fake radio: `answer(names)` returns what the sensor answers to a read. */
function device(settings, answer = () => ({})) {
  const d = new FP300(settings);
  d.homey = { __: k => k, manifest: { version: 'test' }, app: { bus: new EventEmitter() }, setTimeout: f => { setImmediate(f); return 1; }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {}, notifications: { createNotification: async () => {} }, clock: { getTimezone: () => 'Europe/Amsterdam' } };
  d.driver = { pirOnTrigger: { trigger: async () => d.cards.push('PIR on') }, pirOffTrigger: { trigger: async () => d.cards.push('PIR off') },
    triggers: Object.fromEntries(['distance_below', 'distance_above', 'entered_range', 'left_range'].map(k => [k, { trigger: async () => {} }])) };
  Object.assign(d, { _pending: new Map(), _oneShots: new Map(), _flushing: false, token: 'S', _lastEmitted: '', _lastDistanceAt: 0, _lastTrackStart: 0,
    _viewerTrackAt: 0, _mmwave: null, _pir: null, _session: false, _wake: new WakePattern([]), _lastStructAt: clock, _pendingConfigRead: false, _pendingReportingRefresh: false });
  d.tracker = new BlockTracker(d.getZones());
  d.writes = []; d.reads = [];
  d.lumi = {
    writeAttributes: async a => { d.writes.push(Object.keys(a)[0]); },
    readAttributes: async names => {
      d.reads.push(names.join('+'));
      const values = answer(names);
      if (Object.keys(values).length) await d._handleLumiAttributes(values); // the answer passes the same code
      return {};
    },
  };
  return d;
}
const frame = (attr, value, type = 0x20) => {
  const b = Buffer.alloc(type === 0x23 ? 12 : 9);
  b.writeUInt8(0x1c, 0); b.writeUInt16LE(0x115f, 1); b.writeUInt8(1, 3); b.writeUInt8(0x0a, 4);
  b.writeUInt16LE(attr, 5); b.writeUInt8(type, 7);
  if (type === 0x23) b.writeUInt32LE(value, 8); else b.writeUInt8(value, 8);
  return b;
};
async function at(d, time, attr, value, type) {
  clock = Date.parse(`2026-10-15T${time}Z`);
  const b = frame(attr, value, type);
  await d._onFrame(0xfcc0, b, parseHeader(b));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 2));
}
const MMW = 0x0142, PIR = 0x014d, DIST = 0x015f;
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok   ${name}`); }

(async () => {
  await test('entry and exit of the log of 15 October: one start, repeats ignored, absence checked, then off', async () => {
    const d = device({}, () => ({ [MMW]: 0, [PIR]: 0 }));
    await at(d, '13:15:10.110', PIR, 1);
    await at(d, '13:15:10.296', PIR, 1);            // same state again
    await at(d, '13:15:11.999', MMW, 1);
    await at(d, '13:15:12.194', MMW, 1);            // same state again
    await at(d, '13:15:12.406', DIST, 100, 0x23);
    await at(d, '13:15:30.106', PIR, 1);            // the sensor repeats "PIR on"
    await at(d, '13:15:57.905', MMW, 0); await at(d, '13:15:57.906', PIR, 0);
    await at(d, '13:15:58.132', MMW, 0); await at(d, '13:15:58.935', PIR, 0);   // repeats of "off"
    assert.strictEqual(d.logs.filter(l => l === 'PIR on').length, 1);
    assert.strictEqual(d.logs.filter(l => l === 'mmWave presence on').length, 1);
    assert.strictEqual(d.logs.filter(l => /^Session started/.test(l)).length, 1);
    assert.strictEqual(d.writes.filter(w => w === 'trackDistance').length, 1);
    assert.ok(d.logs.some(l => /Checked the sensor .*: mmWave off, PIR off/.test(l)));
    assert.strictEqual(d._caps.alarm_motion, false); assert.strictEqual(d._session, false);
    assert.deepStrictEqual(d.cards, ['PIR on', 'PIR off']);
    assert.deepStrictEqual(d.titles, ['Motion: PIR', 'Motion: mmWave + PIR', 'Motion: PIR', 'Motion']);
    assert.strictEqual(d.reads.length, 1, 'one check, no distance asked');
  });

  await test('the check finds someone after all: everything stays on', async () => {
    const d = device({}, () => ({ [MMW]: 1 }));
    await at(d, '13:20:00.000', MMW, 1);
    await at(d, '13:20:30.000', MMW, 0);
    assert.strictEqual(d._caps.alarm_motion, true); assert.strictEqual(d._session, true);
    assert.ok(d.logs.some(l => /still someone there/.test(l)));
  });

  await test('motion alarm on mmWave only: the PIR alone does not switch it, mmWave off with PIR on does', async () => {
    const d = device({ motion_source: 'mmwave' }, () => ({}));
    await at(d, '13:30:00.000', PIR, 1); assert.strictEqual(d._caps.alarm_motion, false); assert.strictEqual(d._session, true);
    await at(d, '13:30:01.000', MMW, 1); assert.strictEqual(d._caps.alarm_motion, true);
    await at(d, '13:30:20.000', MMW, 0); assert.strictEqual(d._caps.alarm_motion, false, 'its source is off, PIR still on');
    assert.strictEqual(d._session, true);
    await at(d, '13:30:40.000', PIR, 0); assert.strictEqual(d._session, false);
  });

  await test('the measurement is continued at a message once it is older than 5 minutes, never stopped by time', async () => {
    const d = device({}, () => ({}));
    await at(d, '13:40:00.000', MMW, 1);
    await at(d, '13:44:00.000', DIST, 150, 0x23);
    assert.strictEqual(d.writes.filter(w => w === 'trackDistance').length, 1);
    await at(d, '13:45:30.000', DIST, 160, 0x23);
    assert.strictEqual(d.writes.filter(w => w === 'trackDistance').length, 2);
    assert.strictEqual(d._session, true, 'still present after 5 minutes: nothing ends by time');
  });

  await test('zones follow the main sensor: on with a distance in the zone, off once the sensor confirmed nobody', async () => {
    const d = device({}, () => ({ [MMW]: 0, [PIR]: 0 }));
    await at(d, '13:50:00.000', MMW, 1);
    await at(d, '13:50:01.000', DIST, 150, 0x23);
    assert.strictEqual(d.zoneStates()[1].occupied, true);
    await at(d, '13:50:30.000', MMW, 0);
    assert.strictEqual(d.zoneStates()[1].occupied, false);
  });

  await test('temperature, humidity and light: only a changed value is set and logged', async () => {
    const d = device({}, () => ({}));
    const clusters = { temperatureMeasurement: new EventEmitter(), relativeHumidity: new EventEmitter(), illuminanceMeasurement: new EventEmitter() };
    d.zclNode = { endpoints: { 1: { clusters } } };
    d._listenMeasurement('measure_luminance', 'illuminanceMeasurement', raw => Math.round(10 ** ((raw - 1) / 10000)));
    d._listenMeasurement('measure_temperature', 'temperatureMeasurement', raw => d._withOffset(raw / 100, 'temperature', -65, 65));
    for (const raw of [1, 1, 1]) clusters.illuminanceMeasurement.emit('attr.measuredValue', raw);   // 1 lux three times
    clusters.illuminanceMeasurement.emit('attr.measuredValue', 20001);                              // 100 lux
    for (const raw of [2150, 2150, 2160]) clusters.temperatureMeasurement.emit('attr.measuredValue', raw);
    assert.deepStrictEqual(d.logs.filter(l => /^measure_/.test(l)), ['measure_luminance 1', 'measure_luminance 100', 'measure_temperature 21.5', 'measure_temperature 21.6']);
  });

  await test('status messages the sensor sends by itself: nothing logged, battery only when it changed', async () => {
    const d = device({}, () => ({}));
    const df = Buffer.from('0321740804' + '21b000', 'hex');           // a 0x00DF status (two tags)
    const f7 = Buffer.from('172199' + '0b' + '182064', 'hex');        // 0x00F7: 2969 mV, 100 %
    await d._handleLumiAttributes({ 0x00df: df });
    await d._handleLumiAttributes({ 0x00f7: f7 });
    await d._handleLumiAttributes({ 0x00f7: f7 });                    // same battery again
    assert.deepStrictEqual(d.logs.filter(l => /Status|Battery/.test(l)), ['Battery: 100 % (2969 mV)']);
  });

  await test('configuration is only read when there is a reason (never read, or a new app version)', async () => {
    const d = device({}, () => ({}));
    assert.strictEqual(d._newSinceLast('configReadVersion'), true, 'never read');
    d._store.configReadVersion = 'test';
    assert.strictEqual(d._newSinceLast('configReadVersion'), false, 'read by this version: not again, also not after a restart');
    d._store.configReadVersion = 'older';
    assert.strictEqual(d._newSinceLast('configReadVersion'), true, 'new app version');
  });

  await test('the distance is cleared when nobody is there: on re-entry no zone uses the distance of last time', async () => {
    const d = device({}, () => ({ [MMW]: 0, [PIR]: 0 }));
    await at(d, '14:00:00.000', MMW, 1);
    await at(d, '14:00:01.000', DIST, 150, 0x23);                  // in the zone (1.0 to 2.0 m)
    assert.strictEqual(d.zoneStates()[1].occupied, true);
    await at(d, '14:00:30.000', MMW, 0);                            // nobody (confirmed by the check)
    assert.strictEqual(d._caps.target_distance, null, 'distance cleared');
    assert.ok(d.logs.includes('Distance cleared (nobody present)'));
    await at(d, '14:05:00.000', MMW, 1);                            // somebody enters again
    assert.strictEqual(d.zoneStates()[1].occupied, false, 'no zone on the old 1.5 m');
    await at(d, '14:05:01.000', DIST, 320, 0x23);                  // the first new distance: outside the zone
    assert.strictEqual(d.zoneStates()[1].occupied, false);
    await at(d, '14:05:03.000', DIST, 160, 0x23);                  // walks into the zone
    assert.strictEqual(d.zoneStates()[1].occupied, true);
  });

  await test('no distance after the start while the radar sees someone: started again at once, by messages, not by time', async () => {
    const d = device({}, () => ({}));
    await at(d, '15:00:00.000', MMW, 1);                       // session, start written
    assert.strictEqual(d.writes.filter(w => w === 'trackDistance').length, 1);
    await at(d, '15:00:00.300', 0x0198, 1);                    // the sensor confirms the start (report 1)
    assert.strictEqual(d.writes.filter(w => w === 'trackDistance').length, 1, 'confirmation alone: wait');
    await at(d, '15:00:20.000', PIR, 1);                       // a next report, still no distance
    assert.strictEqual(d.writes.filter(w => w === 'trackDistance').length, 2, 'not started: started again');
    assert.ok(d.logs.some(l => /starting the measurement again/.test(l)));
    await at(d, '15:00:20.500', DIST, 140, 0x23);              // now it measures
    await at(d, '15:00:40.000', PIR, 0);
    await at(d, '15:00:41.000', PIR, 1);
    assert.strictEqual(d.writes.filter(w => w === 'trackDistance').length, 2, 'measuring: no extra starts');
  });

  await test('only the PIR sees something: no restarts (the radar has nobody to measure)', async () => {
    const d = device({}, () => ({}));
    await at(d, '15:10:00.000', PIR, 1);
    await at(d, '15:10:00.300', 0x0198, 1);
    await at(d, '15:10:20.000', 0x0198, 1);
    await at(d, '15:10:40.000', 0x0198, 1);
    assert.strictEqual(d.writes.filter(w => w === 'trackDistance').length, 1);
  });

  Date.now = realNow;
  console.log(`\n${passed} state machine tests passed`);
})().catch(err => { console.error(err); process.exit(1); });
