'use strict';

/**
 * Learns when a sleepy (battery) sensor tends to wake up, from the moments it sends something.
 * Messages close together count as one wake up. The typical gap between wake ups (median, with
 * the middle half as spread) gives an estimate of the next wake up.
 */

const SESSION_MS = 5000; // messages within 5 s belong to the same wake up
const KEEP = 40; // wake ups to remember
const MAX_GAP_MS = 6 * 60 * 60 * 1000; // ignore gaps longer than 6 h (Homey restarts, empty house)
const MIN_GAPS = 3;

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

class WakePattern {

  constructor(wakes = []) {
    this.wakes = Array.isArray(wakes) ? wakes.filter(n => Number.isFinite(n)).slice(-KEEP) : [];
    this.lastMessage = this.wakes.length ? this.wakes[this.wakes.length - 1] : null;
  }

  /** Call for every message from the sensor. Returns true when a new wake up was recorded. */
  note(now) {
    const previous = this.lastMessage;
    this.lastMessage = now;
    if (previous !== null && now - previous < SESSION_MS) return false;
    this.wakes.push(now);
    if (this.wakes.length > KEEP) this.wakes.shift();
    return true;
  }

  /** { median, low, high, last, next, samples } in ms, or null when there is too little data. */
  stats(now) {
    const gaps = [];
    for (let i = 1; i < this.wakes.length; i++) {
      const gap = this.wakes[i] - this.wakes[i - 1];
      if (gap > 0 && gap <= MAX_GAP_MS) gaps.push(gap);
    }
    if (gaps.length < MIN_GAPS) return null;
    gaps.sort((a, b) => a - b);
    const median = quantile(gaps, 0.5);
    const last = this.wakes[this.wakes.length - 1];
    let next = last + median;
    if (next < now) next = last + Math.ceil((now - last) / median) * median;
    return {
      median, low: quantile(gaps, 0.25), high: quantile(gaps, 0.75), last, next, samples: gaps.length,
    };
  }

}

module.exports = { WakePattern };
