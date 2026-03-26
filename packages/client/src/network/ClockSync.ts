/**
 * NTP-style clock synchronization between client and server.
 *
 * Estimates the offset between the client's Date.now() and the server's Date.now()
 * so the client can compute the current server time at any instant:
 *
 *   estimatedServerTime = Date.now() + offset
 *
 * Algorithm:
 *  - Client sends ping with clientSendTime = Date.now()
 *  - Server responds with pong containing serverTime = Date.now() (at server)
 *  - Client receives pong at clientReceiveTime = Date.now()
 *  - RTT = clientReceiveTime - clientSendTime
 *  - Assuming symmetric one-way delay: offset = serverTime - midpoint
 *    where midpoint = (clientSendTime + clientReceiveTime) / 2
 *
 * The sample with the lowest RTT in the recent window gives the most accurate
 * offset (least distorted by asymmetric routing / jitter), so we track it and
 * smooth toward it to avoid sudden jumps.
 */

interface SyncSample {
  offset: number;
  rtt: number;
}

export class ClockSync {
  private samples: SyncSample[] = [];
  private static readonly MAX_SAMPLES = 20;
  private static readonly SMOOTHING = 0.1;

  /** Smoothed clock offset in ms. Add to Date.now() to get estimated server time. */
  private _offset = 0;
  private _synced = false;
  private _rtt = 0;

  /**
   * Feed a pong response from the server.
   */
  processPong(clientSendTime: number, serverTime: number): void {
    const clientReceiveTime = Date.now();
    const rtt = clientReceiveTime - clientSendTime;
    if (rtt < 0 || rtt > 5000) return; // reject garbage

    const offset = serverTime - (clientSendTime + clientReceiveTime) / 2;

    this.samples.push({ offset, rtt });
    if (this.samples.length > ClockSync.MAX_SAMPLES) {
      this.samples.shift();
    }

    // Best estimate comes from the sample with the lowest RTT
    let bestOffset = offset;
    let bestRtt = rtt;
    for (const s of this.samples) {
      if (s.rtt < bestRtt) {
        bestRtt = s.rtt;
        bestOffset = s.offset;
      }
    }

    if (!this._synced) {
      this._offset = bestOffset;
      this._synced = true;
    } else {
      this._offset += (bestOffset - this._offset) * ClockSync.SMOOTHING;
    }

    this._rtt = rtt;
  }

  /** Estimated current server time (ms since epoch). */
  getServerTime(): number {
    return Date.now() + this._offset;
  }

  /** Clock offset in ms. Date.now() + offset ≈ server's Date.now(). */
  get offset(): number {
    return this._offset;
  }

  /** Whether at least one sync sample has been processed. */
  get synced(): boolean {
    return this._synced;
  }

  /** Latest round-trip time in ms. */
  get rtt(): number {
    return this._rtt;
  }
}
