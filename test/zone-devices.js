'use strict';

/*
 * Zone devices: linked to their zone by uid, removed with the zone, never taking over a reused slot.
 * No Homey or sensor needed. Run with: node test/zone-devices.js (also part of npm test).
 */

const Module = require('module');
const EventEmitter = require('events');
const assert = require('assert');
class FakeDevice extends EventEmitter {
  constructor(data, store) { super(); this._data = data; this._store = store || {}; this._caps = {}; this._avail = true; }
  getData() { return this._data; } getStoreValue(k) { return this._store[k]; } async setStoreValue(k, v) { this._store[k] = JSON.parse(JSON.stringify(v)); }
  getName() { return 'x'; } getCapabilityValue(c) { return this._caps[c] ?? null; } async setCapabilityValue(c, v) { this._caps[c] = v; }
  getAvailable() { return this._avail; } async setAvailable() { this._avail = true; } async setUnavailable(m) { this._avail = false; this.msg = m; }
  log() {} error(...a) { console.log('ERR', ...a); }
}
const orig = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'homey') return { Device: FakeDevice, Driver: class {} };
  if (req === 'homey-zigbeedriver') return { ZigBeeDevice: FakeDevice, ZigBeeDriver: class {} };
  return orig.call(this, req, ...rest);
};
const FP400 = require('../drivers/fp400/device');
const Zone = require('../drivers/fp400_zone/device');
const { ZoneTracker } = require('../lib/fp400Tracking');
(async () => {
  const bus = new EventEmitter();
  const zoneDevices = [];
  const homey = { app: { bus, peopleTrigger: { trigger: async () => {} } }, __: k => k, setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1,
    drivers: { getDriver: id => ({ getDevices: () => id === 'fp400_zone' ? zoneDevices : [sensor] }) } };
  const sensor = new FP400({ token: 'T' }, { zones: { 1: { name: 'Oud', cells: [16 * 2 + 8], absence_timeout: 3, uid: 'olduid1' } } });
  sensor.homey = homey; sensor.token = 'T'; sensor._lastEmitted = '';
  sensor.location = { subscribeLocationData: async () => {} };
  homey.app.getFp400 = () => sensor; homey.app.getSensor = () => sensor;
  sensor.tracker = new ZoneTracker(sensor.getZones());
  const oldUid = sensor.getZones()[1].uid; assert.ok(oldUid);

  // legacy zone device (slot only) migrates to uid
  const legacy = new Zone({ id: 'T:1' }, { parentToken: 'T', uid: 'olduid1' });
  legacy.homey = homey; legacy.driver = { enteredTrigger: { trigger: async () => {} }, leftTrigger: { trigger: async () => {} } };
  zoneDevices.push(legacy);
  await legacy.onInit();
  assert.strictEqual(legacy.getStoreValue('uid'), oldUid);
  assert.strictEqual(sensor.getLiveState().linked[oldUid], 'x');

  // 1) remove via settings: zone gone, device unavailable
  await sensor.setZone(1, null);
  assert.deepStrictEqual(sensor.getZones(), {});
  assert.strictEqual(legacy.getAvailable(), false);

  // slot 1 reused by a new zone: old device must NOT take it over
  await sensor.setZone(1, { name: 'Nieuw', x_min: 0, x_max: 100, y_min: 0, y_max: 100, absence_timeout: 3 });
  assert.notStrictEqual(sensor.getZones()[1].uid, oldUid);
  assert.strictEqual(legacy.getAvailable(), false);

  // 2) device for the new zone, then delete the device in Homey: zone removed from map
  const dev = new Zone({ id: 'T:new' }, { parentToken: 'T', uid: sensor.getZones()[1].uid });
  dev.homey = homey; dev.driver = legacy.driver; zoneDevices.push(dev);
  await dev.onInit();
  assert.strictEqual(dev.getAvailable(), true);
  // editing keeps the uid
  const uidBefore = sensor.getZones()[1].uid;
  await sensor.setZone(1, { ...sensor.getZones()[1], name: 'Hernoemd', x_max: 200 });
  assert.strictEqual(sensor.getZones()[1].uid, uidBefore);
  await dev.onDeleted();
  assert.deepStrictEqual(sensor.getZones(), {});
  console.log('ZONE DELETE TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
