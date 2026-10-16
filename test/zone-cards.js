'use strict';

/*
 * The cards "a person entered / left the zone": an FP300 zone follows its zone state (no cards for
 * every crossing of the edge), an FP400 zone fires per person. No Homey needed.
 */

const Module = require('module');
const assert = require('assert');
const EventEmitter = require('events');
const { BlockTracker, parseBlockZone } = require('../lib/fp300Zones');

class FakeDevice {
  constructor(store) { this._store = store; this._caps = { alarm_motion: null }; this._available = true; }
  getStoreValue(k) { return this._store[k]; } getCapabilityValue(c) { return this._caps[c] ?? null; }
  async setCapabilityValue(c, v) { this._caps[c] = v; } hasCapability(c) { return c in this._caps; }
  getAvailable() { return this._available; } async setAvailable() { this._available = true; } async setUnavailable() { this._available = false; }
  log() {} error(e) { throw e; }
}
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'homey' ? { Device: FakeDevice } : load.call(this, req, ...rest); };
const ZoneDevice = require('../drivers/fp400_zone/device');
Module._load = load;

function zoneFor(kind, tracker) {
  const cards = [];
  const parent = { kind, tracker, zoneStates: () => tracker.state(clock), slotOfZone: () => 1, getZones: () => tracker.zones };
  const z = new ZoneDevice({ parentToken: 'S', uid: 'u' });
  z.homey = { app: { bus: new EventEmitter(), getSensor: () => parent, peopleTrigger: { trigger: async () => {} } }, __: k => k };
  z.driver = { enteredTrigger: { trigger: async () => cards.push('entered') }, leftTrigger: { trigger: async () => cards.push('left') } };
  return { z, cards };
}
let clock = 0;

(async () => {
  // FP300: standing at the edge of the zone (1.0 to 2.0 m), the distance goes back and forth
  const t = new BlockTracker({ 1: parseBlockZone({ name: 'Bank', blocks: [4, 5, 6, 7], absence_timeout: 30 }) });
  const { z, cards } = zoneFor('fp300', t);
  await z._apply({ states: t.state(clock), events: [] });                 // start: zone known, empty
  for (const d of [1.5, 1.95, 2.05, 1.9, 2.1, 1.95, 2.02]) {
    clock += 1000;
    const events = t.update(true, d, clock);
    await z._apply({ states: t.state(clock), events });
  }
  assert.deepStrictEqual(cards, ['entered'], 'at the edge: one "entered", no flapping');
  clock += 31000;
  await z._apply({ states: t.state(clock), events: [] });                  // 30 s after the last crossing out
  assert.deepStrictEqual(cards, ['entered', 'left'], '"left" when the zone is empty, together with its alarm');
  assert.strictEqual(z.getCapabilityValue('alarm_motion'), false);

  // FP400: per person, on every enter and leave event
  const f = zoneFor('fp400', { zones: {}, state: () => ({ 1: { available: true, occupied: true, count: 2 } }) });
  await f.z._apply({ states: { 1: { available: true, occupied: true, count: 2 } }, events: [{ slot: 1, type: 'enter' }, { slot: 1, type: 'enter' }] });
  await f.z._apply({ states: { 1: { available: true, occupied: true, count: 1 } }, events: [{ slot: 1, type: 'leave' }] });
  assert.deepStrictEqual(f.cards, ['entered', 'entered', 'left']);
  console.log('ZONE CARD TESTS PASSED');
})().catch(err => { console.error(err); process.exit(1); });
