'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

function inRange(value, min, max) {
  return typeof value === 'number' && value >= Math.min(min, max) && value <= Math.max(min, max);
}

class FP300Driver extends ZigBeeDriver {

  async onInit() {
    this.learningDoneTrigger = this.homey.flow.getDeviceTriggerCard('fp300_learning_done');
    // separate PIR cards, next to the presence (mmWave) of the device itself
    this.pirOnTrigger = this.homey.flow.getDeviceTriggerCard('fp300_pir_on');
    this.pirOffTrigger = this.homey.flow.getDeviceTriggerCard('fp300_pir_off');
    this.homey.flow.getConditionCard('fp300_pir_active').registerRunListener(async args => args.device.pirActive());
    this.triggers = {
      distance_below: this.homey.flow.getDeviceTriggerCard('distance_below'),
      distance_above: this.homey.flow.getDeviceTriggerCard('distance_above'),
      entered_range: this.homey.flow.getDeviceTriggerCard('entered_range'),
      left_range: this.homey.flow.getDeviceTriggerCard('left_range'),
    };

    this.triggers.distance_below.registerRunListener(async (args, state) => (
      typeof state.previous === 'number' && state.previous >= args.distance && state.current < args.distance
    ));
    this.triggers.distance_above.registerRunListener(async (args, state) => (
      typeof state.previous === 'number' && state.previous <= args.distance && state.current > args.distance
    ));
    this.triggers.entered_range.registerRunListener(async (args, state) => (
      !inRange(state.previous, args.min, args.max) && inRange(state.current, args.min, args.max)
    ));
    this.triggers.left_range.registerRunListener(async (args, state) => (
      inRange(state.previous, args.min, args.max) && !inRange(state.current, args.min, args.max)
    ));

    this.homey.flow.getConditionCard('distance_between')
      .registerRunListener(async args => inRange(args.device.getCapabilityValue('target_distance'), args.min, args.max));

    this.homey.flow.getActionCard('start_tracking')
      .registerRunListener(async args => {
        await args.device.startTracking();
      });

    this.homey.flow.getActionCard('set_range')
      .registerRunListener(async args => {
        await args.device.setSettings({ range_min: args.min, range_max: args.max });
        await args.device.applyRange(args.min, args.max);
      });
  }

}

module.exports = FP300Driver;
