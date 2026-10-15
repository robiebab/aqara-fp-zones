'use strict';

const Homey = require('homey');

class FP400ZoneDriver extends Homey.Driver {

  async onInit() {
    this.enteredTrigger = this.homey.flow.getDeviceTriggerCard('zone_person_entered');
    this.leftTrigger = this.homey.flow.getDeviceTriggerCard('zone_person_left');
  }

  _sensors() {
    return this.homey.app.getSensors();
  }

  _sensor(token) {
    const sensor = this._sensors().find(d => d.getData().token === token);
    if (!sensor) throw new Error(this.homey.__('zone.no_parent'));
    return sensor;
  }

  /** Pairing wizard (drivers/fp400_zone/pair/wizard.html). */
  async onPair(session) {
    const linkedUids = new Set(this.getDevices().map(d => d.getStoreValue('uid')).filter(Boolean));

    session.setHandler('list_sensors', async () => this._sensors().map(sensor => {
      const token = sensor.getData().token;
      const zones = Object.entries(sensor.getZones()).map(([slot, zone]) => ({
        ...zone, slot: Number(slot), added: linkedUids.has(zone.uid),
      }));
      return { token, name: sensor.getName(), kind: sensor.kind, zones };
    }));

    // Look of the wizard: the choice made in the app settings (auto, light or dark).
    session.setHandler('get_theme', async () => this.homey.settings.get('theme') || 'auto');
    // Diagnostics: which look the wizard picked and why (visible with `homey app run`).
    session.setHandler('theme_debug', async info => { this.log('Theme (wizard)', JSON.stringify(info)); });

    session.setHandler('get_state', async ({ token }) => {
      const sensor = this._sensor(token);
      sensor.markViewer();
      return sensor.getLiveState();
    });

    session.setHandler('save_zone', async ({ token, slot, zone }) => {
      const sensor = this._sensor(token);
      const zones = sensor.getZones();
      let target = Number(slot);
      if (!Number.isInteger(target) || target < 1 || target > 8) {
        target = [1, 2, 3, 4, 5, 6, 7, 8].find(n => !zones[n]);
        if (!target) throw new Error(this.homey.__('pair.full'));
      }
      const saved = await sensor.setZone(target, zone);
      const { uid } = saved[target];
      const device = {
        name: saved[target].name,
        data: { id: `${token}:${uid}` },
        store: { parentToken: token, uid },
      };
      // An FP300 sees at most one person (only the nearest distance): no people count for its zones
      if (sensor.kind === 'fp300') device.capabilities = ['alarm_motion'];
      return device;
    });
  }

}

module.exports = FP400ZoneDriver;
