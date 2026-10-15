'use strict';

const Homey = require('homey');

/**
 * Virtual device for one software zone of an FP400. It follows the zone state that the
 * FP400 device publishes on the app bus, so it can be placed in its own Homey room.
 *
 * The device is linked to its zone by the zone's unique id (store "uid"), not by slot number.
 * A slot can be reused for a new zone; the id makes sure an old device never takes over a new zone.
 */
class FP400ZoneDevice extends Homey.Device {

  async onInit() {
    this.parentToken = this.getStoreValue('parentToken');
    this._onZones = payload => this._apply(payload).catch(this.error);
    this.homey.app.bus.on(`zones:${this.parentToken}`, this._onZones);

    const parent = this._parent();
    await this._migrateUid(parent);

    if (parent && parent.tracker) await this._apply({ states: parent.zoneStates(), events: [] });
    else if (!parent) await this.setUnavailable(this.homey.__('zone.no_parent'));
    // When the FP400 is still starting, its first publish (within seconds) updates this zone.
  }

  _parent() {
    return this.homey.app.getSensor(this.parentToken);
  }

  /** Devices made by version 0.1.0 only knew their slot: adopt the id of the zone in that slot once. */
  async _migrateUid(parent) {
    if (this.getStoreValue('uid')) return;
    const slot = this.getStoreValue('slot');
    const zone = parent && parent.getZones()[slot];
    if (zone && zone.uid) await this.setStoreValue('uid', zone.uid);
  }

  async _apply({ states, events }) {
    const parent = this._parent();
    if (!parent) return;
    if (!this.getStoreValue('uid')) await this._migrateUid(parent);

    const slot = parent.slotOfZone(this.getStoreValue('uid'));
    if (slot === null) {
      if (this.getAvailable()) await this.setUnavailable(this.homey.__('zone.removed'));
      return;
    }
    const state = states[slot];
    if (!state) return;
    if (!this.getAvailable()) await this.setAvailable();

    if (state.available) {
      if (this.getCapabilityValue('alarm_motion') !== state.occupied) {
        await this.setCapabilityValue('alarm_motion', state.occupied);
      }
      if (this.getCapabilityValue('people_count') !== state.count) {
        await this.setCapabilityValue('people_count', state.count);
        this.homey.app.peopleTrigger.trigger(this, { people: state.count }).catch(this.error);
      }
    }

    for (const event of events) {
      if (event.slot !== slot) continue;
      const card = event.type === 'enter' ? this.driver.enteredTrigger : this.driver.leftTrigger;
      card.trigger(this).catch(this.error);
    }
  }

  async onUninit() {
    this.homey.app.bus.off(`zones:${this.parentToken}`, this._onZones);
  }

  /** Deleting the zone device in Homey also removes the zone from the FP400 map. */
  async onDeleted() {
    this.homey.app.bus.off(`zones:${this.parentToken}`, this._onZones);
    const parent = this._parent();
    const uid = this.getStoreValue('uid');
    if (parent && uid) {
      await parent.removeZoneByUid(uid).catch(err => this.error('Removing zone failed', err.message));
    }
  }

}

module.exports = FP400ZoneDevice;
