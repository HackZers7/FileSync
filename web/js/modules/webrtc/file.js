import { dom } from '../dom.js';
import { turn } from './turn.js';

export class File {
  // File
  _id;
  _name;
  _size;
  _content;
  _owner_id;
  _owner_name;

  // Send
  _remotePeers = {};

  // Receive
  _peer;
  _chunks = [];
  _transferred = 0;
  _zip = false;
  _in_progress = false;
  _aborted = false;
  _removed = false;
  _peerReconnectAttempts = 0;
  _peerReconnectTimer = null;
  _writer = null;          // WritableStreamDefaultWriter from StreamSaver
  _writeQueue = Promise.resolve(); // serialize async writes to the writer
  _streamMode = false;     // true → stream to disk, false → buffer in memory

  // Speed / throughput tracking (receiver-side, exponential moving average).
  _speedStart = 0;         // performance.now() of the first chunk
  _speedLastTs = 0;        // timestamp of the last UI refresh
  _speedLastBytes = 0;     // _transferred at the last UI refresh
  _speedBps = 0;           // smoothed bytes/sec

  constructor(file) {
    this._id = file.id
    this._name = file.name
    this._size = file.size
    this._content = file.content
    this._owner_id = file.owner_id
    this._owner_name = file.owner_name
  }

  get file() {
    return {"id": this._id, "name": this._name, "size": this._size, "owner_id": this._owner_id, "owner_name": this._owner_name}
  }

  get id() {
    return this._id;
  }

  get name() {
    return this._name
  }

  get size() {
    return this._size
  }

  get owner_id() {
    return this._owner_id
  }

  get owner_name() {
    return this._owner_name
  }

  get peer() {
    return this._peer
  }

  get remotePeers() {
    return this._remotePeers
  }

  get details() {
    return Object.values(this._remotePeers).reduce((acc, p) => {
      acc[p.user_id] = {
        user_name: p.user_name,
        progress: p.progress,
        aborted: p.aborted,
      };
      return acc;
    }, {});
  }

  get in_progress() {
    return this._in_progress
  }

  set in_progress(value) {
    this._in_progress = value
  }

  get aborted() {
    return this._aborted
  }

  get removed() {
    return this._removed
  }

  set removed(value) {
    return this._removed = value
  }

  get transferred() {
    return this._transferred
  }

  get chunks() {
    return this._chunks
  }

  set chunks(value) {
    this._chunks = value
  }

  set owner_name(value) {
    this._owner_name = value
  }

  set zip(value) {
    this._zip = value
  }

  get writer() {
    return this._writer
  }

  // Provide a WritableStreamDefaultWriter (StreamSaver) from the UI layer so
  // chunks are streamed to disk instead of accumulated in memory. Must be set
  // BEFORE calling init()/download — the user gesture window is needed.
  set writer(value) {
    this._writer = value
  }

  set streamMode(value) {
    this._streamMode = value
  }

  async init(peer_id) {
    // Get ICE servers
    let iceServers;
    try {
      iceServers = await turn.getServers();
    } catch (err) {
      console.log(err)
      dom.transfer_div.style.display = 'none'
      dom.connect_div.style.display = 'none'
      dom.error_div.style.display = 'block'
      dom.error_message.innerHTML = 'An error occurred getting the ICE servers. Please try again later.'
      return
    }

    await new Promise(async (resolve) => {
      // Get UUID
      const uuid = await this._getUUID();

      // Create a new Peer instance
      const isSecure = window.location.protocol === 'https:';
      const peer = new Peer(uuid, {
        host: window.location.hostname,
        port: parseInt(window.location.port) || (isSecure ? 443 : 80),
        path: "/peerjs",
        secure: isSecure,
        config: {
          iceServers: iceServers,
          // iceTransportPolicy: "relay",  // Force TURN
        }
      });

      // Emitted when a connection to the PeerServer is established.
      peer.on('open', (id) => {
        this._peerReconnectAttempts = 0;
        if (this._peerReconnectTimer) {
          clearTimeout(this._peerReconnectTimer);
          this._peerReconnectTimer = null;
        }
        this._handleOpen(id, resolve);
      });

      // Emitted when a new data connection is established from a remote peer.
      peer.on('connection', (conn) => conn.on('open', () => this._handleConnection(conn)));

      // Emitted when the peer is disconnected from the signaling server.
      peer.on('disconnected', () => this._handlePeerDisconnected(peer));

      // Errors on the peer are almost always fatal and will destroy the peer.
      peer.on('error', (err) => this._handleError(err));

      // Store peer (Receiver)
      if (peer_id === undefined) this._peer = peer
      // Store peer (Sender)
      else this._remotePeers[peer_id].peer = peer
    })
  }

  async connect(peer_id) {
    // Init new peer
    await this.init(peer_id)

    // Establish a connection with the target peer.
    //
    // CRITICAL: pass { reliable: true } so PeerJS opens the underlying
    // RTCDataChannel with { ordered: true } (and without maxRetransmits=0).
    // PeerJS defaults to reliable=false, which gives an UNORDERED, UNRELIABLE
    // SCTP channel — chunks of different conn.send() messages can arrive
    // out of order or be silently dropped. For small files this rarely
    // shows; for big files it surfaces as "size matches, content corrupted"
    // (the receiver still counts every chunk, but bytes land in the wrong
    // place on disk → 7z/zip integrity errors).
    await new Promise((resolve) => {
      const conn = this._remotePeers[peer_id].peer.connect(peer_id, { reliable: true });

      // Emitted when the connection is established and ready-to-use.
      conn.on('open', () => this._handleConnection(conn, resolve));
    })
  }

  async transfer(data) {
    // Update UI
    document.getElementById(`file-${this._id}-error`).style.display = 'none'
    document.getElementById(`file-${this._id}-icon-success`).style.display = 'none'
    document.getElementById(`file-${this._id}-icon-loading`).style.display = 'block'
    // Initialise the live progress structure for the sender row. The text
    // values are filled in by _updateSenderProgressUI on every ack.
    document.getElementById(`file-${this._id}-progress`).innerHTML =
      '<span class="file-progress-pct">0%</span>' +
      ' • <span class="file-progress-speed">— MB/s</span>' +
      ' • <span class="file-progress-bytes">0 B / ' + File._formatBytes(this._size) + '</span> | '
    // Reset speed accounting for this transfer.
    this._speedStart = 0
    this._speedLastTs = 0
    this._speedLastBytes = 0
    this._speedBps = 0

    // Store peer data
    this._remotePeers[data.peer_id] = {"user_id": data.requester_id, "user_name": data.requester_name, "peer": null, "conn": null, "online": true, "interval": null, "progress": 0, "aborted": false}

    // Connect to peer_id
    await this.connect(data.peer_id)

    // Get connection
    const conn = this._remotePeers[data.peer_id].conn

    // Init interval to check connection status
    this._remotePeers[data.peer_id].interval = setInterval(() => this._isAlive(conn.peer), 500)

    // Define vars for chunk processing.
    // 256 KB is a sweet spot for RTCDataChannel: large enough to keep throughput
    // high, small enough to stay well under SCTP message-size limits.
    const chunkSize = 256 * 1024
    // High-water mark for the underlying RTCDataChannel buffer.
    // When bufferedAmount exceeds this we pause until it drains.
    const HIGH_WATER = 8 * 1024 * 1024  // 8 MB
    const LOW_WATER  = 1 * 1024 * 1024  // 1 MB

    // Acquire the native RTCDataChannel (PeerJS exposes it as conn.dataChannel
    // once the channel is open). We use it directly for backpressure signals.
    const getDC = () => conn.dataChannel || (conn._dc) || null

    const waitForDrain = () => new Promise((resolve) => {
      const dc = getDC()
      if (!dc || dc.bufferedAmount < LOW_WATER) return resolve()
      dc.bufferedAmountLowThreshold = LOW_WATER
      const onLow = () => {
        dc.removeEventListener('bufferedamountlow', onLow)
        resolve()
      }
      dc.addEventListener('bufferedamountlow', onLow)
    })

    let offset = 0
    let position = 0

    while (offset < this._size) {
      // Abort if peer disappeared or user cancelled
      if (!(data.peer_id in this._remotePeers)) return
      if (this._remotePeers[data.peer_id].aborted) return

      // Verify the connection is still alive
      if (conn.peerConnection == null || conn.peerConnection.iceConnectionState == 'disconnected') return

      // Backpressure: wait until the DataChannel buffer drains.
      const dc = getDC()
      if (dc && dc.bufferedAmount > HIGH_WATER) {
        await waitForDrain()
        // Re-check abort flags after waiting
        if (!(data.peer_id in this._remotePeers)) return
        if (this._remotePeers[data.peer_id].aborted) return
      }

      // Slice the next chunk and read it as ArrayBuffer to avoid sending Blobs
      // (Blob transport over DataChannel varies across browsers; ArrayBuffer
      // is universally supported and avoids hidden async reads on the peer).
      const blobChunk = this._content.slice(offset, offset + chunkSize)
      const buf = await blobChunk.arrayBuffer()

      conn.send({
        "webrtc-file-transfer": {
          "file": buf,
          "transferred": buf.byteLength,
          "position": position,
        }
      })

      offset += chunkSize
      position += 1
    }
  }

  abort() {
    this._aborted = true
  }

  remove() {
    this._aborted = true
    this._removed = true
  }

  // Emitted when a connection to the PeerServer is established. 
  _handleOpen(id, resolve) {
    resolve()
  }

  // Handles disconnection from the PeerJS signaling server for file transfer peers.
  _handlePeerDisconnected(peer) {
    // Guard: skip if a reconnect timer is already pending
    if (this._peerReconnectTimer) return;

    const maxAttempts = 3;
    if (this._peerReconnectAttempts >= maxAttempts) {
      console.error(`File peer: failed to reconnect after ${maxAttempts} attempts.`);
      return;
    }

    const delay = 1000 * Math.pow(2, this._peerReconnectAttempts);
    this._peerReconnectAttempts++;
    console.warn(`File peer disconnected. Reconnecting in ${delay}ms (attempt ${this._peerReconnectAttempts}/${maxAttempts})...`);

    this._peerReconnectTimer = setTimeout(() => {
      this._peerReconnectTimer = null;
      if (!peer.destroyed) peer.reconnect();
    }, delay);
  }

  // Emitted when the connection is established and ready-to-use. 
  _handleConnection(conn, resolve) {
    // console.log('Received file connection from', conn.peer)

    // Emitted when data is received from the remote peer. 
    conn.on('data', (data) => this._handleData(conn, data));

    // Emitted when either you or the remote peer closes the data connection.
    conn.on('close', () => this._handleClose(conn));

    // Emitted when there is an unexpected error in the data connection.
    conn.on('error', (err) => this._handleError(err));

    // Sender
    if (resolve !== undefined) {
      this._remotePeers[conn.peer].conn = conn
      resolve()
    }
    // Receiver
    else {
      this._chunks = []
      this._transferred = 0
      this._aborted = false
    }
  }

  // Check if file connection is alive.
  async _isAlive(peer_id) {
    if (this._remotePeers[peer_id].conn.peerConnection === null || this._remotePeers[peer_id].conn.peerConnection.iceConnectionState == 'disconnected') {
      clearInterval(this._remotePeers[peer_id].interval);
      if (this._remotePeers[peer_id].progress != 100) {
        this._remotePeers[peer_id].aborted = true
      }
      this._onFileProgress()
      this._remotePeers[peer_id].online = false
    }
  }

  // Emitted when data is received from the remote peer.
  async _handleData(conn, data) {
    if ("webrtc-file-transfer" in data) {
      this._onFileTransfer(conn, data['webrtc-file-transfer'])
    }
    else if ("webrtc-file-progress" in data) {
      this._onFileProgress(conn, data['webrtc-file-progress'])
    }
    else if ("webrtc-file-abort" in data) {
      this._onFileAborted(conn)
    }
  }

  async _onFileTransfer(conn, data) {
    // If it's aborted, do nothing.
    if (this._aborted) {
      conn.send({"webrtc-file-abort": true})
      conn.close()
      this._peer.destroy()
      this._in_progress = false
      // Best-effort close of the writer
      if (this._writer) {
        try { await this._writer.abort?.() } catch (e) {}
        this._writer = null
      }
      return
    }

    // The payload is either an ArrayBuffer (new senders) or a Blob (older
    // senders). For the streaming path we need a Uint8Array (StreamSaver
    // requires it); for the in-memory path we keep the original payload as-is
    // so the final Blob constructor can take it directly.
    const payload = data.file
    let bytes
    let byteLength
    if (this._writer) {
      if (payload instanceof ArrayBuffer) {
        bytes = new Uint8Array(payload)
      }
      else if (payload instanceof Uint8Array) {
        bytes = payload
      }
      else if (payload && typeof payload.arrayBuffer === 'function') {
        bytes = new Uint8Array(await payload.arrayBuffer())
      }
      else {
        bytes = new Uint8Array(0)
      }
      byteLength = bytes.byteLength
    }
    else {
      if (payload instanceof ArrayBuffer) byteLength = payload.byteLength
      else if (payload && typeof payload.size === 'number') byteLength = payload.size
      else byteLength = data.transferred ?? 0
    }

    // Stream to disk if a writer was attached; otherwise keep the legacy
    // in-memory path (used for ZIP mode and small files without writer).
    if (this._writer) {
      // RTCDataChannels are ordered by default, so awaiting writes in arrival
      // order preserves file integrity. We serialize through _writeQueue so
      // that even if multiple _handleData calls overlap, writes stay ordered.
      //
      // Backpressure (CRITICAL for Firefox/StreamSaver):
      //   WritableStreamDefaultWriter.write() only awaits *entry* into the
      //   internal queue. The real signal is `writer.ready`, which stays
      //   pending while the queue is full. Without awaiting `ready` the
      //   page-side queue grows unbounded, the Service Worker's MessagePort
      //   buffer overflows, and Firefox silently terminates the download
      //   around ~1 GB.
      this._writeQueue = this._writeQueue
        .then(async () => {
          if (this._writer.ready) await this._writer.ready
          return this._writer.write(bytes)
        })
        .catch((err) => {
          console.error('Stream write failed:', err)
          this._aborted = true
        })
      // Block this _onFileTransfer call until the chunk is fully accepted.
      // This propagates backpressure all the way back to the sender via the
      // DataChannel's bufferedAmount.
      await this._writeQueue
    }
    else {
      // Legacy/zip path: accumulate in memory
      this._chunks[data.position] = payload
    }
    this._transferred += byteLength

    // Compute progress
    this._progress = Math.floor(this._transferred / this._size * 100)

    // Update Progress UI (skipped in zip mode — handled by _downloadAllProgress)
    if (!this._zip) {
      this._updateProgressUI()
    }

    // Notify progress
    conn.send({"webrtc-file-progress": {"progress": this._progress}})

    // If it's the last chunk
    if (this._transferred == this._size) {
      if (!this._zip) {
        // Update UI
        document.getElementById(`file-${this._id}-download`).style.display = 'block'
        document.getElementById(`file-${this._id}-abort`).style.display = 'none'
        document.getElementById(`file-${this._id}-icon-loading`).style.display = 'none'
        document.getElementById(`file-${this._id}-icon-success`).style.display = 'block'
        // Clear the live progress strings; the file's row now shows the
        // standard "<size> | Sent by …" line (handled by _info span above).
        const progressEl = document.getElementById(`file-${this._id}-progress`)
        if (progressEl) progressEl.innerHTML = ''

        if (this._writer) {
          // Flush and close the on-disk stream.
          try {
            await this._writeQueue
            await this._writer.close()
          } catch (err) {
            console.error('Failed to close writer:', err)
          }
          this._writer = null
        }
        else {
          // Fallback: build a Blob from in-memory chunks and trigger download.
          const blob = new Blob(this._chunks);
          const downloadLink = document.createElement('a')
          downloadLink.href = URL.createObjectURL(blob)
          downloadLink.download = this._name
          downloadLink.click()
        }

        // Clean data
        this._chunks = []
        this._transferred = 0
      }

      // Update internal parameters
      this._in_progress = false

      // Close connection
      conn.close()

      // Destroy current peer to free up resources
      this._peer.destroy()
    }
  }

  // Updates the receiver-side progress line. Two layouts:
  //   stream mode   → "Downloading… • <speed> • <bytes received> | "
  //   in-memory     → "<pct>% • <speed> • <bytes>/<total> | "
  // The structural HTML is created once by user.js#downloadFile so we just
  // poke text into the existing <span>s — that keeps the CSS animation on
  // the "Downloading…" label running smoothly.
  _updateProgressUI() {
    // Throttle DOM writes to ~5 Hz so we don't drown the main thread when
    // chunks land at >100/s. Also makes the speed reading more readable.
    const now = performance.now()
    if (this._speedStart === 0) {
      this._speedStart = now
      this._speedLastTs = now
      this._speedLastBytes = 0
    }
    if (now - this._speedLastTs < 200 && this._transferred !== this._size) return

    // EMA over the recent window: gives a stable speed readout but still
    // reacts within a couple of seconds to network changes.
    const dt = (now - this._speedLastTs) / 1000
    if (dt > 0) {
      const instant = (this._transferred - this._speedLastBytes) / dt
      const alpha = 0.3
      this._speedBps = this._speedBps === 0 ? instant : (alpha * instant + (1 - alpha) * this._speedBps)
    }
    this._speedLastTs = now
    this._speedLastBytes = this._transferred

    const root = document.getElementById(`file-${this._id}-progress`)
    if (!root) return

    const speedEl = root.querySelector('.file-progress-speed')
    const bytesEl = root.querySelector('.file-progress-bytes')
    const pctEl   = root.querySelector('.file-progress-pct')

    if (speedEl) speedEl.textContent = File._formatSpeed(this._speedBps)
    if (bytesEl) {
      bytesEl.textContent = this._streamMode
        ? File._formatBytes(this._transferred)
        : `${File._formatBytes(this._transferred)} / ${File._formatBytes(this._size)}`
    }
    if (pctEl) pctEl.textContent = `${this._progress}%`
  }

  static _formatBytes(bytes) {
    if (!bytes || bytes < 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`
  }

  static _formatSpeed(bps) {
    if (!bps || bps < 0) return '— MB/s'
    if (bps < 1024) return `${bps.toFixed(0)} B/s`
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
    if (bps < 1024 * 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
    return `${(bps / (1024 * 1024 * 1024)).toFixed(2)} GB/s`
  }

  _onFileProgress(conn, data) {
    // Track data transfer progress
    if (data) {
      this._remotePeers[conn.peer].progress = data.progress
    }

    // Calculate overall progress
    const onlinePeers = Object.values(this._remotePeers).filter(x => x.online)
    const totalProgress = onlinePeers.reduce((sum, x) => sum + x.progress, 0)
    const overall_progress = onlinePeers.length == 0 ? 0 : Math.floor(totalProgress / onlinePeers.length)

    // Update UI: show overall progress, throughput and bytes for the sender row.
    // The element is initialised with the same span structure as on the
    // receiver, so we just patch text inside the spans.
    this._updateSenderProgressUI(overall_progress)

    if (overall_progress == 100) {
      document.getElementById(`file-${this._id}-abort`).style.display = 'none'
      document.getElementById(`file-${this._id}-icon-loading`).style.display = 'none'
      document.getElementById(`file-${this._id}-icon-success`).style.display = 'block'
      const progressEl = document.getElementById(`file-${this._id}-progress`)
      if (progressEl) progressEl.innerHTML = ''
    }
    else if (!this._aborted && onlinePeers.filter(x => !x.aborted).length == 0) {
      document.getElementById(`file-${this._id}-icon-loading`).style.display = 'none'
      document.getElementById(`file-${this._id}-error`).style.display = 'block'
      document.getElementById(`file-${this._id}-error`).innerHTML = 'All users stopped the file transfer.'
    }
  }

  // Sender-side progress refresh. We don't have raw byte counts here (the
  // receivers only ack a percentage), so bytes are derived from progress*size.
  // Speed is a smoothed first-derivative of those derived bytes over time.
  _updateSenderProgressUI(overallPct) {
    const root = document.getElementById(`file-${this._id}-progress`)
    if (!root) return

    const now = performance.now()
    const bytes = Math.floor((overallPct / 100) * this._size)

    if (this._speedStart === 0) {
      this._speedStart = now
      this._speedLastTs = now
      this._speedLastBytes = bytes
    }

    // Throttle DOM writes / speed sampling to ~5 Hz.
    if (now - this._speedLastTs >= 200 || overallPct === 100) {
      const dt = (now - this._speedLastTs) / 1000
      if (dt > 0) {
        const instant = (bytes - this._speedLastBytes) / dt
        const alpha = 0.3
        this._speedBps = this._speedBps === 0 ? instant : (alpha * instant + (1 - alpha) * this._speedBps)
      }
      this._speedLastTs = now
      this._speedLastBytes = bytes
    }

    // Lazy-init the structure if downloadFile() never ran on this row (i.e.
    // we are the sender — the row was created by _addFileUI without spans).
    if (!root.querySelector('.file-progress-pct')) {
      root.innerHTML =
        '<span class="file-progress-pct">0%</span>' +
        ' • <span class="file-progress-speed">— MB/s</span>' +
        ' • <span class="file-progress-bytes">0 B / ' + File._formatBytes(this._size) + '</span> | '
    }

    const pctEl   = root.querySelector('.file-progress-pct')
    const speedEl = root.querySelector('.file-progress-speed')
    const bytesEl = root.querySelector('.file-progress-bytes')
    if (pctEl)   pctEl.textContent = `${overallPct}%`
    if (speedEl) speedEl.textContent = File._formatSpeed(this._speedBps)
    if (bytesEl) bytesEl.textContent = `${File._formatBytes(bytes)} / ${File._formatBytes(this._size)}`
  }

  _onFileAborted(conn) {
    this._remotePeers[conn.peer].aborted = true
    this._onFileProgress()
  }

  // Emitted when either you or the remote peer closes the data connection.
  _handleClose(conn) {
    // Sender
    if (conn.peer in this._remotePeers) {
      this._remotePeers[conn.peer].peer.destroy()
    }
  }

  // Emitted when there is an unexpected error in the data connection.
  _handleError(err) {
    // Recoverable signaling errors — handled by 'disconnected' event
    if (['disconnected', 'network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      console.warn(`File peer recoverable error (${err.type}).`);
      return;
    }
    console.error('File peer error:', err);
  }

  async _getUUID() {
    const response = await fetch(`/api/uuid`);
    const data = await response.json();
    return data['uuid'];
  }
}