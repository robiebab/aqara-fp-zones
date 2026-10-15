'use strict';

/**
 * The FP400's own area masks (written into the sensor, like the Aqara app does).
 *
 * Source: github.com/bobtekkk/aqara-fp400-zone-card (z2m/aqara-fp400.mjs, MIT):
 * - config cluster 0xFC0A, attribute 19 = interference area (sensor ignores movement there),
 *   attribute 20 = monitoring region where a set bit means "outside the room".
 * - 40 bytes, 320 bits, bit = row * 16 + column, most significant bit first in each byte.
 * - Native columns run right to left: column 0 is x = 350..400 cm.
 *
 * This app numbers cells left to right (cell = row * 16 + col, col 0 is x = -400..-350 cm),
 * so the column is mirrored when converting.
 */

const COLS = 16;
const ROWS = 20;
const BYTES = 40;

const AREAS = {
  ignore: { attribute: 'interferenceRegion' },
  outside: { attribute: 'monitoringRegion' },
};

function toNativeBit(cell) {
  const row = Math.floor(cell / COLS);
  const col = cell % COLS;
  return row * COLS + (COLS - 1 - col);
}

function cellsToMask(cells) {
  const mask = Buffer.alloc(BYTES);
  for (const cell of cells) {
    const bit = toNativeBit(cell);
    mask[bit >> 3] |= (0x80 >> (bit % 8));
  }
  return mask;
}

function maskToCells(mask) {
  if (!Buffer.isBuffer(mask) || mask.length === 0) return [];
  if (mask.length !== BYTES) throw new Error(`Unexpected area mask length ${mask.length}`);
  const cells = [];
  for (let cell = 0; cell < COLS * ROWS; cell++) {
    const bit = toNativeBit(cell);
    if (mask[bit >> 3] & (0x80 >> (bit % 8))) cells.push(cell);
  }
  return cells;
}

function parseCells(value) {
  if (!Array.isArray(value)) throw new Error('cells must be a list');
  return [...new Set(value.map(Number))]
    .filter(n => Number.isInteger(n) && n >= 0 && n < COLS * ROWS)
    .sort((a, b) => a - b);
}

module.exports = {
  AREAS, cellsToMask, maskToCells, parseCells, toNativeBit,
};
