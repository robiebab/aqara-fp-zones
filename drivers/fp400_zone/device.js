'use strict';

const Homey = require('homey');
const { withLogBook } = require('../../lib/logBook');

/**
 * Virtual device for one software zone of an FP400. It follows the zone state that the
 * FP400 device publishes on the app bus, so it can be placed in its own Homey room.
 *
 * The device is linked to its zone by the zone's unique id (store "uid"), not by slot number.
 * A slot can be reused for a new zone; the id makes sure an old device never takes over a new zone.
 */
class FP400ZoneDevice extends withLogBook(Homey.Device) {

  async onInit() {
    this.parentToken = this.getStoreValue('parentToken');
    this._onZones = payload => this._apply(payload).catch(this.error);
    this.homey.app.bus.on(`zones:${this.parentToken}`, this._onZones);

    const parent = this._parent();
    await this._fitCapabilities(parent);

    if (parent && parent.tracker) await this._apply({ states: parent.zoneStates(), events: [] });
    else if (!parent) await this.setUnavailable(this.homey.__('zone.no_parent'));
    // When the FP400 is still starting, its first publish (within seconds) updates this zone.
  }

  /**
   * Zones of an FP300 have no people count: the FP300 measures only the nearest person, so the
   * count could only be 0 or 1, which the motion alarm already shows. Removed from existing zones.
   */
  async _fitCapabilities(parent) {
    if (!parent || parent.kind !== 'fp300' || !this.hasCapability('people_count')) return;
    await this.removeCapability('people_count').catch(this.error);
    this.log('People count removed (FP300 zone)');
  }

  _parent() {
    return this.homey.app.getSensor(this.parentToken);
  }


  async _apply({ states, events }) {
    const parent = this._parent();
    if (!parent) return;
    if (parent.kind === 'fp300' && this.hasCapability('people_count')) await this._fitCapabilities(parent);

    const slot = parent.slotOfZone(this.getStoreValue('uid'));
    if (slot === null) {
      if (this.getAvailable()) await this.setUnavailable(this.homey.__('zone.removed'));
      return;
    }
    const state = states[slot];
    if (!state) return;
    if (!this.getAvailable()) await this.setAvailable();

    const wasOccupied = this.getCapabilityValue('alarm_motion');
    if (state.available) {
      if (wasOccupied !== state.occupied) {
        await this.setCapabilityValue('alarm_motion', state.occupied);
      }
      if (this.hasCapability('people_count') && this.getCapabilityValue('people_count') !== state.count) {
        await this.setCapabilityValue('people_count', state.count);
        this.homey.app.peopleTrigger.trigger(this, { people: state.count }).catch(this.error);
      }
    }

    // The cards "a person entered / left the zone":
    //  FP300 zone: follows the zone's state. The FP300 measures one distance, and at the edge of a zone
    //    it goes back and forth (1.95, 2.05, 1.9 m) while the zone stays occupied; firing on every
    //    crossing would switch flows on and off. So: entered when the zone becomes occupied, left when
    //    it becomes empty (after its "empty after" time), exactly together with the zone's motion alarm.
    //  FP400 zone: per person (it sees several people), on every enter and leave.
    if (parent.kind === 'fp300') {
      if (state.available && state.occupied && wasOccupied !== true) this.driver.enteredTrigger.trigger(this).catch(this.error);
      if (state.available && !state.occupied && wasOccupied === true) this.driver.leftTrigger.trigger(this).catch(this.error);
      return;
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
