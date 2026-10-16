'use strict';

/*
 * Zone wizard: every step and every error ends up in the log (Logging tab, homey app run).
 * No Homey needed. Run with: node test/zone-wizard.js (also part of npm test).
 */

const Module = require('module');
const assert = require('assert');

const logs = [];
class FakeDriver {
  log(...a) { logs.push(a.join(' ')); }
  error(...a) { logs.push(`ERROR ${a.join(' ')}`); }
  getDevices() { return []; }
}
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'homey' ? { Driver: FakeDriver } : load.call(this, req, ...rest); };
const ZoneDriver = require('../drivers/fp400_zone/driver');
Module._load = load;

(async () => {
  const sensor = {
    kind: 'fp300', getName: () => 'FP300 - Hallway', getData: () => ({ token: 'S1' }), getZones: () => ({}),
    setZone: async (slot, zone) => ({ [slot]: { ...zone, uid: 'u1' } }), markViewer() {}, getLiveState: () => ({}),
  };
  const driver = new ZoneDriver();
  driver.homey = { app: { getSensors: () => [sensor] }, __: k => k, settings: { get: () => 'auto' } };
  const handlers = {};
  await driver.onPair({ setHandler: (name, fn) => { handlers[name] = fn; } });

  await handlers.list_sensors();
  const device = await handlers.save_zone({ token: 'S1', slot: null, zone: { name: 'Bank', cells: [4, 5] } });
  assert.deepStrictEqual(device.capabilities, ['alarm_motion']);
  await assert.rejects(handlers.save_zone({ token: 'unknown', slot: null, zone: { name: 'X', cells: [1] } }));
  await handlers.disconnect();

  assert.deepStrictEqual(logs, [
    'Zone wizard opened: 1 sensor(s) ready (FP300 - Hallway)',
    'Zone wizard: zone "Bank" saved on FP300 - Hallway (place 1), creating the zone device',
    'ERROR Zone wizard: "save zone" failed: zone.no_parent',
    'Zone wizard closed',
  ]);
  console.log('ZONE WIZARD LOG TESTS PASSED');
})().catch(err => { console.error(err); process.exit(1); });
