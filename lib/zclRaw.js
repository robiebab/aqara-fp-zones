'use strict';

/**
 * Small helpers to work with raw ZCL frames.
 *
 * Why: zigbee-clusters throws on attribute types it does not know (for example
 * Aqara structs) and does not know the Aqara "event" command 0x8B. To stay robust
 * we look at the raw frame first and only hand frames we do not consume to the
 * normal zigbee-clusters handling.
 */

const AQARA_MANUFACTURER_ID = 0x115f;

/** Parse the ZCL header of a raw frame. */
function parseHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3) return null;
  const fc = buf[0];
  const manufacturerSpecific = (fc & 0x04) !== 0;
  let i = 1;
  let manufacturerId = null;
  if (manufacturerSpecific) {
    if (buf.length < 5) return null;
    manufacturerId = buf.readUInt16LE(1);
    i = 3;
  }
  return {
    fc,
    clusterSpecific: (fc & 0x03) === 1,
    manufacturerSpecific,
    directionToClient: (fc & 0x08) !== 0,
    disableDefaultResponse: (fc & 0x10) !== 0,
    manufacturerId,
    tsn: buf[i],
    cmdId: buf[i + 1],
    payloadOffset: i + 2,
  };
}

const FIXED_SIZES = {
  0x08: 1, 0x10: 1, 0x18: 1, 0x20: 1, 0x28: 1, 0x30: 1,
  0x09: 2, 0x19: 2, 0x21: 2, 0x29: 2, 0x31: 2,
  0x0a: 3, 0x1a: 3, 0x22: 3, 0x2a: 3,
  0x0b: 4, 0x1b: 4, 0x23: 4, 0x2b: 4, 0x39: 4,
  0x0c: 5, 0x24: 5, 0x2c: 5,
  0x0d: 6, 0x25: 6, 0x2d: 6,
  0x0e: 7, 0x26: 7, 0x2e: 7,
  0x0f: 8, 0x27: 8, 0x2f: 8, 0x3a: 8,
};
const SIGNED = new Set([0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f]);

/**
 * Read one value of ZCL type `type` at `offset`.
 * Returns { value, length } or null when the type is unknown or the buffer is too short.
 */
function readTyped(buf, offset, type) {
  if (type === 0x41 || type === 0x42) { // octet string / char string, 1 byte length
    if (offset >= buf.length) return null;
    const len = buf[offset];
    if (len === 0xff) return { value: Buffer.alloc(0), length: 1 };
    if (offset + 1 + len > buf.length) return null;
    const raw = buf.subarray(offset + 1, offset + 1 + len);
    return { value: type === 0x42 ? raw.toString('utf8') : Buffer.from(raw), length: 1 + len };
  }
  if (type === 0x43 || type === 0x44) { // long strings, 2 byte length
    if (offset + 2 > buf.length) return null;
    const len = buf.readUInt16LE(offset);
    if (offset + 2 + len > buf.length) return null;
    const raw = buf.subarray(offset + 2, offset + 2 + len);
    return { value: type === 0x44 ? raw.toString('utf8') : Buffer.from(raw), length: 2 + len };
  }
  const size = FIXED_SIZES[type];
  if (!size || offset + size > buf.length) return null;
  let value;
  if (type === 0x39) value = buf.readFloatLE(offset);
  else if (type === 0x3a) value = buf.readDoubleLE(offset);
  else if (size <= 6) value = SIGNED.has(type) ? buf.readIntLE(offset, size) : buf.readUIntLE(offset, size);
  else if (size === 7) value = buf.readUIntLE(offset, 6) + buf[offset + 6] * 2 ** 48;
  else value = Number(SIGNED.has(type) ? buf.readBigInt64LE(offset) : buf.readBigUInt64LE(offset));
  if (type === 0x10) value = value !== 0;
  return { value, length: size };
}

/**
 * Parse the payload of a "report attributes" (0x0A) or "read attributes response" (0x01)
 * frame into an object keyed by numeric attribute id. Stops at the first unknown type,
 * because the length of an unknown type cannot be determined.
 */
function parseAttributeRecords(buf, header) {
  const result = {};
  const withStatus = header.cmdId === 0x01;
  let i = header.payloadOffset;
  while (i + 3 <= buf.length) {
    const id = buf.readUInt16LE(i);
    i += 2;
    if (withStatus) {
      const status = buf[i];
      i += 1;
      if (status !== 0) continue;
    }
    const type = buf[i];
    i += 1;
    const read = readTyped(buf, i, type);
    if (!read) break;
    result[id] = read.value;
    i += read.length;
  }
  return result;
}

/**
 * Parse the Aqara/Lumi TLV struct (attribute 0x00F7): repeated [tag][zcl type][value].
 * Same layout as `buffer2DataObject` in zigbee-herdsman-converters (lib/lumi.ts).
 */
function parseLumiStruct(buf) {
  const result = {};
  if (!Buffer.isBuffer(buf)) return result;
  let i = 0;
  while (i + 2 <= buf.length) {
    const tag = buf[i];
    const type = buf[i + 1];
    const read = readTyped(buf, i + 2, type);
    if (!read) break;
    result[tag] = read.value;
    i += 2 + read.length;
  }
  return result;
}

/** Send a ZCL default response (success) when the sender asked for one. */
async function sendDefaultResponse(endpoint, clusterId, rawFrame) {
  if (rawFrame[0] & 0x10) return; // "disable default response" bit set
  const parsed = endpoint.constructor.parseFrame(rawFrame);
  if (parsed.cmdId === 0x0b) return; // never answer a default response
  const response = endpoint.makeDefaultResponseFrame(parsed, true);
  await endpoint.sendFrame(clusterId, response.toBuffer());
}

/**
 * Wrap Endpoint#handleFrame so `handler(clusterId, rawFrame, header)` sees every frame first.
 * When the handler returns true the frame is consumed: it is not passed on to
 * zigbee-clusters and we send the default response ourselves.
 */
function hookEndpoint(device, endpointId, handler) {
  const endpoint = device.zclNode && device.zclNode.endpoints[endpointId];
  if (!endpoint) {
    device.error(`Endpoint ${endpointId} is not available on this node`);
    return null;
  }
  if (endpoint.__fpHooked) return endpoint;
  const original = endpoint.handleFrame.bind(endpoint);
  endpoint.handleFrame = async (clusterId, frame, meta) => {
    let consumed = false;
    try {
      const header = parseHeader(frame);
      if (header) consumed = (await handler(clusterId, frame, header)) === true;
    } catch (err) {
      device.error('Frame handler error', err);
    }
    if (!consumed) return original(clusterId, frame, meta);
    return sendDefaultResponse(endpoint, clusterId, frame)
      .catch(err => device.error('Default response failed', err.message));
  };
  endpoint.__fpHooked = true;
  return endpoint;
}

/** Make sure a custom cluster instance exists on an endpoint (needed to receive its responses). */
function ensureCluster(endpoint, ClusterClass) {
  if (!endpoint) return null;
  if (!endpoint.clusters[ClusterClass.NAME]) {
    endpoint.clusters[ClusterClass.NAME] = new ClusterClass(endpoint);
  }
  return endpoint.clusters[ClusterClass.NAME];
}

module.exports = {
  AQARA_MANUFACTURER_ID,
  parseHeader,
  readTyped,
  parseAttributeRecords,
  parseLumiStruct,
  sendDefaultResponse,
  hookEndpoint,
  ensureCluster,
};
