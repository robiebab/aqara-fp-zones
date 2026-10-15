'use strict';

const EventEmitter = require('events');
const Homey = require('homey');

// Register the custom Aqara clusters before any ZCLNode is created.
require('./lib/AqaraClusters');

class AqaraFpZonesApp extends Homey.App {

  async onInit() {
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(100);
    this.peopleTrigger = this.homey.flow.getDeviceTriggerCard('people_changed');
    this.log('Aqara FP Zones started');
  }

  /** Find a sensor that can have zones (FP300 or FP400) by its Zigbee token. */
  getSensor(token) {
    return this._find('fp400', token) || this._find('fp300', token);
  }

  /** All sensors that can have zones and have finished starting. */
  getSensors() {
    const list = [];
    for (const id of ['fp400', 'fp300']) {
      try {
        list.push(...this.homey.drivers.getDriver(id).getDevices().filter(d => d.tracker));
      } catch (err) {
        // driver not ready yet
      }
    }
    return list;
  }

  _find(driverId, token) {
    try {
      return this.homey.drivers.getDriver(driverId).getDevices().find(d => d.getData().token === token) || null;
    } catch (err) {
      return null;
    }
  }

}

module.exports = AqaraFpZonesApp;
