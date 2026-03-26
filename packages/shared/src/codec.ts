import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';

/**
 * Binary message codec using MessagePack.
 *
 * Replaces JSON.stringify/parse for WebSocket messages. MessagePack produces
 * smaller payloads (no repeated field name strings) and is faster to
 * encode/decode, reducing both bandwidth and CPU on the hot path (30 Hz
 * game state broadcasts).
 *
 * Both sides must agree on the format: WebSocket binary frames containing
 * MessagePack-encoded objects.
 */

/** Encode a message object to a binary buffer for sending over WebSocket. */
export function encodeMessage(msg: unknown): Uint8Array {
  return msgpackEncode(msg);
}

/** Decode a binary buffer received from WebSocket back into a message object. */
export function decodeMessage<T = unknown>(data: ArrayBuffer | Uint8Array | Buffer): T {
  // Ensure we have a Uint8Array view
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return msgpackDecode(bytes) as T;
}
