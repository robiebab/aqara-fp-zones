'use strict';

/**
 * Custom cluster definitions for zigbee-clusters.
 *
 * Sources for the attribute ids / types:
 * - FP300 (0xFCC0): zigbee-herdsman-converters src/devices/lumi.ts (model PS-S04D) and src/lib/lumi.ts
 * - FP400 (0xFC0A/0xFC0B/0xFC0C, 0x0080, occupancy attr 3): community converter
 *   github.com/bobtekkk/aqara-fp400-zone-card (z2m/aqara-fp400.mjs, MIT), based on Zigbee2MQTT issue #33146
 */

const { Cluster, ZCLDataTypes, OccupancySensingCluster } = require('zigbee-clusters');
const { AQARA_MANUFACTURER_ID } = require('./zclRaw');

const M = AQARA_MANUFACTURER_ID;

/* ---------------------------------------------------------------- FP300 */

class AqaraLumiCluster extends Cluster {
  static get ID() { return 0xfcc0; }
  static get NAME() { return 'aqaraLumi'; }
  static get ATTRIBUTES() {
    return {
      restartDevice: { id: 0x00e8, type: ZCLDataTypes.bool, manufacturerId: M }, // write false to restart
      lumiStruct: { id: 0x00f7, type: ZCLDataTypes.octstr, manufacturerId: M },
      preventLeave: { id: 0x00fc, type: ZCLDataTypes.bool, manufacturerId: M }, // keep true so the sensor stays on the network
      motionSensitivity: { id: 0x010c, type: ZCLDataTypes.uint8, manufacturerId: M }, // 1 low, 2 medium, 3 high
      presence: { id: 0x0142, type: ZCLDataTypes.uint8, manufacturerId: M },
      spatialLearning: { id: 0x0157, type: ZCLDataTypes.uint8, manufacturerId: M }, // write 1 to start
      aiAdaptiveSensitivity: { id: 0x015d, type: ZCLDataTypes.uint8, manufacturerId: M }, // 0 off, 1 on
      aiInterference: { id: 0x015e, type: ZCLDataTypes.uint8, manufacturerId: M }, // 0 off, 1 on
      pirDetection: { id: 0x014d, type: ZCLDataTypes.uint8, manufacturerId: M },
      pirInterval: { id: 0x014f, type: ZCLDataTypes.uint16, manufacturerId: M },
      targetDistance: { id: 0x015f, type: ZCLDataTypes.uint32, manufacturerId: M }, // centimetres
      absenceDelay: { id: 0x0197, type: ZCLDataTypes.uint32, manufacturerId: M }, // seconds
      trackDistance: { id: 0x0198, type: ZCLDataTypes.uint8, manufacturerId: M }, // write 1 to start
      detectionMode: { id: 0x0199, type: ZCLDataTypes.uint8, manufacturerId: M }, // 0 both, 1 mmwave, 2 pir
      detectionRange: { id: 0x019a, type: ZCLDataTypes.octstr, manufacturerId: M }, // 2 byte prefix + 24 bit mask
      // Sampling and reporting of temperature, humidity and light (zigbee-herdsman-converters, PS-S04D).
      // Times are in milliseconds, thresholds in 1/100 (°C, % RH or % light change).
      thSampling: { id: 0x0170, type: ZCLDataTypes.uint8, manufacturerId: M }, // 0 off, 1 low, 2 medium, 3 high, 4 custom
      thSamplingPeriod: { id: 0x0162, type: ZCLDataTypes.uint32, manufacturerId: M },
      tempReportInterval: { id: 0x0163, type: ZCLDataTypes.uint32, manufacturerId: M },
      tempReportThreshold: { id: 0x0164, type: ZCLDataTypes.uint16, manufacturerId: M },
      tempReportMode: { id: 0x0165, type: ZCLDataTypes.uint8, manufacturerId: M }, // 1 threshold, 2 interval, 3 both
      humidityReportInterval: { id: 0x016a, type: ZCLDataTypes.uint32, manufacturerId: M },
      humidityReportThreshold: { id: 0x016b, type: ZCLDataTypes.uint16, manufacturerId: M },
      humidityReportMode: { id: 0x016c, type: ZCLDataTypes.uint8, manufacturerId: M },
      lightSampling: { id: 0x0192, type: ZCLDataTypes.uint8, manufacturerId: M },
      lightSamplingPeriod: { id: 0x0193, type: ZCLDataTypes.uint32, manufacturerId: M },
      lightReportInterval: { id: 0x0194, type: ZCLDataTypes.uint32, manufacturerId: M },
      lightReportThreshold: { id: 0x0195, type: ZCLDataTypes.uint16, manufacturerId: M },
      lightReportMode: { id: 0x0196, type: ZCLDataTypes.uint8, manufacturerId: M },
    };
  }
  static get COMMANDS() { return {}; }
}

/* ---------------------------------------------------------------- FP400 */

class AqaraFp400ConfigCluster extends Cluster {
  static get ID() { return 0xfc0a; } // 64522
  static get NAME() { return 'aqaraFp400Config'; }
  static get ATTRIBUTES() {
    return {
      aiHighPrecision: { id: 41, type: ZCLDataTypes.bool, manufacturerId: M },
      aiAdaptiveSensitivity: { id: 42, type: ZCLDataTypes.bool, manufacturerId: M },
      aiInterference: { id: 44, type: ZCLDataTypes.bool, manufacturerId: M },
      // 40 byte masks, 20 rows x 16 columns, set bit = cell marked (see lib/fp400Areas.js)
      interferenceRegion: { id: 19, type: ZCLDataTypes.octstr, manufacturerId: M }, // sensor ignores movement here
      monitoringRegion: { id: 20, type: ZCLDataTypes.octstr, manufacturerId: M }, // set bit = outside the room
    };
  }
  static get COMMANDS() {
    return {
      // AI spatial learning; the result arrives later as Aqara event 0x8B with event id 3.
      startLearning: { id: 3, manufacturerId: M },
    };
  }
}

class AqaraFp400RadarCluster extends Cluster {
  static get ID() { return 0xfc0b; } // 64523
  static get NAME() { return 'aqaraFp400Radar'; }
  static get ATTRIBUTES() {
    return {
      humanCount: { id: 2, type: ZCLDataTypes.uint16, manufacturerId: M },
    };
  }
  static get COMMANDS() { return {}; }
}

class AqaraFp400LocationCluster extends Cluster {
  static get ID() { return 0xfc0c; } // 64524
  static get NAME() { return 'aqaraFp400Location'; }
  static get ATTRIBUTES() { return {}; }
  static get COMMANDS() {
    return {
      // Asks the sensor to stream target positions for `timeout` seconds.
      subscribeLocationData: {
        id: 0,
        manufacturerId: M,
        args: { timeout: ZCLDataTypes.uint16 },
      },
      // Makes the sensor drop one tracked target, e.g. a ghost. A real person is picked up again.
      removeDetectionTarget: {
        id: 1,
        manufacturerId: M,
        args: { targetId: ZCLDataTypes.uint8 },
      },
    };
  }
}

class AqaraFp400SensitivityCluster extends Cluster {
  static get ID() { return 0x0080; } // 128
  static get NAME() { return 'aqaraFp400Sensitivity'; }
  static get ATTRIBUTES() {
    return {
      sensitivity: { id: 0, type: ZCLDataTypes.uint8 }, // 0 low, 1 medium, 2 high
    };
  }
  static get COMMANDS() { return {}; }
}

/** Standard occupancy cluster plus the FP400 absence timeout (attribute 3, not manufacturer specific). */
class AqaraOccupancySensingCluster extends OccupancySensingCluster {
  static get ATTRIBUTES() {
    return {
      ...super.ATTRIBUTES,
      aqaraAbsenceTimeout: { id: 0x0003, type: ZCLDataTypes.uint16 },
    };
  }
}

Cluster.addCluster(AqaraLumiCluster);
Cluster.addCluster(AqaraFp400ConfigCluster);
Cluster.addCluster(AqaraFp400RadarCluster);
Cluster.addCluster(AqaraFp400LocationCluster);
Cluster.addCluster(AqaraFp400SensitivityCluster);
Cluster.addCluster(AqaraOccupancySensingCluster);

module.exports = {
  AqaraLumiCluster,
  AqaraFp400ConfigCluster,
  AqaraFp400RadarCluster,
  AqaraFp400LocationCluster,
  AqaraFp400SensitivityCluster,
  AqaraOccupancySensingCluster,
};
