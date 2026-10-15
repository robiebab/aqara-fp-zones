'use strict';

/**
 * Restoring default settings without pairing again.
 *
 * 1. App settings (the ones that only live in Homey, like distance measurement, offsets, light polling)
 *    go back to the defaults in the driver manifest.
 * 2. The sensor gets the ZCL Basic cluster command "Reset to Factory Defaults" (command 0x00).
 *    The ZCL specification says this resets the attributes of all clusters to their factory defaults,
 *    without affecting network membership, bindings or groups: the sensor stays paired.
 * 3. Afterwards the app reads the real values from the sensor, so Homey shows what the sensor uses.
 */

/** All settings of a driver manifest, flattened (groups opened). */
function flatSettings(manifestSettings) {
  return (manifestSettings || []).flatMap(s => (s.type === 'group' ? s.children || [] : [s]));
}

/**
 * Manifest defaults for the settings that only live in Homey.
 * `sensorKeys` are settings stored in the sensor: those come back from the sensor after its reset.
 */
function appDefaults(manifestSettings, sensorKeys) {
  const out = {};
  for (const s of flatSettings(manifestSettings)) {
    if (!s.id || s.type === 'label' || sensorKeys.includes(s.id)) continue;
    if (s.value !== undefined) out[s.id] = s.value;
  }
  return out;
}

/** True when an error is a ZCL status from the sensor (e.g. UNSUP_CLUSTER_COMMAND), not a timeout. */
function isZclStatus(err) {
  return /^[A-Z_]+$/.test(String(err && err.message));
}

module.exports = { flatSettings, appDefaults, isZclStatus };
