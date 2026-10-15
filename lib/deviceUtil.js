'use strict';

/**
 * Devices paired with an older app version do not get new capabilities automatically.
 * Add every capability from the driver manifest that the device is missing.
 */
async function ensureCapabilities(device) {
  const wanted = (device.driver && device.driver.manifest && device.driver.manifest.capabilities) || [];
  for (const capability of wanted) {
    if (!device.hasCapability(capability)) {
      await device.addCapability(capability).catch(err => device.error(`Adding ${capability} failed`, err.message));
    }
  }
}

/** Short message in the Homey timeline, so the user sees that a delayed action ran. */
function notify(device, key, tokens = {}) {
  const excerpt = device.homey.__(key, { name: device.getName(), ...tokens });
  return device.homey.notifications.createNotification({ excerpt }).catch(err => device.error('Notification failed', err.message));
}

/**
 * One timer for the next moment the zone states change by themselves (tracker.nextDeadline()),
 * instead of a clock that checks every second. Called after every zone update.
 */
function scheduleZoneDeadline(device) {
  if (device._zoneDeadlineTimer) device.homey.clearTimeout(device._zoneDeadlineTimer);
  device._zoneDeadlineTimer = null;
  const at = device.tracker && device.tracker.nextDeadline(Date.now());
  if (!at) return;
  device._zoneDeadlineTimer = device.homey.setTimeout(() => {
    device._zoneDeadlineTimer = null;
    device._publishZones([]);
  }, Math.max(0, at - Date.now()) + 5);
}

module.exports = {
  scheduleZoneDeadline, ensureCapabilities, notify };
