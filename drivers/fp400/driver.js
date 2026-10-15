'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class FP400Driver extends ZigBeeDriver {

  async onInit() {
    this.learningDoneTrigger = this.homey.flow.getDeviceTriggerCard('fp400_learning_done');
    this.movementTrigger = this.homey.flow.getDeviceTriggerCard('movement_event');
    this.movementTrigger.registerRunListener(async (args, state) => args.event === state.event);
  }

}

module.exports = FP400Driver;
