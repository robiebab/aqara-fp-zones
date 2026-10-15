'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER, IdentifyCluster } = require('zigbee-clusters');
const {
  AqaraFp400LocationCluster, AqaraFp400RadarCluster, AqaraFp400SensitivityCluster, AqaraFp400ConfigCluster,
} = require('../../lib/AqaraClusters');
const { hookEndpoint, ensureCluster } = require('../../lib/zclRaw');
const { ensureCapabilities, notify, scheduleZoneDeadline } = require('../../lib/deviceUtil');
const { AREAS, cellsToMask, maskToCells, parseCells } = require('../../lib/fp400Areas');
const { cellOf } = require('../../lib/fp400Tracking');
const { appDefaults, isZclStatus } = require('../../lib/resetDefaults');
const {
  decodeTrackingFrame, decodeMotionEvent, parseZone, ZoneTracker,
} = require('../../lib/fp400Tracking');

const SUBSCRIBE_EVERY_MS = 10000;
const FP400_LEARNING_TIMEOUT_MS = 15 * 60 * 1000; // same keep-alive interval as the community converter
const SUBSCRIBE_TIMEOUT_S = 120;
const PEOPLE_POLL_MS = 30000;
const VIEWER_HOLD_MS = 60000;
const newUid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const AQARA_CLUSTERS = [AqaraFp400ConfigCluster.ID, AqaraFp400RadarCluster.ID, AqaraFp400LocationCluster.ID];

class FP400Device extends ZigBeeDevice {

  /** Every log line starts with the device name, so several sensors are easy to tell apart. */
  log(...args) {
    let name = '';
    try { name = this.getName(); } catch (err) { name = ''; }
    super.log(name ? `[${name}]` : '', ...args);
  }

  /** Sensor type, used by the zone wizard and the settings page. */
  get kind() { return 'fp400'; }

  async onNodeInit({ zclNode }) {
    this.token = this.getData().token;
    this._viewerUntil = 0;
    this._lastEmitted = '';
    await this._migrateZoneIds().catch(err => this.error('Zone id migration failed', err.message));
    this.tracker = new ZoneTracker(this.getZones());

    const ep1 = zclNode.endpoints[1];
    this.location = ensureCluster(ep1, AqaraFp400LocationCluster);
    this.radar = ensureCluster(ep1, AqaraFp400RadarCluster);
    this.sensitivityCluster = ensureCluster(ep1, AqaraFp400SensitivityCluster);
    this.config = ensureCluster(ep1, AqaraFp400ConfigCluster);
    this.identifyCluster = ensureCluster(ep1, IdentifyCluster);
    await ensureCapabilities(this);

    // Maintenance actions (Device settings > Maintenance actions). The FP400 is mains powered and always listening.
    this.registerCapabilityListener('button.identify', async () => {
      await this.identifyCluster.identify({ identifyTime: 5 });
    });
    this.registerCapabilityListener('button.reset_defaults', async () => this._resetDefaults());
    this.registerCapabilityListener('button.spatial_learning', async () => {
      await this.config.startLearning({});
      this._startLearning();
    });

    hookEndpoint(this, 1, (clusterId, frame, header) => this._onFrame(clusterId, frame, header));

    // Room presence (endpoint 1). occupancy is a bitmap, bit "occupied".
    const occupancy = ep1.clusters[CLUSTER.OCCUPANCY_SENSING.NAME];
    if (occupancy) {
      occupancy.on('attr.occupancy', value => {
        if (this._rereadOnNextMessage) this._readAfterReset().catch(this.error);
        this._onPresence(Boolean(value && value.occupied));
      });
    }

    // Illuminance lives on endpoint 2 and is not reported, so it is polled.
    // Light lives on endpoint 2 and is not reported by the sensor, so Homey asks for it.
    // How often, and when the value in Homey is updated, are settings (see _pollLux).
    this.illuminance = zclNode.endpoints[2] && zclNode.endpoints[2].clusters[CLUSTER.ILLUMINANCE_MEASUREMENT.NAME];

    if (this.isFirstInit()) {
      await this.configureAttributeReporting([
        { endpointId: 1, cluster: CLUSTER.OCCUPANCY_SENSING, attributeName: 'occupancy', minInterval: 0, maxInterval: 3600, minChange: 1 },
      ]).catch(err => this.error('Configure reporting failed', err.message));
    }

    // After init: read what the sensor has, one step after the other (each waits for the answer of
    // the previous one, so there is no burst of traffic), then start the regular work.
    Promise.resolve().then(() => this._startup()).catch(err => this.error('Startup failed', err.message));
  }

  async _startup() {
    await this._readPresence();
    await this._readAiSettings();
    await this.readAreas().catch(err => this.error('Reading areas failed', err.message));
    this._startTimers();
  }

  /* ------------------------------------------------------------ the sensor's own areas (ghost handling) */

  getAreas() {
    return this.getStoreValue('areas') || { ignore: [], outside: [] };
  }

  /** Cells (this app's numbering) where targets do not count for zones. */
  _blockedCells() {
    if (!this._blocked || this._blockedFrom !== this.getStoreValue('areas')) {
      const areas = this.getAreas();
      this._blocked = new Set([...areas.ignore, ...areas.outside]);
      this._blockedFrom = this.getStoreValue('areas');
    }
    return this._blocked;
  }

  isBlocked(target) {
    const cell = cellOf(target.x, target.y);
    return cell !== null && this._blockedCells().has(cell);
  }

  /** Read both masks from the sensor; the sensor is the source of truth (the Aqara app can change them too). */
  async readAreas() {
    const values = await this.config.readAttributes(['interferenceRegion', 'monitoringRegion']);
    const areas = { ...this.getAreas() };
    if (Buffer.isBuffer(values.interferenceRegion)) areas.ignore = maskToCells(values.interferenceRegion);
    if (Buffer.isBuffer(values.monitoringRegion)) areas.outside = maskToCells(values.monitoringRegion);
    await this.setStoreValue('areas', areas);
    return areas;
  }

  /** Write one area mask, then read it back to be sure the sensor took it. One write at a time. */
  async setArea(type, value) {
    const area = AREAS[type];
    if (!area) throw new Error('Unknown area type');
    const cells = parseCells(value);
    const run = async () => {
      const mask = cellsToMask(cells);
      await this.config.writeAttributes({ [area.attribute]: mask });
      const readback = await this.config.readAttributes([area.attribute]);
      const got = readback[area.attribute];
      const same = Buffer.isBuffer(got) && (got.equals(mask) || (got.length === 0 && cells.length === 0));
      if (!same) throw new Error(this.homey.__('errors.not_confirmed'));
      await this.setStoreValue('areas', { ...this.getAreas(), [type]: cells });
      return this.getAreas();
    };
    this._areaLock = (this._areaLock || Promise.resolve()).then(run, run);
    return this._areaLock;
  }

  /** Make the sensor drop one tracked target (a ghost). A real person is picked up again within seconds. */
  async forgetTarget(id) {
    const targetId = Number(id);
    if (!Number.isInteger(targetId) || targetId < 0 || targetId > 255) throw new Error('Unknown target');
    await this.location.removeDetectionTarget({ targetId });
  }

  /*
   * FP400 settings that live in the sensor: one table for reading, writing and reports, so Homey and the
   * sensor never disagree (same rules as the community converter: write, then read back).
   */
  _settingsTable() {
    const occupancy = this.zclNode.endpoints[1].clusters[CLUSTER.OCCUPANCY_SENSING.NAME];
    return [
      { setting: 'absence_timeout', cluster: occupancy, attribute: 'aqaraAbsenceTimeout', toSensor: v => Math.round(v),
        fromSensor: r => (Number.isInteger(r) && r >= 0 && r <= 300 ? r : undefined) },
      { setting: 'sensitivity', cluster: this.sensitivityCluster, attribute: 'sensitivity', toSensor: v => Number(v),
        fromSensor: r => ([0, 1, 2].includes(r) ? String(r) : undefined) }, // 0 low, 1 medium, 2 high
      { setting: 'ai_high_precision', cluster: this.config, attribute: 'aiHighPrecision', toSensor: v => Boolean(v), fromSensor: r => (typeof r === 'boolean' ? r : undefined) },
      { setting: 'ai_adaptive', cluster: this.config, attribute: 'aiAdaptiveSensitivity', toSensor: v => Boolean(v), fromSensor: r => (typeof r === 'boolean' ? r : undefined) },
      { setting: 'ai_interference', cluster: this.config, attribute: 'aiInterference', toSensor: v => Boolean(v), fromSensor: r => (typeof r === 'boolean' ? r : undefined) },
    ].filter(e => e.cluster);
  }

  /** Read every setting from the sensor and listen for reports of them. */
  async _readAiSettings() {
    const settings = {};
    const listen = !this._settingsListening;
    this._settingsListening = true;
    for (const entry of this._settingsTable()) {
      if (listen) entry.cluster.on(`attr.${entry.attribute}`, value => this._settingFromSensor(entry.setting, entry.fromSensor(value)));
      try {
        const value = entry.fromSensor((await entry.cluster.readAttributes([entry.attribute]))[entry.attribute]);
        if (value !== undefined) settings[entry.setting] = value;
      } catch (err) {
        this.error(`Reading ${entry.setting} failed`, err.message);
      }
    }
    if (Object.keys(settings).length) await this.setSettings(settings).catch(this.error);
  }

  /**
   * Default settings without pairing again (see lib/resetDefaults.js). Zones in this app stay; the
   * sensor's own ignore spots and outside-room areas may be cleared by its reset and are read again.
   */
  async _resetDefaults() {
    const sensorKeys = this._settingsTable().map(e => e.setting);
    await this.setSettings(appDefaults(this.driver.manifest.settings, sensorKeys)).catch(this.error);
    this._luxShown = undefined;
    this._startLuxTimer();
    try {
      await this.zclNode.endpoints[1].clusters.basic.factoryReset();
      this.log('Sensor reset to factory defaults (ZCL Basic command 0x00)');
    } catch (err) {
      if (!isZclStatus(err)) throw err;
      this.log('ZCL factory reset not supported:', err.message);
      notify(this, 'reset.unsupported_fp400');
      return;
    }
    // Read the settings now, and once more at the next message from the sensor (event, no fixed wait):
    // how long the reset takes inside the sensor is not documented.
    await this._readAfterReset();
    this._rereadOnNextMessage = true;
    notify(this, 'reset.done_sensor');
  }

  async _readAfterReset() {
    this._rereadOnNextMessage = false;
    await this._readAiSettings();
    await this.readAreas().catch(err => this.error('Reading areas failed', err.message));
  }

  _settingFromSensor(setting, value) {
    if (value === undefined || this.getSetting(setting) === value) return;
    this.log(`Setting ${setting} updated from the sensor:`, value);
    this.setSettings({ [setting]: value }).catch(this.error);
  }


  /** Write one setting and read it back, like the community converter does. */
  async _writeConfirmed(entry, value) {
    await entry.cluster.writeAttributes({ [entry.attribute]: value });
    const readback = (await entry.cluster.readAttributes([entry.attribute]))[entry.attribute];
    if (readback !== value) throw new Error(this.homey.__('errors.not_confirmed'));
  }


  _startTimers() {
    this._startLuxTimer();
    this._subscribeTimer = this.homey.setInterval(() => this._keepTrackingAlive(), SUBSCRIBE_EVERY_MS);
    this._peopleTimer = this.homey.setInterval(() => this._pollPeople(), PEOPLE_POLL_MS);
    this._keepTrackingAlive();
    this._pollPeople();
  }

  onDeleted() {
    this._stopTimers();
    super.onDeleted();
  }

  async onUninit() {
    this._stopTimers();
  }

  _stopTimers() {
    if (this._luxTimer) this.homey.clearInterval(this._luxTimer);
    if (this._learningTimer) this.homey.clearTimeout(this._learningTimer);
    if (this._zoneDeadlineTimer) this.homey.clearTimeout(this._zoneDeadlineTimer);
    for (const timer of [this._subscribeTimer, this._peopleTimer]) {
      if (timer) this.homey.clearInterval(timer);
    }
  }

  /* ------------------------------------------------------------ incoming frames */

  async _onFrame(clusterId, frame, header) {
    // Aqara events: global, manufacturer specific command 0x8B on the Aqara clusters.
    if (!AQARA_CLUSTERS.includes(clusterId) || header.clusterSpecific || !header.manufacturerSpecific || header.cmdId !== 0x8b) {
      return false;
    }
    if (clusterId === AqaraFp400LocationCluster.ID) {
      let decoded;
      try {
        decoded = decodeTrackingFrame(frame);
      } catch (err) {
        this.log('Unreadable tracking frame', frame.toString('hex'));
      }
      if (decoded) {
        // Targets on an ignore spot or outside the room never count for zones, even if the sensor still reports them.
        const counted = decoded.targets.filter(t => !this.isBlocked(t));
        const reported = decoded.reported - (decoded.targets.length - counted.length);
        this._rawTargets = decoded.targets;
        const events = this.tracker.accept(counted, reported, Date.now());
        this._publishZones(events);
      }
    } else if (clusterId === AqaraFp400RadarCluster.ID) {
      const event = decodeMotionEvent(frame);
      if (event) this.driver.movementTrigger.trigger(this, {}, { event }).catch(this.error);
    } else if (clusterId === AqaraFp400ConfigCluster.ID && frame.length === 8 && frame.readUInt16LE(5) === 3) {
      // Spatial learning result: event id 3, byte 7 = result code (0 looks like success, still provisional).
      const code = frame[7];
      this.log('Spatial learning result', code);
      this._finishLearning(code);
    }
    return true;
  }

  /* ------------------------------------------------------------ AI spatial learning status */

  _startLearning() {
    this._learning = { since: Date.now(), movement: false };
    if (this._learningTimer) this.homey.clearTimeout(this._learningTimer);
    // the FP400 reports its result; if nothing arrives within 15 minutes, stop waiting
    this._learningTimer = this.homey.setTimeout(() => this._finishLearning(null), FP400_LEARNING_TIMEOUT_MS);
    this.setWarning(this.homey.__('learning.busy_fp400')).catch(this.error);
    notify(this, 'fp400.learning_started');
  }

  _finishLearning(code) {
    if (this._learningTimer) this.homey.clearTimeout(this._learningTimer);
    this._learningTimer = null;
    const movement = this._learning ? this._learning.movement : false;
    this._learning = null;
    this.unsetWarning().catch(this.error);
    if (code === null) notify(this, 'learning.no_result');
    else notify(this, code === 0 ? 'fp400.learning_done' : 'fp400.learning_failed', { code });
    if (code !== null) this.driver.learningDoneTrigger.trigger(this, { success: code === 0 && !movement }).catch(this.error);
  }

  _onPresence(present) {
    const wasPresent = this.getCapabilityValue('alarm_motion') === true;
    this.setCapabilityValue('alarm_motion', present).catch(this.error);
    if (present !== wasPresent) this._pollPeople(); // the count follows presence right away
    if (present && this._learning && !this._learning.movement) {
      this._learning.movement = true;
      notify(this, 'learning.movement');
    }
    if (!present) this._rawTargets = [];
    const events = this.tracker.setPresence(present);
    this._publishZones(events);
  }

  async _readPresence() {
    const occupancy = this.zclNode.endpoints[1].clusters[CLUSTER.OCCUPANCY_SENSING.NAME];
    if (!occupancy) return;
    try {
      const { occupancy: value } = await occupancy.readAttributes(['occupancy']);
      this._onPresence(Boolean(value && value.occupied));
    } catch (err) {
      this.error('Reading presence failed', err.message);
    }
  }

  async _pollPeople() {
    // Nobody in the room: the count is 0, no need to ask the sensor every 30 seconds.
    if (this.getCapabilityValue('alarm_motion') === false) {
      if (this.getCapabilityValue('people_count') !== 0) {
        await this.setCapabilityValue('people_count', 0).catch(this.error);
        this.homey.app.peopleTrigger.trigger(this, { people: 0 }).catch(this.error);
      }
      return;
    }
    try {
      const { humanCount } = await this.radar.readAttributes(['humanCount']);
      if (typeof humanCount !== 'number') return;
      if (this.getCapabilityValue('people_count') !== humanCount) {
        await this.setCapabilityValue('people_count', humanCount);
        this.homey.app.peopleTrigger.trigger(this, { people: humanCount }).catch(this.error);
      }
    } catch (err) {
      this.error('Reading people count failed', err.message);
    }
  }

  /* ------------------------------------------------------------ tracking and zones */

  async _keepTrackingAlive() {
    const needed = Object.keys(this.getZones()).length > 0 || Date.now() < this._viewerUntil;
    if (!needed) return;
    try {
      await this.location.subscribeLocationData({ timeout: SUBSCRIBE_TIMEOUT_S });
    } catch (err) {
      this.error('Tracking subscription failed', err.message);
    }
  }

  /** Called by the map page: keep positions streaming while someone is looking. */
  markViewer() {
    const wasIdle = Date.now() >= this._viewerUntil && !Object.keys(this.getZones()).length;
    this._viewerUntil = Date.now() + VIEWER_HOLD_MS;
    if (wasIdle) this._keepTrackingAlive();
  }

  getZones() {
    return this.getStoreValue('zones') || {};
  }

  /** Older versions stored rectangles without a unique id: convert to painted cells and add an id. */
  async _migrateZoneIds() {
    const zones = { ...this.getZones() };
    let changed = false;
    for (const [slot, zone] of Object.entries(zones)) {
      let next = zone;
      if (!Array.isArray(zone.cells)) {
        next = { ...parseZone(zone), uid: zone.uid };
        changed = true;
      }
      if (!next.uid) {
        next = { ...next, uid: newUid() };
        changed = true;
      }
      zones[slot] = next;
    }
    if (changed) await this.setStoreValue('zones', zones);
  }

  /** Slot (1 to 8) of the zone with this unique id, or null. */
  slotOfZone(uid) {
    const entry = Object.entries(this.getZones()).find(([, zone]) => zone.uid === uid);
    return entry ? Number(entry[0]) : null;
  }

  async setZone(slot, value) {
    const id = Number(slot);
    if (!Number.isInteger(id) || id < 1 || id > 8) throw new Error('Zone slot must be 1 to 8');
    const zones = { ...this.getZones() };
    const zone = parseZone(value);
    if (zone) {
      // Editing keeps the id, so the zone device stays linked. A new zone gets a new id.
      zone.uid = (zones[id] && zones[id].uid) || newUid();
      zones[id] = zone;
    } else {
      delete zones[id];
    }
    await this.setStoreValue('zones', zones);
    this.tracker.setZones(zones);
    this._lastEmitted = '';
    this._publishZones([]);
    scheduleZoneDeadline(this);
    this._keepTrackingAlive();
    return zones;
  }

  /** Called when a zone device is deleted in Homey. */
  async removeZoneByUid(uid) {
    const slot = this.slotOfZone(uid);
    if (slot !== null) await this.setZone(slot, null);
  }

  /** Zone devices in Homey that belong to this sensor, keyed by zone id. */
  _linkedZoneDevices() {
    const result = {};
    try {
      for (const device of this.homey.drivers.getDriver('fp400_zone').getDevices()) {
        if (device.getStoreValue('parentToken') === this.token && device.getStoreValue('uid')) {
          result[device.getStoreValue('uid')] = device.getName();
        }
      }
    } catch (err) {
      this.error('Could not list zone devices', err.message);
    }
    return result;
  }

  zoneStates() {
    return this.tracker.state(Date.now());
  }

  _publishZones(events) {
    const states = this.zoneStates();
    scheduleZoneDeadline(this); // next moment a zone's "empty after" ends or the positions go stale
    const encoded = JSON.stringify(states);
    if (encoded === this._lastEmitted && !events.length) return;
    this._lastEmitted = encoded;
    this.homey.app.bus.emit(`zones:${this.token}`, { states, events });
  }

  getLiveState() {
    const now = Date.now();
    return {
      kind: this.kind,
      name: this.getName(),
      presence: this.getCapabilityValue('alarm_motion'),
      people: this.getCapabilityValue('people_count'),
      fresh: this.tracker.isFresh(now),
      targets: this.tracker.isFresh(now)
        ? (this._rawTargets || []).map(t => ({ ...t, ignored: this.isBlocked(t) }))
        : [],
      areas: this.getAreas(),
      zones: this.getZones(),
      zoneStates: this.zoneStates(),
      linked: this._linkedZoneDevices(),
    };
  }

  /* ------------------------------------------------------------ light */

  /**
   * The FP400 does not report its light value by itself, so asking is the only way; how often is the
   * user's setting. `settings` lets onSettings pass the new values (Homey stores them after onSettings).
   */
  _startLuxTimer(settings = this.getSettings()) {
    if (this._luxTimer) this.homey.clearInterval(this._luxTimer);
    this._luxSettings = settings;
    const seconds = settings.lux_poll_interval || 60;
    this._luxTimer = this.homey.setInterval(() => this._pollLux(), seconds * 1000);
    this._pollLux();
  }

  /**
   * Ask the sensor for the light level, then decide whether Homey shows the new value:
   * threshold = only when it changed by at least the threshold (% of the last shown value),
   * interval  = at least every report interval, also without change, or both.
   */
  async _pollLux() {
    if (!this.illuminance) return;
    try {
      const { measuredValue } = await this.illuminance.readAttributes(['measuredValue']);
      if (typeof measuredValue !== 'number') return;
      // ZCL: MeasuredValue = 10000 x log10(lux) + 1 (same formula as homey-zigbeedriver)
      const lux = Math.round(10 ** ((measuredValue - 1) / 10000));
      // diagnostics: the raw value, to check that the FP400 uses the standard ZCL scale
      if (measuredValue !== this._luxRaw) {
        this._luxRaw = measuredValue;
        this.log('Light raw value', measuredValue, '=', lux, 'lux');
      }
      const now = Date.now();
      const settings = this._luxSettings || this.getSettings();
      const mode = Number(settings.lux_report_mode || 3);
      const threshold = Number(settings.lux_report_threshold || 10);
      const interval = Number(settings.lux_report_interval || 600) * 1000;
      const last = this._luxShown;
      const changed = last === undefined || (last === 0 ? lux !== 0 : Math.abs(lux - last) / last * 100 >= threshold);
      const due = now - (this._luxShownAt || 0) >= interval;
      const show = last === undefined || (mode === 1 ? changed : mode === 2 ? due : changed || due);
      if (!show) return;
      this._luxShown = lux;
      this._luxShownAt = now;
      await this.setCapabilityValue('measure_luminance', lux);
    } catch (err) {
      this.error('Reading light failed', err.message);
    }
  }

  /* ------------------------------------------------------------ settings */

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.some(k => k.startsWith('lux_'))) {
      this._luxShown = undefined;
      this._startLuxTimer(newSettings); // the new values directly, no waiting for Homey to store them
    }
    // all sensor settings: write and read back; if the sensor does not confirm, Homey keeps the old value
    for (const entry of this._settingsTable()) {
      if (changedKeys.includes(entry.setting)) await this._writeConfirmed(entry, entry.toSensor(newSettings[entry.setting]));
    }
  }

}

module.exports = FP400Device;
