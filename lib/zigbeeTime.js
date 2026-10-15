'use strict';

/**
 * Answer a sensor that asks for the time (ZCL Time cluster 0x000A, "read attributes").
 *
 * The FP300 asks for Time (0x0000), TimeZone (0x0002) and DstShift (0x0005) about every 1.5 minutes.
 * Zigbee2MQTT answers this automatically (zigbee-herdsman, src/utils/timeService.ts); the values here
 * follow the same rules:
 *   Time      seconds since 1 January 2000 00:00 UTC (type UTCTime 0xE2)
 *   TimeZone  offset of standard time to UTC in seconds, without daylight saving (int32 0x2B)
 *   DstShift  daylight saving shift in seconds, e.g. 3600 (int32 0x2B)
 * Other attributes are answered with UNSUPPORTED_ATTRIBUTE.
 */

const EPOCH_2000 = Date.UTC(2000, 0, 1);

/** Offset of `timeZone` to UTC at `date`, in seconds. */
function offsetSeconds(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 1000);
}

function timeValues(timeZone, now = new Date()) {
  const year = now.getUTCFullYear();
  const jan = offsetSeconds(timeZone, new Date(Date.UTC(year, 0, 1)));
  const jul = offsetSeconds(timeZone, new Date(Date.UTC(year, 6, 1)));
  return {
    time: Math.round((now.getTime() - EPOCH_2000) / 1000),
    timeZone: Math.min(jan, jul), // standard time is the smaller offset (north and south)
    dstShift: Math.abs(jul - jan),
  };
}

/** Build the "read attributes response" for a read request frame. Returns null if it is not one. */
function buildTimeReadResponse(request, header, timeZone, now = new Date()) {
  if (header.clusterSpecific || header.manufacturerSpecific || header.directionToClient || header.cmdId !== 0x00) return null;
  const values = timeValues(timeZone, now);
  const records = [];
  for (let i = header.payloadOffset; i + 1 < request.length; i += 2) {
    const id = request.readUInt16LE(i);
    const rec = Buffer.alloc(id === 0x0000 || id === 0x0002 || id === 0x0005 ? 8 : 3);
    rec.writeUInt16LE(id, 0);
    if (id === 0x0000) { rec[2] = 0; rec[3] = 0xe2; rec.writeUInt32LE(values.time >>> 0, 4); }
    else if (id === 0x0002) { rec[2] = 0; rec[3] = 0x2b; rec.writeInt32LE(values.timeZone, 4); }
    else if (id === 0x0005) { rec[2] = 0; rec[3] = 0x2b; rec.writeInt32LE(values.dstShift, 4); }
    else rec[2] = 0x86; // UNSUPPORTED_ATTRIBUTE
    records.push(rec);
  }
  // global, server to client, disable default response; same sequence number; command 0x01
  return Buffer.concat([Buffer.from([0x18, header.tsn, 0x01]), ...records]);
}

module.exports = { timeValues, buildTimeReadResponse, offsetSeconds };
