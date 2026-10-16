'use strict';

const logBook = require('./lib/logBook');

function requireSensor(homey, token) {
  const device = homey.app.getSensor(token);
  if (!device) throw new Error('Sensor not found');
  if (!device.tracker) throw new Error('FP400 is still starting, try again in a moment');
  return device;
}

module.exports = {
  async listFp400({ homey }) {
    return homey.app.getSensors()
      .map(d => ({ token: d.getData().token, name: d.getName(), kind: d.kind }));
  },

  async getFp400({ homey, params }) {
    const device = requireSensor(homey, params.token);
    device.markViewer();
    return device.getLiveState();
  },

  async putZone({ homey, params, body }) {
    const device = requireSensor(homey, params.token);
    return device.setZone(params.slot, body);
  },

  async deleteZone({ homey, params }) {
    const device = requireSensor(homey, params.token);
    return device.setZone(params.slot, null);
  },

  /** FP300: set the sensor's own detection range as a list of 25 cm blocks (0 to 23). */
  async putRange({ homey, params, body }) {
    const device = requireSensor(homey, params.token);
    if (!device.setRangeBlocks) throw new Error('Only for the FP300');
    return device.setRangeBlocks(body && body.blocks);
  },

  async readAreas({ homey, params }) {
    const device = requireSensor(homey, params.token);
    if (!device.readAreas) return { ignore: [], outside: [] };
    return device.readAreas();
  },

  async putArea({ homey, params, body }) {
    const device = requireSensor(homey, params.token);
    return device.setArea(params.type, body && body.cells);
  },

  /** Logging tab: the kept lines (newest last). New lines arrive as realtime event 'log'. */
  async getLogs() {
    return logBook.lines();
  },

  async clearLogs() {
    logBook.clear();
    return { ok: true };
  },

  async forgetTarget({ homey, params }) {
    const device = requireSensor(homey, params.token);
    await device.forgetTarget(params.id);
    return { ok: true };
  },
};
