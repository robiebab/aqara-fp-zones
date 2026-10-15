'use strict';

/**
 * FP300 sampling and reporting settings for temperature, humidity and light.
 *
 * Attribute ids, ranges and scales come from zigbee-herdsman-converters (src/devices/lumi.ts, PS-S04D).
 * Interval and threshold only apply when the matching sampling is set to "custom" (4).
 * Each entry maps one Homey setting to one sensor attribute.
 *   scale: sensor value = setting value * scale
 *   min/max/step: the ranges Zigbee2MQTT allows for this attribute
 */
const REPORTING = [
  { setting: 'th_sampling', attribute: 'thSampling', type: 'enum', values: [0, 1, 2, 3, 4] },
  { setting: 'th_sampling_period', attribute: 'thSamplingPeriod', scale: 1000, min: 0.5, max: 3600, step: 0.5 },
  { setting: 'temp_report_mode', attribute: 'tempReportMode', type: 'enum', values: [1, 2, 3] },
  { setting: 'temp_report_interval', attribute: 'tempReportInterval', scale: 1000, min: 600, max: 3600, step: 600 },
  { setting: 'temp_report_threshold', attribute: 'tempReportThreshold', scale: 100, min: 0.2, max: 3, step: 0.1 },
  { setting: 'humidity_report_mode', attribute: 'humidityReportMode', type: 'enum', values: [1, 2, 3] },
  { setting: 'humidity_report_interval', attribute: 'humidityReportInterval', scale: 1000, min: 600, max: 3600, step: 600 },
  { setting: 'humidity_report_threshold', attribute: 'humidityReportThreshold', scale: 100, min: 2, max: 15, step: 0.5 },
  { setting: 'light_sampling', attribute: 'lightSampling', type: 'enum', values: [0, 1, 2, 3, 4] },
  { setting: 'light_sampling_period', attribute: 'lightSamplingPeriod', scale: 1000, min: 0.5, max: 3600, step: 0.5 },
  { setting: 'light_report_mode', attribute: 'lightReportMode', type: 'enum', values: [1, 2, 3] },
  { setting: 'light_report_interval', attribute: 'lightReportInterval', scale: 1000, min: 20, max: 3600, step: 20 },
  { setting: 'light_report_threshold', attribute: 'lightReportThreshold', scale: 100, min: 3, max: 20, step: 0.5 },
];

function snap(entry, value) {
  const n = Math.min(entry.max, Math.max(entry.min, Number(value)));
  const steps = Math.round((n - entry.min) / entry.step);
  return Math.round((entry.min + steps * entry.step) * 1000) / 1000;
}

/** Homey setting value -> sensor attribute value. */
function toSensor(entry, value) {
  if (entry.type === 'enum') {
    const n = Number(value);
    if (!entry.values.includes(n)) throw new Error(`Invalid value for ${entry.setting}`);
    return n;
  }
  return Math.round(snap(entry, value) * entry.scale);
}

/** Sensor attribute value -> Homey setting value, or undefined when it is outside the known range. */
function fromSensor(entry, raw) {
  if (typeof raw !== 'number') return undefined;
  if (entry.type === 'enum') return entry.values.includes(raw) ? String(raw) : undefined;
  const value = raw / entry.scale;
  if (value < entry.min - 1e-9 || value > entry.max + 1e-9) return undefined;
  return snap(entry, value);
}

module.exports = { REPORTING, toSensor, fromSensor, snap };
