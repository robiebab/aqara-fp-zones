'use strict';

/*
 * Logbook for the "Logging" tab in the app settings: the same lines `homey app run` shows, but
 * inside Homey. Switched on and off with the app setting "logging" (off by default).
 *
 *   - withLogBook(Base) wraps a Homey class (App, Driver, Device): every this.log / this.error still
 *     goes to the normal Homey log, and while logging is on it is also kept here.
 *   - The last MAX_LINES lines are kept in memory only (nothing on disk); older lines drop off.
 *   - Every new line is pushed to the settings page as a realtime event ('log'), so the page shows it
 *     the moment it happens instead of asking again and again.
 */

const MAX_LINES = 500;

const book = {
  enabled: false,
  lines: [],
  homey: null,
};

function sourceOf(instance) {
  try {
    if (typeof instance.getName === 'function') return instance.getName();            // a device
    if (instance.manifest && instance.manifest.id && typeof instance.getDevices === 'function') {
      return `Driver ${instance.manifest.id}`;                                           // a driver
    }
  } catch (err) {
    // a device that is being deleted has no name any more
  }
  return 'App';
}

function textOf(args) {
  return args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (a && typeof a === 'object') {
      try { return JSON.stringify(a); } catch (err) { return String(a); }
    }
    return String(a);
  }).join(' ');
}

function capture(instance, level, args) {
  if (!book.enabled) return;
  const line = { t: new Date().toISOString(), src: sourceOf(instance), level, text: textOf(args) };
  book.lines.push(line);
  if (book.lines.length > MAX_LINES) book.lines.splice(0, book.lines.length - MAX_LINES);
  const homey = book.homey || instance.homey;
  if (!homey || !homey.api) return;
  const sent = homey.api.realtime('log', line);
  if (sent && typeof sent.catch === 'function') sent.catch(() => {}); // no settings page open: fine
}

function withLogBook(Base) {
  return class extends Base {

    log(...args) {
      super.log(...args);
      capture(this, 'log', args);
    }

    error(...args) {
      super.error(...args);
      capture(this, 'error', args);
    }

  };
}

module.exports = {
  withLogBook,
  /** Called by the app: start with the stored setting and follow its changes. */
  attach(homey) {
    book.homey = homey;
    book.enabled = homey.settings.get('logging') === true;
    homey.settings.on('set', key => {
      if (key === 'logging') book.enabled = homey.settings.get('logging') === true;
    });
  },
  lines: () => book.lines.slice(),
  clear: () => { book.lines = []; },
  MAX_LINES,
};
