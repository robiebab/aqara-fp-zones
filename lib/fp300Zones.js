'use strict';

/**
 * Distance zones for the FP300.
 *
 * The FP300 only reports the distance to the nearest person (attribute 0x015F), no position.
 * The distance is split into 24 blocks of 0.25 m (0 to 6 m), the same steps the sensor uses for
 * its own detection range. A zone is a set of blocks, so a zone is "between X and Y metres",
 * possibly with gaps. Because there is only one distance, at most one person is seen at a time.
 */

const BLOCK = 0.25;
const BLOCKS = 24;

function blockOf(distance) {
  if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0) return null;
  const b = Math.floor(distance / BLOCK + 1e-9);
  return b < BLOCKS ? b : null;
}

function parseBlockZone(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Zone must be an object');
  const list = Array.isArray(value.blocks) ? value.blocks : value.cells;
  if (!Array.isArray(list)) throw new Error('Zone needs blocks');
  const blocks = [...new Set(list.map(Number))].filter(n => Number.isInteger(n) && n >= 0 && n < BLOCKS).sort((a, b) => a - b);
  if (!blocks.length) throw new Error('Pick at least one block');
  const zone = {
    name: String(value.name || '').trim().slice(0, 32) || 'Zone',
    blocks,
    absence_timeout: value.absence_timeout === undefined ? 3 : Number(value.absence_timeout),
  };
  if (!Number.isInteger(zone.absence_timeout) || zone.absence_timeout < 0 || zone.absence_timeout > 300) {
    throw new Error('Absence timeout must be 0 to 300 seconds');
  }
  return zone;
}

class BlockTracker {

  constructor(zones = {}) {
    this.zones = zones;
    this.slots = {}; // slot -> { inside, occupied, outsideSince }
    this.presence = null;
    this.block = null;
  }

  setZones(zones) {
    for (const id of Object.keys({ ...this.zones, ...zones })) {
      if (JSON.stringify(this.zones[id]) !== JSON.stringify(zones[id])) delete this.slots[id];
    }
    this.zones = zones;
    return this.update(this.presence, this.block === null ? null : this.block * BLOCK + BLOCK / 2, Date.now());
  }

  /** New presence and/or distance. Returns enter/leave events. */
  update(presence, distance, now) {
    this.presence = presence;
    this.block = presence === false ? null : blockOf(distance);
    const events = [];
    for (const [id, zone] of Object.entries(this.zones)) {
      const slot = this.slots[id] || (this.slots[id] = { inside: false, occupied: false, outsideSince: null });
      const inside = this.block !== null && zone.blocks.includes(this.block);
      if (inside && !slot.inside) events.push({ slot: Number(id), type: 'enter' });
      if (!inside && slot.inside) events.push({ slot: Number(id), type: 'leave' });
      if (inside) {
        slot.occupied = true;
        slot.outsideSince = null;
      } else if (slot.inside) {
        slot.outsideSince = now;
      }
      if (presence === false) {
        slot.occupied = false;
        slot.outsideSince = null;
      }
      slot.inside = inside;
    }
    return events;
  }

  /**
   * The moment the next zone's own "empty after" time (absence_timeout) ends, or null when no zone is
   * counting down. The device sets one timer for exactly that moment instead of checking every second.
   */
  nextDeadline() {
    let next = null;
    for (const [id, zone] of Object.entries(this.zones)) {
      const slot = this.slots[id];
      if (!slot || slot.outsideSince === null) continue;
      const at = slot.outsideSince + zone.absence_timeout * 1000;
      if (next === null || at < next) next = at;
    }
    return next;
  }

  state(now) {
    const result = {};
    for (const [id, zone] of Object.entries(this.zones)) {
      const slot = this.slots[id] || { inside: false, occupied: false, outsideSince: null };
      if (slot.outsideSince !== null && now - slot.outsideSince >= zone.absence_timeout * 1000) {
        slot.occupied = false;
        slot.outsideSince = null;
      }
      result[id] = {
        available: this.presence !== null,
        occupied: Boolean(slot.occupied),
        count: slot.occupied ? 1 : 0,
      };
    }
    return result;
  }

}

module.exports = { BLOCK, BLOCKS, blockOf, parseBlockZone, BlockTracker };
