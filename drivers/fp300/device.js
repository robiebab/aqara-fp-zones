'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER, IdentifyCluster } = require('zigbee-clusters');
const { AqaraLumiCluster } = require('../../lib/AqaraClusters');
const {
  hookEndpoint, ensureCluster, parseAttributeRecords, parseLumiStruct,
} = require('../../lib/zclRaw');
const { ensureCapabilities, notify } = require('../../lib/deviceUtil');
const { parseBlockZone, blockOf, BlockTracker } = require('../../lib/fp300Zones');
const {
  PLAIN: SENSOR_SETTINGS, rangeBuffer, blocksFromTo, fromToOf, settingsFromAttributes, sameValue,
} = require('../../lib/fp300Settings');
const { WakePattern } = require('../../lib/wakePattern');
const { appDefaults, isZclStatus } = require('../../lib/resetDefaults');
const { buildTimeReadResponse } = require('../../lib/zigbeeTime');

const newUid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const VIEWER_TRACK_EVERY_MS = 5 * 60 * 1000;
const CONFIG_READ_EVERY_MS = 24 * 60 * 60 * 1000;        // configuration read at most once a day
const REPORTING_REFRESH_EVERY_MS = 24 * 60 * 60 * 1000;  // reporting refresh at most once a day
const FIRMWARE_READ_EVERY_MS = 7 * 24 * 60 * 60 * 1000;  // firmware version at most once a week
// The FP300 ends a distance measurement by itself after a while (20 to 30 minutes in user reports),
// without telling. That is the one rule here that cannot follow a sensor state: while the measurement
// is wanted, it is started again at the next message from the sensor once the last start is older
// than this. Nothing is sent outside a wake moment, and nothing is ever stopped by time.
const TRACK_RESTART_MS = 5 * 60 * 1000;
const MOTION_TITLES = {
  en: { none: 'Motion', mmwave: 'Motion: mmWave', pir: 'Motion: PIR', both: 'Motion: mmWave + PIR' },
  nl: { none: 'Beweging', mmwave: 'Beweging: mmWave', pir: 'Beweging: PIR', both: 'Beweging: mmWave + PIR' },
};
/*
 * AI spatial learning progress.
 * Logs of 9 October 2026 showed: the FP300 confirms the start with attribute 0x0157 = 1 and keeps
 * reporting 1 while asked. The time requests (cluster 0x000A) seen in the first runs were the
 * sensor retrying an unanswered time sync: since the app answers them (0.4.9) they stopped,
 * also during learning. So there is no message stream to count. Progress is therefore based on
 * the ~10 minutes Aqara advises, and learning ends early if the sensor ever reports 0x0157 = 0.
 */
const LEARN_EXPECTED_REQUESTS = 6; // kept for the time requests counter in the log only
const FP300_LEARNING_MS = 10 * 60 * 1000;
const LEARNING_RESULT_MS = 10 * 60 * 1000; // how long the result of a learning run stays in the settings
// settings the app reads back after writing, to be sure the sensor uses them
const CONFIRM_ATTRIBUTES = ['detectionRange', ...SENSOR_SETTINGS.map(e => e.attribute)]; // read back after writing

const RANGE_STEP = 0.25; // metres per detection block (zigbee-herdsman-converters fp300DetectionRange)
const RANGE_BLOCKS = 24;
const STRUCT_MAX_AGE_MS = 4 * 60 * 60 * 1000; // same refresh age as fp300BatteryPoll in Z2M


class FP300Device extends ZigBeeDevice {

  /** Every log line starts with the device name, so several sensors are easy to tell apart. */
  log(...args) {
    let name = '';
    try { name = this.getName(); } catch (err) { name = ''; }
    super.log(name ? `[${name}]` : '', ...args);
  }

  /** Sensor type, used by the zone wizard and the settings page. */
  get kind() { return 'fp300'; }

  async onNodeInit({ zclNode }) {
    this._pending = new Map(); // attributeName -> value, written when the sensor is awake
    this._oneShots = new Map(); // action -> { run, done }: sent once, only right after the sensor spoke
    this._pendingStructRead = false;
    this._flushing = false;
    this._rangePrefix = this.getStoreValue('rangePrefix') ?? 0x0300;
    this._lastTrackStart = 0;
    // remembered over app restarts, so a restart does not cause an extra battery read (0.6.34)
    this._lastStructAt = this.getStoreValue('structAt') || 0;

    this.lumi = ensureCluster(zclNode.endpoints[1], AqaraLumiCluster);
    this.token = this.getData().token;
    this._lastEmitted = '';
    this._lastDistanceAt = 0;
    this._viewerTrackAt = 0;
    await this._migrateZoneIds().catch(err => this.error('Zone id migration failed', err.message));
    this.tracker = new BlockTracker(this.getZones());
    this.tracker.update(this._zonePresence(), this.getCapabilityValue('target_distance'), Date.now());
    // absence timeouts of zones run on Homey's clock, not on sensor reports
    this._syncZoneTimer(); // only runs while this sensor has zones
    // What the sensor last reported: null until the first report or read after this start.
    this._mmwave = null;
    this._pir = null;
    this._session = false;
    // Read the real configuration (and firmware) only when it was not done in the last 24 hours:
    // the settings do not change by themselves, and every read costs the sensor battery.
    this._pendingConfigRead = this._due('configReadAt', CONFIG_READ_EVERY_MS);
    // the yes/no setting "motion alarm also on PIR" became the choice motion_source
    if (this.getSetting('motion_includes_pir') === true && !this.getStoreValue('motionSourceMigrated')) {
      await this.setSettings({ motion_source: 'both' }).catch(this.error);
    }
    if (!this.getStoreValue('motionSourceMigrated')) await this.setStoreValue('motionSourceMigrated', true).catch(this.error);
    // 0.6.12: the separate distance switches became one choice (distance_mode)
    if (!this.getStoreValue('distanceModeMigrated')) {
      let mode = 'auto';
      if (this.getSetting('track_on_presence') === false) mode = 'off';
      else if (this.getSetting('track_always') === true) mode = 'always';
      else if (this.getSetting('track_without_zones') === true) mode = 'present';
      await this.setSettings({ distance_mode: mode }).catch(this.error);
      await this.setStoreValue('distanceModeMigrated', true).catch(this.error);
    }
    // (since 0.6.12 repeated start is no longer a setting at all, so nothing to switch off)
    // learn when this sensor tends to wake up, to tell the user when a change will arrive
    this._wake = new WakePattern(this.getStoreValue('wakes'));
    this._resumeLearningWindow();
    this._motionTitleShown = this.getStoreValue('motionTitleShown');
    this._applyMotionTitle(this._motionTitleShown === undefined).catch(err => this.log('Motion title not set', err.message));
    // Not learning: the progress line shows a neutral text instead of the result of the last run.
    if (!this._learningUntil) this._setLearningIdle();
    this._wakeSavedAt = 0;
    await ensureCapabilities(this);

    // Maintenance actions (Device settings > Maintenance actions).
    this.registerCapabilityListener('button.identify', async () => this._queueOneShot('identify'));
    this.registerCapabilityListener('button.spatial_learning', async () => this._queueOneShot('spatial_learning'));
    this.registerCapabilityListener('button.restart', async () => this._queueOneShot('restart'));
    this.registerCapabilityListener('button.reset_defaults', async () => this._queueOneShot('reset_defaults'));

    // Every frame from the sensor passes here first (the sensor is awake at that moment).
    hookEndpoint(this, 1, (clusterId, frame, header) => this._onFrame(clusterId, frame, header));

    // Temperature, humidity and light: only listen. The FP300 sends them through its own Aqara reporting
    // settings, so no standard reporting is configured for them.
    // (Earlier versions did, which filled the sensor's report table: INSUFFICIENT_SPACE.)
    // Offsets and decimals (temperature_offset/_decimals, humidity_offset/_decimals)
    this.registerCapability('measure_temperature', CLUSTER.TEMPERATURE_MEASUREMENT, {
      reportParser: value => this._withOffset(value / 100, 'temperature', -65, 65),
    });
    this.registerCapability('measure_humidity', CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT, {
      reportParser: value => this._withOffset(value / 100, 'humidity', 0, 100),
    });
    this.registerCapability('measure_luminance', CLUSTER.ILLUMINANCE_MEASUREMENT);
    // Refresh presence/PIR reporting (and remove the standard reports of old versions) at most once
    // a day, and always after the sensor rejoined the network (onEndDeviceAnnounce).
    this._pendingReportingRefresh = this._due('reportingRefreshedAt', REPORTING_REFRESH_EVERY_MS);

    if (this.isFirstInit()) {
      // Right after pairing the sensor is awake: configure and read the current configuration.
      await this.configureAttributeReporting([
        { endpointId: 1, cluster: AqaraLumiCluster, attributeName: 'presence', minInterval: 0, maxInterval: 3600, minChange: 1 },
        { endpointId: 1, cluster: AqaraLumiCluster, attributeName: 'pirDetection', minInterval: 0, maxInterval: 3600, minChange: 1 },
      ]).catch(err => this.error('Configure reporting failed', err.message));
      await this._readConfiguration().catch(err => this.error('Reading configuration failed', err.message));
    }
  }

  /* ------------------------------------------------------------ incoming frames */

  async _onFrame(clusterId, frame, header) {
    this._noteWake();
    if (!this._learningUntil) this._probeLearningLater();
    // The sensor asks Homey for the time about every 1.5 minutes; answer it like Zigbee2MQTT does.
    if (clusterId === 0x000a) {
      const response = buildTimeReadResponse(frame, header, this.homey.clock.getTimezone());
      if (response) {
        this.zclNode.endpoints[1].sendFrame(0x000a, response)
          .then(() => this.log('Time requested by the sensor, answered'))
          .catch(err => this.log('Answering time request failed', err.message));
        if (this._learningUntil) {
          this.log('Learning trace', `cluster 0x${clusterId.toString(16)}`, `cmd 0x${header.cmdId.toString(16)}`, frame.toString('hex'));
          this._onLearningMessage();
          this._learningNoteMessage('time');
        }
        this._checkLearning();
        return true;
      }
    }
    // Diagnostics: while learning, log every message, to find out whether the FP300 reports
    // "learning done" in a way that is not documented yet (the Aqara hub seems to know quickly).
    if (this._learningUntil) {
      this.log('Learning trace', `cluster 0x${clusterId.toString(16)}`, `cmd 0x${header.cmdId.toString(16)}`, frame.toString('hex'));
      this._learningNoteMessage(this._messageKind(clusterId, frame, header));
      this._checkLearning();
    }
    if (clusterId === AqaraLumiCluster.ID && !header.clusterSpecific && [0x01, 0x0a].includes(header.cmdId)) {
      const attrs = parseAttributeRecords(frame, header);
      await this._handleLumiAttributes(attrs);
      this._keepMeasurementRunning();
      this._scheduleFlush(true);
      // Reports are consumed here, read responses go on so readAttributes() resolves.
      return header.cmdId === 0x0a;
    }
    this._keepMeasurementRunning();
    this._scheduleFlush(true);
    return false;
  }


  /*
   * Presence (mmWave, 0x0142) and PIR (0x014D) are handled as STATES. A report only counts when it
   * changes the state the app already has; the same state reported again (the FP300 repeats reports,
   * and repeats "PIR on" while the PIR stays on) changes nothing and is not logged.
   *
   *   one of them goes on, no session yet  -> motion alarm on, session on, distance measurement starts
   *   while one of them is on               -> the session runs; the measurement is kept running
   *   both report off                       -> read both back from the sensor right away (that report is
   *                                            a wake moment); only when both really are off: motion
   *                                            alarm off, session off, the measurement is not continued
   */
  async _handleLumiAttributes(attrs) {
    const changes = [];
    if (attrs[0x0142] !== undefined && (attrs[0x0142] === 1) !== this._mmwave) {
      this._mmwave = attrs[0x0142] === 1;
      changes.push('mmWave');
      this.log(`mmWave presence ${this._mmwave ? 'on' : 'off'}`);
    }
    if (attrs[0x014d] !== undefined && (attrs[0x014d] === 1) !== this._pir) {
      this._pir = attrs[0x014d] === 1;
      changes.push('PIR');
      this.log(`PIR ${this._pir ? 'on' : 'off'}`);
      this._pirCard();
    }
    if (changes.length) await this._onStateChange(changes.join(' + '));
    if (attrs[0x015f] !== undefined) {
      await this._setDistance(Math.round(attrs[0x015f]) / 100);
    }
    if (Buffer.isBuffer(attrs[0x00f7])) {
      this._lastStructAt = Date.now();
      this.setStoreValue('structAt', this._lastStructAt).catch(this.error);
      const struct = parseLumiStruct(attrs[0x00f7]);
      this._logStruct('0x00f7', struct);
      // Tag 0x18 = battery percentage, tag 0x17 = battery voltage (mV), see lumiBattery for PS-S04D in Z2M.
      // Battery: the sensor's own percentage (tag 0x18), like Zigbee2MQTT. If a firmware leaves it out, use the
      // voltage (tag 0x17) with a linear curve (2850 mV = 0 %, 3000 mV = 100 %).
      let battery = null;
      if (typeof struct[0x18] === 'number' && struct[0x18] >= 0 && struct[0x18] <= 100) battery = struct[0x18];
      else if (typeof struct[0x17] === 'number' && struct[0x17] > 1000) {
        battery = Math.round(Math.max(0, Math.min(100, ((struct[0x17] - 2850) / 150) * 100)));
      }
      if (battery !== null) {
        this.log(`Battery: ${battery} %${typeof struct[0x17] === 'number' ? ` (${struct[0x17]} mV)` : ''}`);
        await this.setCapabilityValue('measure_battery', battery).catch(this.error);
      }
    }
    if (Buffer.isBuffer(attrs[0x00df])) this._logStruct('0x00df', parseLumiStruct(attrs[0x00df]));
    if (Buffer.isBuffer(attrs[0x019a]) && attrs[0x019a].length >= 5) {
      this._rangePrefix = attrs[0x019a].readUInt16LE(0);
      await this.setStoreValue('rangePrefix', this._rangePrefix).catch(this.error);
    }
    if (attrs[0x0198] !== undefined) this.log('Track distance attribute', attrs[0x0198]);
    // configuration values reported or read from the sensor: keep the Homey settings equal to them
    await this._applySensorValues(attrs);
    // Aqara "prevent leave": when the sensor reports false, set it back to true,
    // so the sensor does not drop off the network.
    if (attrs[0x00fc] === false || attrs[0x00fc] === 0) {
      this.log('Prevent leave reported off: setting it back on');
      this._pending.set('preventLeave', true);
    }
    if (attrs[0x0157] !== undefined) this._onLearningState(attrs[0x0157]);
  }

  async _setDistance(current) {
    const previous = this.getCapabilityValue('target_distance');
    // Homey runs the "target_distance_changed" trigger itself for this custom capability.
    await this.setCapabilityValue('target_distance', current).catch(this.error);
    // diagnostics: how often distances come in (seconds since the previous one)
    const gap = this._lastDistanceAt ? ((Date.now() - this._lastDistanceAt) / 1000).toFixed(1) : '-';
    this.log(`Distance ${current} m (previous ${gap} s ago)`);
    this._lastDistanceAt = Date.now();
    this._publishZones(this.tracker.update(this._zonePresence(), current, Date.now()));
    if (previous === current) return;
    const tokens = { distance: current };
    const state = { previous, current };
    const { driver } = this;
    for (const card of ['distance_below', 'distance_above', 'entered_range', 'left_range']) {
      driver.triggers[card].trigger(this, tokens, state).catch(this.error);
    }
  }



  /** Someone is there according to the sensor: mmWave or PIR on. */
  _present() {
    return this._mmwave === true || this._pir === true;
  }

  async _onStateChange(source) {
    const present = this._present();
    if (present) {
      if (this._mmwave) this._movementWhileLearning();
      if (this._learningUntil) { this._learningEmptySince = null; this._learningMovementAt = Date.now(); }
    } else if (this._learningUntil && !this._learningEmptySince) {
      this._learningEmptySince = Date.now();
    }
    this._applyMotionTitle().catch(err => this.log('Motion alarm name not updated', err.message));
    if (present) {
      if (!this._session) this._startSession(source);
      await this._applyMotionAlarm(source);
    } else {
      this._verifyAbsence(source); // not awaited: the read answer passes through this same code
    }
    this._updateZones();
  }

  _startSession(source) {
    this._session = true;
    if (this._distanceMode() === 'off') return this.log(`Session started (${source}): distance measurement is switched off in the settings`);
    if (this._learningBusy()) return this.log(`Session started (${source}): no measurement, AI spatial learning is busy`);
    if (this.getSetting('detection_mode') === '2') return this.log(`Session started (${source}): no measurement, "Detection with" is PIR only (radar off)`);
    if (!this._distanceWanted()) return this.log(`Session started (${source}): no distance needed (no zones), presence only`);
    this._pending.set('trackDistance', 1);
    this.log(`Session started (${source}): starting the distance measurement`);
  }

  _endSession(source) {
    if (!this._session) return;
    this._session = false;
    this._pending.delete('trackDistance');
    this.log(`Session ended (${source}): mmWave and PIR off, the measurement is not continued`);
  }

  /** Both reported off: read both back from the sensor; only if both really are off, switch off. */
  async _verifyAbsence(source) {
    if (this._verifying) return;
    if (!this._session && this.getCapabilityValue('alarm_motion') !== true) return; // nothing to switch off
    this._verifying = true;
    try {
      if (this.lumi) await this.lumi.readAttributes(['presence', 'pirDetection']);
    } catch (err) {
      this.log(`Check after "${source} off" not answered, using the reports:`, err.message);
    } finally {
      this._verifying = false;
    }
    // The answer went through _handleLumiAttributes: if it changed a state, that has been handled there.
    if (this._present()) return this.log(`Checked the sensor after "${source} off": still someone there`);
    this.log(`Checked the sensor after "${source} off": mmWave off, PIR off`);
    await this._applyMotionAlarm(source, true);
    this._endSession(source);
    this._updateZones();
  }

  /** At a wake moment: keep the measurement running while it is wanted (see TRACK_RESTART_MS). */
  _keepMeasurementRunning() {
    const wanted = this._session || this._distanceMode() === 'always';
    if (!wanted || !this._distanceWanted() || this._learningBusy()) return;
    if (this._distanceMode() === 'off' || this.getSetting('detection_mode') === '2') return;
    if (Date.now() - this._lastTrackStart < TRACK_RESTART_MS || this._pending.has('trackDistance')) return;
    this._pending.set('trackDistance', 1);
    this.log('Measurement continued (still someone there)');
  }

  /** PIR flow cards: fired on a change of the PIR state only. */
  _pirCard() {
    const card = this.driver && (this._pir ? this.driver.pirOnTrigger : this.driver.pirOffTrigger);
    if (card) card.trigger(this, {}, {}).catch(this.error);
  }

  /** For the condition card: does the PIR report movement right now? */
  pirActive() {
    return this._pir === true;
  }

  /**
   * The motion alarm (alarm_motion, also used by Homey's zones/rooms) follows the setting "Motion alarm
   * on": mmWave, PIR or both. It goes on as soon as its source reports on. It goes off when its source
   * reports off; when that means nobody at all is there, only after the sensor confirmed it.
   */
  _motionValue(mode = this._motionSource()) {
    if (mode === 'pir') return this._pir === true;
    if (mode === 'both') return this._present();
    return this._mmwave === true;
  }

  async _applyMotionAlarm(source, confirmed = false, mode = this._motionSource()) {
    const value = this._motionValue(mode);
    if (value === this.getCapabilityValue('alarm_motion')) return;
    if (!value && !this._present() && !confirmed) return; // nobody: _verifyAbsence switches it off
    this.log(`Motion alarm ${value ? 'on' : 'off'} (${source}, motion alarm on: ${mode})`);
    await this.setCapabilityValue('alarm_motion', value).catch(this.error);
    this._updateZones(); // zones follow the main sensor at once
  }

  /** Name of the motion alarm: what the sensor reports right now (Motion, mmWave, PIR or both). */
  _motionTitleKey() {
    if (this._mmwave && this._pir) return 'both';
    if (this._mmwave) return 'mmwave';
    if (this._pir) return 'pir';
    return 'none';
  }

  /** The sensor's own presence report (0x0142). Kept apart from the motion alarm, which can include the PIR. */
  _mmwavePresence() {
    return this._mmwave;
  }



  async _applyMotionTitle(force = false) {
    const key = this._motionTitleKey();
    if (!force && key === this._motionTitleShown) return;
    this._motionTitleShown = key;
    this.setStoreValue('motionTitleShown', key).catch(this.error);
    const title = { en: MOTION_TITLES.en[key], nl: MOTION_TITLES.nl[key] };
    await this.setCapabilityOptions('alarm_motion', { title });
    this.log(`Motion alarm name: ${title.en}`);
  }

  _motionSource() {
    const v = this.getSetting('motion_source');
    return ['mmwave', 'pir', 'both'].includes(v) ? v : 'mmwave';
  }


  _updateZones() {
    this._publishZones(this.tracker.update(this._zonePresence(), this.getCapabilityValue('target_distance'), Date.now()));
  }

  /**
   * Presence for the zones = the main sensor: the motion alarm of this FP300 device (as set with
   * "Motion alarm on": mmWave, PIR or both). The user's rule: the main sensor decides whether someone
   * is in the room at all; the distance only decides in WHICH zone. When the main sensor sees nobody,
   * nobody can be in any of its zones, so every zone goes off at once.
   */
  _zonePresence() {
    return this.getCapabilityValue('alarm_motion');
  }









  /**
   * Reporting setup:
   *  - configure reporting for presence (0x0142) and PIR (0x014D) after every start, not only at pairing;
   *  - no standard reporting for temperature, humidity and light. Earlier versions of this app configured
   *    those, so they are removed once (maximum interval 0xFFFF, ZCL), which frees the report table.
   */
  async _refreshReporting() {
    if (!this._pendingReportingRefresh) return;
    await this.lumi.configureReporting({
      presence: { minInterval: 0, maxInterval: 3600, minChange: 1 },
      pirDetection: { minInterval: 0, maxInterval: 3600, minChange: 1 },
    });
    this.log('Presence and PIR reporting refreshed in the sensor');
    if (!this.getStoreValue('stdReportsRemovedV1')) {
      const ep = this.zclNode.endpoints[1];
      for (const name of [CLUSTER.TEMPERATURE_MEASUREMENT.NAME, CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT.NAME, CLUSTER.ILLUMINANCE_MEASUREMENT.NAME]) {
        const cluster = ep.clusters[name];
        if (!cluster) continue;
        try {
          await cluster.configureReporting({ measuredValue: { minInterval: 0, maxInterval: 0xffff, minChange: 0 } });
          this.log(`Standard ${name} report removed (the sensor reports it by itself)`);
        } catch (err) {
          if (!/^[A-Z_]+$/.test(String(err && err.message))) throw err; // asleep: try again next wake
          this.log(`Removing the standard ${name} report gave`, err.message);
        }
      }
      await this.setStoreValue('stdReportsRemovedV1', true);
      await this.setStoreValue('freedReporting', []);
    }
    this._pendingReportingRefresh = false;
    this.setStoreValue('reportingRefreshedAt', Date.now()).catch(this.error);
  }







  /**
   * Distance measurement is only used for zones, for the live strip while configuring, or when the user
   * explicitly wants distance (distance_mode present/always, e.g. for distance flows). Otherwise the FP300
   * uses presence and PIR only, which is reliable and saves battery.
   */
  /**
   * Distance measurement mode (setting distance_mode, one choice instead of several switches):
   *   auto     only for a sensor with zones, and while the live strip is open (default)
   *   present  whenever someone is present, also without zones (e.g. for distance flows)
   *   always   also in an empty room, so a zone has a distance the moment someone enters (more battery)
   *   off      never (zones on this sensor then do not work); the live strip still measures while open
   */
  _distanceMode() {
    const v = this.getSetting('distance_mode');
    return ['auto', 'present', 'always', 'off'].includes(v) ? v : 'auto';
  }

  _distanceWanted() {
    if (Date.now() < (this._viewerUntil || 0)) return true; // live strip open: always measure
    const mode = this._distanceMode();
    if (mode === 'off') return false;
    if (mode === 'present' || mode === 'always') return true;
    return Object.keys(this.getZones()).length > 0;
  }


  /** The 1-second zone clock (absence timeouts) is only needed while there are zones. */
  _syncZoneTimer() {
    const needed = Object.keys(this.getZones()).length > 0;
    if (needed && !this._zoneTimer) {
      this._zoneTimer = this.homey.setInterval(() => this._publishZones([]), 1000); // "empty after" per zone
    } else if (!needed && this._zoneTimer) {
      this.homey.clearInterval(this._zoneTimer);
      this._zoneTimer = null;
    }
  }


  /** Flow action: start now, or as soon as the sensor wakes up. */
  async startTracking() {
    this._pending.set('trackDistance', 1);
    await this._flush();
    return !this._pending.has('trackDistance');
  }

  /* ------------------------------------------------------------ writing while awake */

  /** @param {boolean} awake true when called right after a frame from the sensor */
  _scheduleFlush(awake = false) {
    // Battery struct older than 4 hours, or not received since the app started: read it on this wake.
    // Firmware 0.0.0_6542 no longer pushes 0x00F7 by itself (Zigbee2MQTT issue #32153), so without
    // this read the battery would never update. Same rule as fp300BatteryPoll in Zigbee2MQTT.
    if (Date.now() - (this._lastStructAt || 0) > STRUCT_MAX_AGE_MS) this._pendingStructRead = true;
    const oneShots = awake && this._oneShots.size > 0;
    const hk = this._housekeepingAllowed();
    const pushJob = awake && hk && this._pendingReportingRefresh;
    const reads = hk && (this._pendingStructRead || this._pendingConfigRead);
    if (!this._pending.size && !reads && !oneShots && !pushJob) return;
    this.homey.setTimeout(() => this._flush(awake).catch(this.error), 50);
  }

  /**
   * Housekeeping (reading the configuration, firmware, battery status, refreshing the reporting) is
   * not urgent. While someone is present the sensor is busy measuring and sending distances, so it
   * waits until the sensor reports nobody (that message is itself a wake moment). Settings the user
   * changed and maintenance actions are never held back.
   */
  _housekeepingAllowed() {
    if (!this._session) { this._housekeepingWaitLogged = false; return true; }
    const due = this._pendingConfigRead || this._pendingStructRead || this._pendingReportingRefresh;
    if (due && !this._housekeepingWaitLogged) {
      this._housekeepingWaitLogged = true;
      this.log('Status and configuration reads wait until nobody is present');
    }
    return false;
  }

  /** Is a periodic task due: never done, or longer ago than `every` (time kept in the device store)? */
  _due(key, every) {
    return Date.now() - (this.getStoreValue(key) || 0) > every;
  }

  /** Sends pending writes one at a time (advised for sleepy end devices). */
  async _flush(awake = false) {
    if (!this.lumi) return true;
    if (this._flushing) {
      // A flush is busy (e.g. reading the configuration). Remember to run again right after it,
      // so a distance start that just came in does not have to wait for the next message.
      this._flushAgain = Boolean(this._flushAgain) || awake;
      return true;
    }
    this._flushing = true;
    try {
      let wroteSetting = false;
      if (this._learningBusy()) this._pending.delete('trackDistance');
      // Speed: the distance start goes first, settings (each with a read back) after it.
      const order = [...this._pending].sort((a, b) => (a[0] === 'trackDistance' ? -1 : 0) - (b[0] === 'trackDistance' ? -1 : 0));
      for (const [name, value] of order) {
        await this.lumi.writeAttributes({ [name]: value });
        if (name !== 'trackDistance') wroteSetting = true;
        if (this._pending.get(name) === value) this._pending.delete(name);
        if (name === 'trackDistance') this._lastTrackStart = Date.now();
        this.log('Written', name, value);
        if (CONFIRM_ATTRIBUTES.includes(name)) await this._confirmWrite(name, value);
      }
      if (this._announceApplied && wroteSetting) {
        this._announceApplied = false;
        notify(this, 'fp300.applied', { time: this._time(Date.now()) });
      }
      // Housekeeping is checked again before every step: the first read (presence) can itself reveal
      // that someone is there (log of 15 October, kitchen), and then the rest waits for "nobody".
      if (this._housekeepingAllowed() && this._pendingConfigRead) {
        await this.lumi.readAttributes(['presence', 'pirDetection']).catch(err => this.log('Reading presence failed', err.message));
        if (this._housekeepingAllowed()) {
          if (this._due('firmwareReadAt', FIRMWARE_READ_EVERY_MS) || this.getSetting('firmware_info') === '-') {
            await this._readFirmware();
            this.setStoreValue('firmwareReadAt', Date.now()).catch(this.error);
          }
          await this._readConfiguration();
          this._pendingConfigRead = false;
          this.setStoreValue('configReadAt', Date.now()).catch(this.error);
          this.log('Configuration read from the sensor');
        }
      }
      if (this._housekeepingAllowed() && this._pendingStructRead) {
        await this.lumi.readAttributes(['lumiStruct']);
        this._pendingStructRead = false;
      }
      if (awake) await this._runOneShots();
      if (awake && this._housekeepingAllowed()) await this._refreshReporting();
      return true;
    } catch (err) {
      this.log('Sensor not reachable now, retrying on next wake up:', err.message);
      return false;
    } finally {
      this._flushing = false;
      if (this._warning) this._updateWaitingWarning();
      if (this._flushAgain !== undefined && this._flushAgain !== null) {
        const again = this._flushAgain;
        this._flushAgain = null;
        if (this._pending.size || (again && this._oneShots.size)) this.homey.setTimeout(() => this._flush(again).catch(this.error), 0);
      }
    }
  }

  /* ------------------------------------------------------------ one-shot actions */

  _oneShotActions() {
    return {
      identify: () => ensureCluster(this.zclNode.endpoints[1], IdentifyCluster).identify({ identifyTime: 5 }),
      spatial_learning: () => this.lumi.writeAttributes({ spatialLearning: 1 }),
      restart: () => this.lumi.writeAttributes({ restartDevice: false }),
      reset_defaults: () => this._resetDefaults(),
    };
  }

  /**
   * Restart, identify and learning are sent exactly once, right after the sensor sent something
   * (only then is a sleeping sensor listening). They are never repeated automatically, because a
   * restart can drop the reply and would otherwise run again on every wake up.
   */
  async _queueOneShot(action) {
    this._oneShots.set(action, true);
    if (action === 'spatial_learning') this._pending.delete('trackDistance');
    notify(this, 'fp300.queued', { action: this.homey.__(`actions.${action}`), eta: this.wakeText() });
    this._updateWaitingWarning();
  }

  async _runOneShots() {
    const actions = this._oneShotActions();
    // Restart last, so the other actions are not lost.
    const order = ['identify', 'reset_defaults', 'spatial_learning', 'restart'].filter(a => this._oneShots.has(a));
    for (const action of order) {
      this._oneShots.delete(action);
      try {
        await actions[action]();
        this.log('Action sent', action);
        if (action === 'spatial_learning') this._startLearningWindow();
        if (action === 'restart') this._restartSentAt = Date.now();
      } catch (err) {
        if (action === 'reset_defaults') {
          // not reached (asleep): try again on the next wake moment
          this._oneShots.set(action, true);
          this.log('Reset not reached, trying again on the next wake:', err.message);
          continue;
        }
        // A restart often drops its reply; the command did go out.
        this.log(`Action ${action} sent, no confirmation:`, err.message);
        if (action === 'restart') this._restartSentAt = Date.now();
      }
      // spatial learning gets its own messages (started, done)
      if (action !== 'spatial_learning' && action !== 'reset_defaults') notify(this, 'fp300.sent', { action: this.homey.__(`actions.${action}`) });
    }
  }

  /**
   * Firmware of this sensor (Basic cluster). Users report different behaviour per firmware
   * (launch 5234, then 0.0.0_5841 and 0.0.0_6542), so it is shown in the settings and the log.
   */
  async _readFirmware() {
    const basic = this.zclNode.endpoints[1].clusters.basic;
    if (!basic) return;
    try {
      const v = await basic.readAttributes(['swBuildId', 'dateCode', 'appVersion']);
      const text = [v.swBuildId, v.dateCode].filter(x => typeof x === 'string' && x.trim()).map(x => x.replace(/\u0000/g, '').trim()).join(', ')
        || (typeof v.appVersion === 'number' ? `app ${v.appVersion}` : 'unknown');
      this.log(`Firmware: ${text}`);
      await this.setSettings({ firmware_info: text }).catch(err => this.log('Firmware not shown', err.message));
    } catch (err) {
      this.log('Reading the firmware failed:', err.message);
    }
  }

  /**
   * Default settings without pairing again (see lib/resetDefaults.js). If the FP300 does not support
   * the ZCL reset, the detection settings get standard values instead
   * (mmWave + PIR, medium sensitivity, 10 s, AI interference and adaptive on, full range, medium sampling).
   */
  async _resetDefaults() {
    const sensorKeys = ['range_min', 'range_max', ...SENSOR_SETTINGS.map(e => e.setting)];
    await this.setSettings(appDefaults(this.driver.manifest.settings, sensorKeys)).catch(this.error);
    let viaZcl = true;
    try {
      await this.zclNode.endpoints[1].clusters.basic.factoryReset();
      this.log('Sensor reset to factory defaults (ZCL Basic command 0x00)');
    } catch (err) {
      if (!isZclStatus(err)) throw err; // asleep: the one-shot runner reports it, try again later
      viaZcl = false;
      this.log('ZCL factory reset not supported:', err.message, '- writing standard detection values');
      const defaults = {
        detectionMode: 0, motionSensitivity: 2, absenceDelay: 10, aiInterference: 1, aiAdaptiveSensitivity: 1,
        thSampling: 2, lightSampling: 2, detectionRange: rangeBuffer(this._rangePrefix, [...Array(RANGE_BLOCKS).keys()]),
      };
      for (const [name, value] of Object.entries(defaults)) this._pending.set(name, value);
      await this.setStoreValue('rangeBlocks', [...Array(RANGE_BLOCKS).keys()]);
    }
    this._pendingConfigRead = true; // read what the sensor uses now into the settings
    notify(this, viaZcl ? 'reset.done_sensor' : 'reset.done_fallback');
  }

  /** Round to the chosen decimals and add the user's offset; out-of-range values are ignored. */
  _withOffset(raw, kind, min, max) {
    if (typeof raw !== 'number' || raw < min || raw > max) return null;
    const decimals = this.getSetting(`${kind}_decimals`) === '2' ? 2 : 1;
    const offset = Number(this.getSetting(`${kind}_offset`) || 0);
    const f = 10 ** decimals;
    return Math.round((raw + offset) * f) / f;
  }

  /**
   * The sensor rejoined the network (end device announce), e.g. after a battery change or reset.
   * Set reporting again and read state and settings.
   */
  onEndDeviceAnnounce() {
    this.log('Sensor announced itself on the network: refreshing reporting and reading its state');
    this._pendingReportingRefresh = true;
    this._pendingConfigRead = true;
    this.setStoreValue('firmwareReadAt', 0).catch(this.error); // a rejoin can follow a firmware update
    this._pendingStructRead = true;
    this._scheduleFlush(true);
  }

  /** Read a setting back from the sensor; tell the user when the sensor did not take it. */
  async _confirmWrite(name, value) {
    try {
      const got = (await this.lumi.readAttributes([name]))[name];
      const same = sameValue(name, value, got);
      this.log('Read back', name, Buffer.isBuffer(got) ? got.toString('hex') : got, same ? '(ok)' : `(expected ${Buffer.isBuffer(value) ? value.toString('hex') : value})`);
      if (!same) {
        // show what the sensor really uses, so Homey and the sensor never disagree
        await this._applySensorValues({ [name]: got });
        notify(this, 'fp300.not_applied', { setting: name });
      }
    } catch (err) {
      this.log('Read back failed', name, err.message);
    }
  }

  async _readConfiguration() {
    // every attribute from the shared settings table, in small groups to keep each answer short
    const names = ['detectionRange', ...SENSOR_SETTINGS.map(e => e.attribute)];
    const values = {};
    for (let i = 0; i < names.length; i += 5) {
      try {
        Object.assign(values, await this.lumi.readAttributes(names.slice(i, i + 5)));
      } catch (err) {
        if (i === 0) throw err; // the sensor is not reachable at all: try again next wake
        this.log('Reading part of the configuration failed, keeping what Homey shows:', err.message);
      }
    }
    if (Buffer.isBuffer(values.detectionRange) && values.detectionRange.length >= 5) {
      this._rangePrefix = values.detectionRange.readUInt16LE(0);
      await this.setStoreValue('rangePrefix', this._rangePrefix);
    }
    const { settings } = await this._applySensorValues(values, { all: true });
    const mode = { 0: 'mmWave + PIR', 1: 'mmWave only', 2: 'PIR only' }[values.detectionMode];
    const range = settings.range_min !== undefined ? `${settings.range_min} to ${settings.range_max} m` : 'unknown';
    this.log(`Radar settings in the sensor: detection ${mode || 'unknown'}, range ${range}, sensitivity ${values.motionSensitivity}`
      + ` (1 low, 3 high), absence delay ${values.absenceDelay} s, PIR interval ${values.pirInterval} s,`
      + ` adaptive ${values.aiAdaptiveSensitivity}, interference ${values.aiInterference}`);
  }

  /**
   * Put values that came from the sensor into the Homey settings (and the stored detection range),
   * using the shared table. Attributes with a write still waiting are skipped, so a report with the
   * old value never undoes a change the user just made. Only changed settings are written.
   */
  async _applySensorValues(attrs, { all = false } = {}) {
    const pendingIds = new Set([...this._pending.keys()]);
    const filtered = {};
    for (const [key, value] of Object.entries(attrs)) {
      const name = /^\d+$/.test(key)
        ? Object.keys(AqaraLumiCluster.ATTRIBUTES).find(n => AqaraLumiCluster.ATTRIBUTES[n].id === Number(key))
        : key;
      if (!name || pendingIds.has(name)) continue;
      filtered[key] = value;
    }
    const { settings, blocks } = settingsFromAttributes(filtered);
    if (blocks) await this.setStoreValue('rangeBlocks', blocks).catch(this.error);
    const changed = {};
    for (const [key, value] of Object.entries(settings)) {
      if (all || this.getSetting(key) !== value) changed[key] = value;
    }
    if (Object.keys(changed).length) {
      await this.setSettings(changed).catch(err => this.log('Settings not updated from the sensor', err.message));
      if (!all) this.log('Settings updated from the sensor:', JSON.stringify(changed));
    }
    return { settings, blocks };
  }


  /** The detection range as 25 cm blocks (0 to 23), as the sensor has it (or the from/to settings). */
  getRangeBlocks() {
    const stored = this.getStoreValue('rangeBlocks');
    if (Array.isArray(stored)) return stored;
    const first = Math.round((this.getSetting('range_min') || 0) / RANGE_STEP);
    const last = Math.round((this.getSetting('range_max') || 6) / RANGE_STEP) - 1;
    return [...Array(RANGE_BLOCKS).keys()].filter(i => i >= first && i <= last);
  }

  /**
   * Set the detection range from painted blocks (gaps allowed, any of the 24 blocks).
   * Sent when the sensor is awake, then read back. The from/to settings show the outer limits.
   */
  async setRangeBlocks(value) {
    if (!Array.isArray(value)) throw new Error('blocks must be a list');
    const blocks = [...new Set(value.map(Number))].filter(n => Number.isInteger(n) && n >= 0 && n < RANGE_BLOCKS).sort((a, b) => a - b);
    if (!blocks.length) throw new Error(this.homey.__('errors.range_empty'));
    this._pending.set('detectionRange', rangeBuffer(this._rangePrefix, blocks));
    this._announceApplied = true;
    await this.setStoreValue('rangeBlocks', blocks);
    await this.setSettings(fromToOf(blocks)).catch(this.error);
    this.homey.setTimeout(() => this._updateWaitingWarning(), 1500);
    this._flush().catch(this.error);
    return { blocks, message: this.homey.__('settings.saved_eta', { eta: this.wakeText() }) };
  }

  /** Flow action and settings: queue a new detection range. */
  async applyRange(min, max) {
    if (!(max > min)) throw new Error(this.homey.__('errors.range'));
    const blocks = blocksFromTo(min, max);
    this._pending.set('detectionRange', rangeBuffer(this._rangePrefix, blocks));
    await this.setStoreValue('rangeBlocks', blocks);
    await this._flush();
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('motion_source')) {
      await this._applyMotionAlarm('setting', true, newSettings.motion_source);
    }
    if (changedKeys.includes('range_min') || changedKeys.includes('range_max')) {
      if (!(newSettings.range_max > newSettings.range_min)) throw new Error(this.homey.__('errors.range'));
      const blocks = blocksFromTo(newSettings.range_min, newSettings.range_max);
      this._pending.set('detectionRange', rangeBuffer(this._rangePrefix, blocks));
      await this.setStoreValue('rangeBlocks', blocks);
    }
    // every other sensor setting goes through the shared table (lib/fp300Settings.js)
    for (const entry of SENSOR_SETTINGS) {
      if (changedKeys.includes(entry.setting)) this._pending.set(entry.attribute, entry.toSensor(newSettings[entry.setting]));
    }
    // Interval and threshold only work in "custom" sampling. Switch to
    // custom (4) automatically when one of them changes, so a change always takes effect.
    const autoCustom = [
      { sampling: 'th_sampling', attribute: 'thSampling', keys: ['temp_report_mode', 'temp_report_interval', 'temp_report_threshold', 'humidity_report_mode', 'humidity_report_interval', 'humidity_report_threshold', 'th_sampling_period'] },
      { sampling: 'light_sampling', attribute: 'lightSampling', keys: ['light_report_mode', 'light_report_interval', 'light_report_threshold', 'light_sampling_period'] },
    ];
    for (const group of autoCustom) {
      if (changedKeys.includes(group.sampling) || newSettings[group.sampling] === '4') continue;
      if (!group.keys.some(k => changedKeys.includes(k))) continue;
      this._pending.set(group.attribute, 4);
      // Homey stores newSettings after onSettings; show "custom" right after that
      this.homey.setTimeout(() => this.setSettings({ [group.sampling]: '4' }).catch(this.error), 1000);
      this.log(`Sampling ${group.sampling} switched to custom, so the new interval or threshold takes effect`);
    }
    if (changedKeys.includes('distance_mode')) this._lastTrackStart = 0;

    this.homey.setTimeout(() => this._flush().catch(this.error), 0);
    this._announceApplied = true;
    this.homey.setTimeout(() => this._updateWaitingWarning(), 1500);
    return this.homey.__('settings.saved_eta', { eta: this.wakeText() });
  }


  /* ------------------------------------------------------------ wake up pattern */

  _noteWake() {
    const now = Date.now();
    // first message after a restart: the sensor is back
    if (this._restartSentAt && now - this._restartSentAt > 5000) {
      this._restartSentAt = null;
      notify(this, 'fp300.restart_done', { time: this._time(now) });
    }
    if (!this._wake.note(now)) return;
    if (now - this._wakeSavedAt > 60 * 1000) {
      this._wakeSavedAt = now;
      this.setStoreValue('wakes', this._wake.wakes).catch(this.error);
    }
  }

  _time(ms) {
    const lang = this.homey.i18n.getLanguage();
    return new Date(ms).toLocaleTimeString(lang === 'nl' ? 'nl-NL' : 'en-GB', {
      timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit',
    });
  }

  _duration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 90) return this.homey.__('wake.seconds', { n: s });
    const m = Math.round(s / 60);
    if (m < 90) return this.homey.__('wake.minutes', { n: m });
    return this.homey.__('wake.hours', { n: Math.round(m / 6) / 10 });
  }

  /** One sentence: when will a change probably arrive at the sensor. */
  wakeText() {
    const now = Date.now();
    const stats = this._wake.stats(now);
    if (!stats) return this.homey.__('wake.learning');
    const until = stats.next - now;
    return this.homey.__('wake.eta', {
      every: this._duration(stats.median),
      next: this._time(stats.next),
      in: until < 60 * 1000 ? this.homey.__('wake.soon') : this._duration(until),
    });
  }

  /** Warning on the device tile while something waits for the sensor; removed once it arrived. */
  _updateWaitingWarning() {
    const waiting = [...this._pending.keys()].some(k => k !== 'trackDistance') || this._oneShots.size > 0;
    if (this._learningUntil) {
      this.setWarning(this.homey.__('learning.busy', { until: this._time(this._learningUntil) })).catch(this.error);
      this._warning = true;
    } else if (waiting) {
      this.setWarning(this.homey.__('wake.warning', { eta: this.wakeText() })).catch(this.error);
      this._warning = true;
    } else if (this._warning) {
      this.unsetWarning().catch(this.error);
      this._warning = false;
    }
  }

  /* ------------------------------------------------------------ AI spatial learning status */

  /**
   * Diagnostics: log the sensor's status structs as tag=value, marked with whether learning runs,
   * so a tag that only changes while learning can be found by comparing.
   */
  _logStruct(name, struct) {
    const tags = Object.keys(struct).map(t => `${Number(t).toString(16).padStart(2, '0')}=${struct[t]}`).join(' ');
    this.log(`Status ${name} (${this._learningUntil ? 'during learning' : 'not learning'}):`, tags);
  }

  /**
   * Experiment: does 0x0157 ever go back to 0? Read it again 30 minutes after the start,
   * the first time the sensor is awake after that moment.
   */
  _probeLearningLater() {
    const due = this.getStoreValue('learnProbeAt');
    if (!due || Date.now() < due || this._learnProbeBusy) return;
    this._learnProbeBusy = true;
    this.lumi.readAttributes(['spatialLearning'])
      .then(v => {
        const minutes = Math.round((Date.now() - (due - 30 * 60 * 1000)) / 60000);
        this.log(`Spatial learning state ${minutes} min after the start: ${v.spatialLearning}`);
        return this.setStoreValue('learnProbeAt', null);
      })
      .catch(err => this.log('Learning probe failed, trying again next time', err.message))
      .finally(() => { this._learnProbeBusy = false; });
  }

  /**
   * What a message from the sensor is, in plain words (decoded from the user's logs):
   *   0xFCC0 0x0157  start of learning confirmed     0xFCC0 0x0142/0x014D  presence / PIR
   *   0xFCC0 0x00F7/0x00DF  status (battery, radio)   0x0402/0x0405/0x0400  temperature, humidity, light
   *   0x000A  time request                           0x01 / 0x04  answers to the app
   */
  _messageKind(clusterId, frame, header) {
    if (clusterId === 0x000a) return 'time';
    if ([0x0402, 0x0405, 0x0400].includes(clusterId)) return 'measurement';
    if (clusterId !== 0xfcc0) return 'other';
    if (header.cmdId === 0x04 || header.cmdId === 0x01) return 'answer';
    const attrs = parseAttributeRecords(frame, header);
    if (attrs[0x0157] !== undefined) return 'learning';
    if (attrs[0x0142] !== undefined || attrs[0x014d] !== undefined) return attrs[0x0142] === 1 || attrs[0x014d] === 1 ? 'movement' : 'empty';
    if (attrs[0x00f7] !== undefined || attrs[0x00df] !== undefined) return 'status';
    return 'other';
  }

  _learningNoteMessage(kind) {
    this._learningLast = { at: Date.now(), kind };
    this._learningMsgCount = (this._learningMsgCount || 0) + 1;
    // shortly after, so presence and state from this same message are taken into account
    if (!this._learningLivePending) {
      this._learningLivePending = true;
      this.homey.setTimeout(() => { this._learningLivePending = false; this._showLearningLive(); }, 300);
    }
  }

  /** The settings label while learning: time, start confirmation, empty room, last sign of life. */
  _showLearningLive() {
    if (!this._learningUntil) return;
    this._learningLiveAt = Date.now();
    const pct = this.learningPercent();
    const left = Math.max(1, Math.ceil((this._learningUntil - Date.now()) / 60000));
    const t = (k, tok) => this.homey.__(`learning.${k}`, tok);
    const confirmed = this._learningConfirmedAt ? t('live_confirmed', { time: this._time(this._learningConfirmedAt) }) : t('live_unconfirmed');
    const room = this._learningMovementAt && !this._learningEmptySince ? t('live_movement', { time: this._time(this._learningMovementAt) })
      : this._learningEmptySince ? t('live_empty', { time: this._time(this._learningEmptySince) }) : '';
    const last = this._learningLast
      ? t('live_last', { time: this._time(this._learningLast.at), kind: t(`kind_${this._learningLast.kind}`) }) : t('live_none');
    const details = [confirmed, room, last].filter(Boolean).join(' ');
    this._setLearningLabel('learning.label_live', { bar: this._learningBar(pct), left, details });
  }

  /** Learning is running, or waiting to be sent: keep the radar free for it. */
  _learningBusy() {
    return Boolean(this._learningUntil) || this._oneShots.has('spatial_learning');
  }

  _startLearningWindow(until = Date.now() + FP300_LEARNING_MS, start = Date.now()) {
    this._learningUntil = until;
    this._pending.delete('trackDistance'); // no distance measurement started during learning
    this._learningStart = start;
    this._learningSeenActive = false;
    this._learningState = undefined;
    this._learningConfirmedAt = null;
    this._learningEmptySince = null;
    this._learningMovementAt = null;
    this._learningLast = null;
    this._learningCount = 0;
    this._learningMinutesShown = 0;
    this._learningLastAt = start;
    this.setStoreValue('learningStart', start).catch(this.error);
    this.setStoreValue('learnProbeAt', start + 30 * 60 * 1000).catch(this.error);
    this.setStoreValue('learningCount', 0).catch(this.error);
    this._startProgress();
    this._learningMovement = false;
    this.setStoreValue('learningUntil', until).catch(this.error);
    if (this._learningTimer) this.homey.clearTimeout(this._learningTimer);
    this._learningTimer = this.homey.setTimeout(() => this._finishLearningWindow(), Math.max(0, until - Date.now()));
    notify(this, 'learning.started', { until: this._time(until) });
    this._setLearningLabel('learning.label_started_time', { bar: this._learningBar(0), time: this._time(start), until: this._time(until) });
    this._updateWaitingWarning();
  }

  _finishLearningWindow(bySensor = false) {
    if (!this._learningUntil) return;
    const movement = this._learningMovement;
    if (this._learningTimer) this.homey.clearTimeout(this._learningTimer);
    this._stopProgress();
    this._learningUntil = null;
    this._learningTimer = null;
    this.setStoreValue('learningUntil', null).catch(this.error);
    this._updateWaitingWarning();
    const done = bySensor ? 'learning.done_fp300_signal' : 'learning.done_fp300';
    notify(this, movement ? 'learning.done_with_movement' : done);
    this._setLearningLabel(movement ? 'learning.label_movement' : (bySensor ? 'learning.label_done_signal' : 'learning.label_done_time'), {
      bar: this._learningBar(100), time: this._time(Date.now()),
    });
    // keep the result visible for 10 minutes, then back to the neutral text
    if (this._learningIdleTimer) this.homey.clearTimeout(this._learningIdleTimer);
    this._learningIdleTimer = this.homey.setTimeout(() => { if (!this._learningUntil) this._setLearningIdle(); }, LEARNING_RESULT_MS);
    this.driver.learningDoneTrigger.trigger(this, { success: !movement }).catch(this.error);
  }

  /** After an app restart: continue a learning window that was still running. */
  _resumeLearningWindow() {
    const until = this.getStoreValue('learningUntil');
    if (!until) return;
    if (until > Date.now()) {
      this._learningUntil = until;
      this._learningStart = this.getStoreValue('learningStart') || (until - FP300_LEARNING_MS);
      this._learningCount = this.getStoreValue('learningCount') || 0;
      this._learningLastAt = Date.now();
      this._startProgress();
      this._learningTimer = this.homey.setTimeout(() => this._finishLearningWindow(), until - Date.now());
      this._updateWaitingWarning();
    } else {
      this.setStoreValue('learningUntil', null).catch(this.error);
    }
  }

  /* progress shown on the device while learning: the FP300 sends no progress, so it is time based */
  _startProgress() {
    if (this._progressTimer) this.homey.clearInterval(this._progressTimer);
    const update = () => {
      if (!this._learningUntil) return;
      const pct = this.learningPercent();
      if (pct !== this._learningPctShown) {
        this._learningPctShown = pct;
        this.setCapabilityValue('learning_progress', pct).catch(this.error);
      }
      // once a minute: show in the device settings how long ago the sensor's last message was,
      // so it is visible whether messages are still coming in (the count itself only changes per message)
      const minutes = Math.floor((Date.now() - this._learningStart) / 60000);
      if (minutes >= 1 && minutes !== this._learningMinutesShown) {
        this._learningMinutesShown = minutes;
        const left = Math.max(1, Math.ceil((this._learningUntil - Date.now()) / 60000));
        this._showLearningLive();
        this.log(`Learning: ${pct} %, ${left} min left, sensor state ${this._learningState === undefined ? 'not read yet' : this._learningState}`);
        // also try to read the state now and then; works when the sensor happens to be listening
        this._checkLearning(2 * 60 * 1000);
      }
    };
    const add = this.hasCapability('learning_progress') ? Promise.resolve() : this.addCapability('learning_progress');
    add.then(update).catch(err => this.error('Adding learning progress failed', err.message));
    this._progressTimer = this.homey.setInterval(update, 5 * 1000);
  }

  /**
   * Progress in %: each time request is one step of 1/6. Between two requests it creeps forward
   * with the typical gap (100 s), but never past 90 % of the next step, so it only really
   * moves on when the sensor sends its next message.
   */
  learningPercent() {
    if (!this._learningUntil) return 100;
    const span = this._learningUntil - this._learningStart;
    return Math.max(0, Math.min(99, Math.floor(((Date.now() - this._learningStart) / span) * 100)));
  }

  learningStatus() {
    if (!this._learningUntil) return null;
    return {
      percent: this.learningPercent(),
      count: this._learningCount || 0,
      expected: LEARN_EXPECTED_REQUESTS,
      since: this._learningStart,
      last: this._learningLastAt,
    };
  }

  /** Text progress bar for the device settings, e.g. "██████░░░░░░  50 %  (3 of 6)". */
  _learningBar(percent) {
    const width = 12;
    const filled = Math.round((percent / 100) * width);
    return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}  ${percent} %`;
  }

  /** Show the learning state in the device settings (a label, which only the app can change). */
  /** Neutral text when no learning runs (the result of the last run is not kept forever). */
  _setLearningIdle() {
    const text = this.homey.__('learning.label_idle');
    if (this.getSetting('learning_status') === text) return;
    this.setSettings({ learning_status: text }).catch(err => this.log('Learning status not shown', err.message));
  }

  _setLearningLabel(key, tokens = {}) {
    const text = this.homey.__(key, tokens);
    this.setSettings({ learning_status: text }).catch(err => this.log('Learning status not shown', err.message));
  }

  /** A learning message (time request) arrived: one step further; after the 6th, done. */
  _onLearningMessage() {
    this._learningMinutesShown = 0;
    this._learningCount = (this._learningCount || 0) + 1;
    this._learningLastAt = Date.now();
    this.setStoreValue('learningCount', this._learningCount).catch(this.error);
    this.log(`Learning progress: message ${this._learningCount} of ${LEARN_EXPECTED_REQUESTS}`);


  }

  _stopProgress() {
    if (this._progressTimer) this.homey.clearInterval(this._progressTimer);
    this._progressTimer = null;
    if (!this.hasCapability('learning_progress')) return;
    this.setCapabilityValue('learning_progress', 100)
      .then(() => new Promise(resolve => this.homey.setTimeout(resolve, 60 * 1000)))
      .then(() => (this._learningUntil ? null : this.removeCapability('learning_progress')))
      .catch(this.error);
  }

  /**
   * The FP300 reports attribute 0x0157 = 1 right after learning starts (seen in logs).
   * Whether it later reports or reads 0 when done is not known yet; if it does, finish early.
   * Only trusted when the sensor showed 1 first, so a write-only attribute cannot end learning early.
   */
  _onLearningState(value) {
    this.log('Spatial learning state from the sensor:', value);
    this._learningState = value;
    if (this._learningUntil && value === 1 && !this._learningConfirmedAt) this._learningConfirmedAt = Date.now();
    if (!this._learningUntil) return;
    if (value === 1) this._learningSeenActive = true;
    else if (value === 0 && this._learningSeenActive) this._finishLearningWindow(true);
  }

  /** While learning, ask the sensor for its learning state when it is awake (at most once a minute). */
  _checkLearning(every = 60 * 1000) {
    if (!this._learningUntil || Date.now() - (this._learningCheckAt || 0) < every) return;
    this._learningCheckAt = Date.now();
    // the answer is handled in _onFrame (read responses of 0xFCC0 pass through _handleLumiAttributes)
    this.lumi.readAttributes(['spatialLearning'])
      .catch(err => this.log('Reading learning state failed', err.message));
  }

  _movementWhileLearning() {
    if (!this._learningUntil || this._learningMovement) return;
    this._learningMovement = true;
    notify(this, 'learning.movement');
  }

  /* ------------------------------------------------------------ distance zones */

  getZones() {
    return this.getStoreValue('zones') || {};
  }

  async _migrateZoneIds() {
    const zones = { ...this.getZones() };
    let changed = false;
    for (const zone of Object.values(zones)) {
      if (!zone.uid) { zone.uid = newUid(); changed = true; }
    }
    if (changed) await this.setStoreValue('zones', zones);
  }

  slotOfZone(uid) {
    const entry = Object.entries(this.getZones()).find(([, zone]) => zone.uid === uid);
    return entry ? Number(entry[0]) : null;
  }

  async setZone(slot, value) {
    const id = Number(slot);
    if (!Number.isInteger(id) || id < 1 || id > 8) throw new Error('Zone slot must be 1 to 8');
    const zones = { ...this.getZones() };
    const zone = parseBlockZone(value);
    if (zone) {
      zone.uid = (zones[id] && zones[id].uid) || newUid();
      zones[id] = zone;
    } else {
      delete zones[id];
    }
    await this.setStoreValue('zones', zones);
    this._lastEmitted = '';
    this._publishZones(this.tracker.setZones(zones));
    this._syncZoneTimer();
    return zones;
  }

  async removeZoneByUid(uid) {
    const slot = this.slotOfZone(uid);
    if (slot !== null) await this.setZone(slot, null);
  }

  zoneStates() {
    return this.tracker.state(Date.now());
  }

  _publishZones(events) {
    if (!this.tracker) return;
    const states = this.zoneStates();
    const encoded = JSON.stringify(states);
    if (encoded === this._lastEmitted && !events.length) return;
    this._lastEmitted = encoded;
    this.homey.app.bus.emit(`zones:${this.token}`, { states, events });
  }

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

  /** The block editor is open: make sure the sensor measures distance (sent when it is awake). */
  markViewer() {
    if (this._learningBusy()) return;
    this._viewerUntil = Date.now() + 60 * 1000; // the live strip is open: measure distance meanwhile
    if (Date.now() - this._viewerTrackAt < VIEWER_TRACK_EVERY_MS) return;
    this._viewerTrackAt = Date.now();
    this._pending.set('trackDistance', 1);
    this._flush().catch(this.error);
  }

  getLiveState() {
    const distance = this.getCapabilityValue('target_distance');
    return {
      kind: this.kind,
      name: this.getName(),
      presence: this._mmwavePresence(),
      distance,
      block: this._zonePresence() ? blockOf(distance) : null,
      distanceAge: this._lastDistanceAt ? Math.round((Date.now() - this._lastDistanceAt) / 1000) : null,
      pir: this._pir,
      // waiting: start of the measurement is queued until the sensor wakes up; running: started in the last 30 min
      tracking: this._pending.has('trackDistance') ? 'waiting'
        : (Date.now() - this._lastTrackStart < 30 * 60 * 1000 ? 'running' : 'idle'),
      pirOnly: this.getSetting('detection_mode') === '2', // PIR only: the radar is off, so there is no distance
      zones: this.getZones(),
      zoneStates: this.zoneStates(),
      linked: this._linkedZoneDevices(),
      learning: this.learningStatus(),
      rangeBlocks: this.getRangeBlocks(),
    };
  }

  onDeleted() {
    if (this._learningIdleTimer) this.homey.clearTimeout(this._learningIdleTimer);
    if (this._progressTimer) this.homey.clearInterval(this._progressTimer);
    if (this._learningTimer) this.homey.clearTimeout(this._learningTimer);
    if (this._zoneTimer) this.homey.clearInterval(this._zoneTimer);
    super.onDeleted();
  }

  async onUninit() {
    if (this._learningIdleTimer) this.homey.clearTimeout(this._learningIdleTimer);
    if (this._progressTimer) this.homey.clearInterval(this._progressTimer);
    if (this._learningTimer) this.homey.clearTimeout(this._learningTimer);
    if (this._zoneTimer) this.homey.clearInterval(this._zoneTimer);
  }

}

module.exports = FP300Device;
