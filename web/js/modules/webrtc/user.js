import { dom } from '../dom.js';
import { turn } from './turn.js';
import { File } from './file.js';

export class User {
  _name = this._generate_name();
  _peer = null;
  _remotePeers = {};
  _room_id;
  _isHost = null;
  _files = {};
  _status;
  _downloadAll;
  _reconnectAttempts = 0;
  _reconnectTimer = null;

  constructor(room_id) {
    this._room_id = room_id;
  }

  get id() {
    return this._peer.id
  }

  get name() {
    return this._name
  }

  get isHost() {
    return this._isHost
  }

  get files() {
    return this._files
  }

  async init() {
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

    // Try to register as the host of the shared room.
    // If the fixed ID is already taken, fall back to peer mode.
    const hostSuccess = await this._registerPeer(this._room_id, iceServers);
    if (hostSuccess) {
      this._isHost = true;
      return;
    }

    // Peer mode: register with a fresh UUID, then connect to the host.
    this._isHost = false;
    const peerId = await this._getUUID();
    const peerSuccess = await this._registerPeer(peerId, iceServers);
    if (!peerSuccess) {
      this._showFatalError('Could not register with the signaling server. Please refresh the page.');
      return;
    }

    await this.connect(this._room_id);
  }

  // Attempts to open a Peer connection with the given ID.
  // Resolves to `true` on success, `false` if the ID is already taken
  // (so the caller can fall back to peer mode).
  _registerPeer(peerId, iceServers) {
    return new Promise((resolve) => {
      const isSecure = window.location.protocol === 'https:';
      this._peer = new Peer(peerId, {
        host: window.location.hostname,
        port: parseInt(window.location.port) || (isSecure ? 443 : 80),
        path: "/peerjs",
        secure: isSecure,
        config: {
          iceServers: iceServers,
          // iceTransportPolicy: "relay",  // Force TURN
        }
      });

      let settled = false;

      this._peer.on('open', () => {
        if (settled) return;
        settled = true;
        this._reconnectAttempts = 0;
        if (this._reconnectTimer) {
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = null;
        }
        // Wire long-lived handlers for the lifetime of this peer.
        this._peer.on('connection', (conn) => conn.on('open', () => this._handleConnection(conn)));
        this._peer.on('disconnected', () => this._handleDisconnected());
        resolve(true);
      });

      // Error handler used during registration. After we settle, errors are
      // routed to the normal handler via the second listener below.
      this._peer.on('error', (err) => {
        if (settled) {
          this._handleError(err);
          return;
        }
        if (err.type === 'unavailable-id') {
          // The fixed room ID is already taken: someone else is the host.
          settled = true;
          try { this._peer.destroy(); } catch (e) {}
          resolve(false);
        } else {
          settled = true;
          this._handleError(err);
          resolve(false);
        }
      });
    });
  }

  async connect(peer_id) {
    await new Promise((resolve) => {
      // Establish a connection with the host.
      const conn = this._peer.connect(peer_id);

      // Emitted when the peer connection has established connection to the host.
      conn.on('open', () => this._handleConnection(conn, resolve));
    })
  }

  _isAlive(peer_id) {
    if (this._remotePeers[peer_id] === undefined || this._remotePeers[peer_id].conn.peerConnection === null || this._remotePeers[peer_id].conn.peerConnection.iceConnectionState == 'disconnected') {
      clearInterval(this._remotePeers[peer_id].interval);
      this._handleClose(this._remotePeers[peer_id].conn);
    }
  }

  // Emitted when a connection to the PeerServer is established.
  _handleOpen(resolve) {
    resolve()
  }

  // Handles disconnection from the PeerJS signaling server.
  _handleDisconnected() {
    if (this._peer.destroyed) return;
    console.warn('Lost connection to PeerJS server. Attempting to reconnect...');
    this._scheduleReconnect();
  }

  // Schedules a reconnection attempt with exponential backoff.
  _scheduleReconnect() {
    // Guard: skip if a reconnect timer is already pending
    if (this._reconnectTimer) return;

    // Cannot reconnect a destroyed peer
    if (this._peer.destroyed) {
      this._showFatalError('Lost connection to server. Please refresh the page.');
      return;
    }

    const maxAttempts = 5;
    if (this._reconnectAttempts >= maxAttempts) {
      console.error(`Failed to reconnect after ${maxAttempts} attempts.`);
      this._showFatalError('Lost connection to server. Please refresh the page.');
      return;
    }

    const delay = 1000 * Math.pow(2, this._reconnectAttempts);
    this._reconnectAttempts++;
    console.log(`Reconnect attempt ${this._reconnectAttempts}/${maxAttempts} in ${delay}ms...`);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._peer.destroyed) {
        this._showFatalError('Lost connection to server. Please refresh the page.');
        return;
      }
      this._peer.reconnect();
    }, delay);
  }

  // Shows the fatal error page.
  _showFatalError(message) {
    dom.transfer_div.style.display = 'none';
    dom.connect_div.style.display = 'none';
    dom.error_div.style.display = 'block';
    dom.error_message.innerHTML = message;
  }

  // Change user's name
  changeName(value) {
    // Check if name is empty
    if (!value || value.length === 0) {
      if (window.showToast) window.showToast('Name cannot be empty.', 'warning')
      dom.name_modal_value.focus()
      return
    }

    // Check if there is another user with the same name
    const duplicated = Object.entries(this._remotePeers).some(([k, v]) => v.name == value && k != this._peer.id)
    if (duplicated) {
      if (window.showToast) window.showToast('This name already exists.', 'warning')
      dom.name_modal_value.focus()
      return
    }

    // Update user
    this._name = value

    // Update files
    for (let f of Object.values(this._files)) {
      if (f.owner_id == this._peer.id) {
        f.owner_name = this._name
        document.getElementById(`file-${f.id}-info`).innerHTML = `${this._parseBytes(f.size)} | Sent by ${f.owner_id == this._peer.id ? `${f.owner_name} (You)` : f.owner_name }`
      }
    }

    if (this._isHost) {
      // Update UI
      document.getElementById('transfer-users-list-host-name').innerHTML = `${this._name} (You)`

      // Notify all peers
      const peers_list = [{"id": this._peer.id, "name": this._name }, ...Object.entries(this._remotePeers).map(([k, v]) => ({"id": k, "name": v.name}))];
      for (let p of Object.values(this._remotePeers)) {
        p.conn.send({'webrtc-peers': peers_list})
      }
    }
    else {
      // Update UI
      document.getElementById(`user-${this._peer.id}-name`).innerHTML = `${this._name} (You)`

      // Notify Host
      this._remotePeers[this._room_id].conn.send({'webrtc-user-name': {"id": this._peer.id, "name": this._name}})
    }

    // Close modal
    const modal = bootstrap.Modal.getInstance(dom.name_modal);
    modal.hide()
    if (window.showToast) window.showToast(`Name changed to ${this._name}.`)
  }

  // Add one or multiple file to be transferred to all peers
  async addFiles(files) {
    let data = []
    const skippedNames = []
    for (const file of files) {
      // Check for duplicate file (same name and size already shared by you)
      const isDuplicate = Object.values(this._files).some(
        (existing) => existing.name === file.name && existing.size === file.size && !existing.removed && existing.owner_id === this._peer.id
      )
      if (isDuplicate) {
        skippedNames.push(file.name)
        continue
      }

      // Parse file
      const fileData = {
        "id": await this._getUUID(),
        "name": file.name,
        "size": file.size,
        "content": file,
        "owner_id": this._peer.id,
        "owner_name": this._name,
      };

      // Create file instance
      const f = new File(fileData);

      // Add file to the current user
      this._files[f.id] = f

      // Add file to the list
      this._addFileUI(f)

      // Store file to be send to other peers
      data.push({"id": f.id, "name": f.name, "size": f.size, "owner_id": f.owner_id, "owner_name": f.owner_name})
    }

    // Show toast for added files
    if (data.length > 0 && window.showToast) {
      const msg = data.length === 1
        ? `File "${data[0].name}" added.`
        : `${data.length} files added.`
      window.showToast(msg)
    }

    // Show toast for skipped duplicates
    if (skippedNames.length > 0) {
      const msg = skippedNames.length === 1
        ? `File "${skippedNames[0]}" is already added.`
        : `${skippedNames.length} files were already added.`
      if (window.showToast) window.showToast(msg, 'warning')
    }

    // Send file to all remote peers (If host, then all peers. If peer, then to the host)
    for (let peer of Object.values(this._remotePeers)) {
      if ('conn' in peer) peer.conn.send({"webrtc-file-add": data})
    }
  }

  // Remove a file shared by you
  removeFile(fileId) {
    this._files[fileId]._aborted = true
    this._files[fileId]._removed = true

    // Notify all peers
    for (let peer of Object.values(this._remotePeers)) {
      if ('conn' in peer) peer.conn.send({'webrtc-file-remove': {"peer_id": this._peer.id, "file_id": fileId}})
    }
    // Update UI
    document.getElementById(`file-${fileId}-remove`).style.display = 'none'
    document.getElementById(`file-${fileId}-icon-loading`).style.display = 'none'
    document.getElementById(`file-${fileId}-icon-success`).style.display = 'none'
    document.getElementById(`file-${fileId}-icon-failed`).style.display = 'none'
    document.getElementById(`file-${fileId}-error`).style.display = 'block'
    document.getElementById(`file-${fileId}-error`).innerHTML = 'You have removed this file.'
    if (window.showToast) window.showToast(`File "${this._files[fileId].name}" removed.`)
  }

  // Download a file shared by another peer
  async downloadFile(fileId) {
    // Update UI: Remove Download button and add loading icon
    document.getElementById(`file-${fileId}-download`).style.display = 'none'
    document.getElementById(`file-${fileId}-error`).innerHTML = ''
    document.getElementById(`file-${fileId}-error`).style.display = 'none'
    document.getElementById(`file-${fileId}-abort`).style.display = 'block'
    document.getElementById(`file-${fileId}-icon-success`).style.display = 'none'
    document.getElementById(`file-${fileId}-icon-failed`).style.display = 'none'
    document.getElementById(`file-${fileId}-icon-loading`).style.display = 'block'
    document.getElementById(`file-${fileId}-progress`).innerHTML = '0% | '

    // Init Peering connection to receive the file
    await this._files[fileId].init()

    // If it's the host redirect the request to the Origin's Peer. Otherwise send the request to the Host.
    this._remotePeers[this._isHost ? this._files[fileId].owner_id : this._room_id].conn.send({'webrtc-file-download': {"file_id": fileId, "requester_id": this._peer.id, "requester_name": this._name, "peer_id": this._files[fileId].peer.id}})
  }

  // Abort a file that is already being downloaded
  abortFile(fileId) {
    // Abort the file transfer
    this._files[fileId].abort()

    // Update UI
    document.getElementById(`file-${fileId}-abort`).style.display = 'none'
    document.getElementById(`file-${fileId}-download`).style.display = 'block'
    document.getElementById(`file-${fileId}-icon-loading`).style.display = 'none'
    document.getElementById(`file-${fileId}-icon-failed`).style.display = 'none'
    document.getElementById(`file-${fileId}-error`).style.display = 'block'
    document.getElementById(`file-${fileId}-error`).innerHTML = 'You have stopped the file transfer.'
  }

  // See file details
  showFileDetails(fileId) {
    // Compute data
    this.getFileDetails(fileId);

    // Show modal
    const modal = new bootstrap.Modal(dom.file_modal)
    modal.show()
  }

  getFileDetails(fileId) {
    // Hydrate details with the user's online status.
    let details = Object.entries(this._files[fileId].details).reduce((acc, [k, v]) => {
      acc[k] = {...v, online: k in this._remotePeers};
      return acc;
    }, {});

    // Set Refresh button handler
    dom.file_modal_refresh.onclick = () => {
      this.getFileDetails(fileId)
    };

    // Update UI
    const hasDetails = Object.values(details).length > 0
    dom.file_modal_table_empty.style.display = hasDetails ? 'none' : 'block'
    dom.file_modal_table.style.display = hasDetails ? 'table' : 'none'
    const tableWrap = document.getElementById('file-modal-table-wrap')
    if (tableWrap) tableWrap.style.display = hasDetails ? 'block' : 'none'

    // Build table
    dom.file_modal_table.querySelector('tbody').innerHTML = ''
    for (let user of Object.values(details)) {
      const statusColor = user.progress == 100 ? '#198754' : user.aborted ? '#DC3545' : '#0d6efd'
      const statusLabel = user.progress == 100 ? 'Completed' : user.aborted ? 'Stopped' : 'In progress'
      const statusBg = user.progress == 100 ? 'rgba(25,135,84,0.1)' : user.aborted ? 'rgba(220,53,69,0.1)' : 'rgba(13,110,253,0.1)'
      dom.file_modal_table.querySelector('tbody').innerHTML += `
        <tr>
          <td style="padding:12px 16px; font-weight:500; font-size:14px; color:var(--color-h1); vertical-align:middle; border-bottom:1px solid var(--color-border);">${user.user_name}</td>
          <td style="padding:12px 16px; vertical-align:middle; border-bottom:1px solid var(--color-border); min-width:120px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <div style="flex:1; height:6px; background-color:var(--color-card-header-bg); border-radius:3px; overflow:hidden;">
                <div style="width:${user.progress}%; height:100%; background-color:${statusColor}; border-radius:3px; transition:width 0.3s ease;"></div>
              </div>
              <span style="font-size:13px; font-weight:500; color:var(--color-muted); min-width:32px; text-align:right;">${user.progress}%</span>
            </div>
          </td>
          <td style="padding:12px 16px; vertical-align:middle; border-bottom:1px solid var(--color-border);">
            <span style="display:inline-block; padding:3px 10px; font-size:12px; font-weight:600; color:${statusColor}; background-color:${statusBg}; border-radius:20px;">${statusLabel}</span>
          </td>
          <td style="padding:12px 16px; vertical-align:middle; text-align:center; border-bottom:1px solid var(--color-border);">
            <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background-color:${user.online ? '#198754' : '#DC3545'}; box-shadow:0 0 0 3px ${user.online ? 'rgba(25,135,84,0.2)' : 'rgba(220,53,69,0.2)'};"></span>
          </td>
        </tr>
      `
    }
  }

  async downloadAll() {
    // Init UI Components
    dom.download_modal_value.innerHTML = '0%'
    dom.download_modal_active.querySelector('.progress-bar').style.width = '0%'
    dom.download_modal_active.style.display = 'flex'
    dom.download_modal_success.style.display = 'none'
    dom.download_modal_error.style.display = 'none'
    dom.download_modal_close.style.display = 'none'
    dom.download_modal_cancel.style.display = 'block'
    dom.download_modal_cancel.removeAttribute("disabled")
    dom.download_modal_cancel_spinner.style.display = 'none'

    // Get available files to download
    const files = Object.values(this._files).filter(x => x.owner_id != this._peer.id && !x.removed)

    // Check if at least there is a file to be downloaded
    if (files.length == 0) {
      if (window.showToast) window.showToast("There are no files to be downloaded.", 'warning')
      return
    }

    // Check how to know if user is downloading any files (check file is not from the owner)
    const inProgress = Object.values(this._files).some(x => x.in_progress)

    // Show notification modal
    if (inProgress) {
      if (window.showToast) window.showToast("Files are still downloading.", 'warning')
      return
    }

    // Show download all modal
    const modal = new bootstrap.Modal(dom.download_modal, {
      backdrop: 'static',
      keyboard: false
    })
    modal.show()

    // Create a new zip file
    const zip = new JSZip();

    // Start downloading all files, one by one
    this._downloadAll = {
      "active": true,
      "aborted": false,
      "file": null,
      "current": 0,
      "sizes": files.map(x => x.size),
      "interval": setInterval(() => this._downloadAllProgress(), 500),
    };

    for (let file of files) {
      // Check if current file has been removed by the owner
      if (file.removed) this._downloadAll.active = false

      // Check if the file is still active
      if (!this._downloadAll.active) break

      // Store current file being processed
      this._downloadAll.file = file
      this._downloadAll.current += 1

      // Init Peering connection to receive the file
      await file.init()

      // Mark the file to be in progress
      file.in_progress = true

      // State to convert the file in zip, instead of downloading it
      file.zip = true

      // Initiate the request to the file's owner to download the file
      this._remotePeers[this._isHost ? file.owner_id : this._room_id].conn.send({'webrtc-file-download': {"file_id": file.id, "requester_id": this._peer.id, "requester_name": this._name, "peer_id": file.peer.id}})

      // Wait until file finishes downloading
      await this._waitFileTranster(file)

      // Check if file was aborted
      if (file.aborted) {
        this._downloadAll.active = false
      }
      else {
        // Add files to the zip
        zip.file(file.name, new Blob(file.chunks))

        // Clean file from memory
        file.chunks = []
      }
    }

    // Download ZIP file
    if (this._downloadAll.active) {
      // Generate the zip file as a Blob
      const zipBlob = await zip.generateAsync({ type: "blob" });

      // Download the zip file
      const downloadLink = document.createElement('a');
      downloadLink.href = URL.createObjectURL(zipBlob);
      downloadLink.download = 'files.zip';
      downloadLink.click();
    }

    // Disable zip mode
    for (let file of Object.values(this._files)) file.zip = false
  }

  _waitFileTranster(file) {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (!file.in_progress) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 500);
    });
  }

  downloadAllCancel() {
    // Abort the downloadAll operation
    this._downloadAll.active = false
    this._downloadAll.aborted = true

    // Update UI
    dom.download_modal_cancel.setAttribute("disabled", "")
    dom.download_modal_cancel_spinner.style.display = 'inline-block'
  }

  _downloadAllProgress() {
    // Abort file transfer
    if (!this._downloadAll.active) {
      clearInterval(this._downloadAll.interval)
    }

    // Compute overall progress
    const totalSize = this._downloadAll.sizes.reduce((acc, size) => acc + size, 0);
    const totalTransferred = this._downloadAll.sizes.slice(0, this._downloadAll.current - 1).reduce((acc, size) => acc + size, 0) + this._downloadAll.file.transferred;
    const overallProgress = (totalTransferred / totalSize) * 100;

    // Update UI
    dom.download_modal_value.innerHTML = `${Math.floor(overallProgress)}%`
    dom.download_modal_active.querySelector('.progress-bar').style.width = `${Math.floor(overallProgress)}%`

    if (overallProgress == 100) {
      clearInterval(this._downloadAll.interval)
      dom.download_modal_active.style.display = 'none'
      dom.download_modal_success.style.display = 'flex'
      dom.download_modal_cancel.style.display = 'none'
      dom.download_modal_close.style.display = 'block'
    }
    else if (!this._downloadAll.active && !this._downloadAll.aborted) {
      dom.download_modal_active.style.display = 'none'
      dom.download_modal_error.style.display = 'block'
      dom.download_modal_error.querySelector('.progress-bar').style.width = `${Math.floor(overallProgress)}%`
      dom.download_modal_cancel.style.display = 'none'
      dom.download_modal_close.style.display = 'block'
    }
    else if (this._downloadAll.aborted) {
      const modal = bootstrap.Modal.getInstance(dom.download_modal);
      setTimeout(() => modal.hide(), 1000)
    }
  }

  // Emitted when the connection is established and ready-to-use (a peer connects to the host).
  async _handleConnection(conn, resolve) {
    // console.log('Received connection from', conn.peer)

    // Emitted when data is received from the remote peer. 
    conn.on('data', (data) => this._handleData(conn, data));

    // Emitted when either you or the remote peer closes the data connection.
    conn.on('close', () => this._handleClose(conn));

    // Emitted when there is an unexpected error in the data connection.
    conn.on('error', (err) => this._handleError(err));

    if (!this._isHost) {
      // Store Host Peer connection
      this._remotePeers[conn.peer] = {"conn": conn, "interval": setInterval(() => this._isAlive(conn.peer), 1000)}

      // Send our identity to the host
      conn.send({"webrtc-connect": {"name": this._name}})
    }

    // Resolve promise for .connect() method (a peer connects to the host)
    if (resolve !== undefined) resolve()
  }

  // Emitted when data is received from the remote peer.
  async _handleData(conn, data) {
    // console.log("Received data from", conn.peer, data)

    if ('webrtc-connect' in data && this._isHost) {
      // Add peer to the peers list
      this._remotePeers[conn.peer] = {"name": data['webrtc-connect']['name'], "conn": conn,  "interval": setInterval(() => this._isAlive(conn.peer), 1000)}

      // Show peer connected status
      dom.transfer_status_wait.style.display = 'none'
      dom.transfer_status_success.style.display = 'inline-block'

      // Define peers list (including host user)
      const peers_list = [{"id": this._peer.id, "name": this._name }, ...Object.entries(this._remotePeers).map(([k, v]) => ({"id": k, "name": v.name}))];

      // Build user's list
      this._addUserUI({"id": conn.peer, "name": data['webrtc-connect']['name']})

      // Send confirmation
      conn.send({'webrtc-connect-response': {"status": "welcome"}})

      // Notify all peers
      for (let p of Object.values(this._remotePeers)) {
        p.conn.send({'webrtc-peers': peers_list, 'webrtc-files': Object.values(this._files).filter(x => !x.aborted && !x.removed).map(x => x.file)})
      }
    }
    else if ('webrtc-connect-response' in data && !this._isHost) {
      this._status = data['webrtc-connect-response']
      if (data['webrtc-connect-response'].status == 'welcome') {
        // Update UI Components
        dom.connect_div.style.display = 'none'
        dom.transfer_div.style.display = 'block';
      }
    }
    else if ('webrtc-user-name' in data && this._isHost) {
      // Update user
      this._remotePeers[data['webrtc-user-name'].id].name = data['webrtc-user-name'].name

      // Update files
      for (let f of Object.values(this._files)) {
        if (f.owner_id == data['webrtc-user-name'].id) {
          f.owner_name = data['webrtc-user-name'].name
          document.getElementById(`file-${f.id}-info`).innerHTML = `${this._parseBytes(f.size)} | Sent by ${f.owner_name}`
        }
        for (let p of Object.values(f.remotePeers)) {
          if (p.user_id == data['webrtc-user-name'].id) {
            p.user_name = data['webrtc-user-name'].name
          }
        }
      }

      // Update UI
      document.getElementById(`user-${data['webrtc-user-name'].id}-name`).innerHTML = data['webrtc-user-name'].name

      // Notify all peers
      const peers_list = [{"id": this._peer.id, "name": this._name }, ...Object.entries(this._remotePeers).map(([k, v]) => ({"id": k, "name": v.name}))];
      for (let p of Object.values(this._remotePeers)) {
        p.conn.send({'webrtc-peers': peers_list})
      }
    }
    else if ('webrtc-peers' in data && !this._isHost) {
      // Show transfer page
      dom.transfer_div.style.display = 'block'
      dom.transfer_status_wait.style.display = 'none'
      dom.transfer_status_success.style.display = 'inline-block'
      if (window.showToast) window.showToast('Connection established!')

      // Process Connected Peers
      for (let p of data['webrtc-peers']) {
        // Peer is the Host
        if (p.id == this._room_id) {
          this._remotePeers[p.id].name = p.name
          dom.transfer_users_list_host_name.innerHTML = p.name
        }
        // Peer is not the Host
        else {
          // If peer is new, add it to the frontend
          if (!(p.id in this._remotePeers)) this._addUserUI(p)
          // If the peer is already stored, then only update name
          else {
            this._remotePeers[p.id].name = p.name
            document.getElementById(`user-${p.id}-name`).innerHTML = `${p.name} ${p.id == this._peer.id ? ' (You)' : ''}`
          }

          // Store user name
          this._remotePeers[p.id] = {"name": p.name}
        }

        // Update files
        for (let f of Object.values(this._files)) {
          if (f.owner_id == p.id) {
            f.owner_name = p.name
            document.getElementById(`file-${f.id}-info`).innerHTML = `${this._parseBytes(f.size)} | Sent by ${f.owner_id == this._peer.id ? `${p.name} (You)` : p.name }`
          }
        }
      }
      // Check if any peer has disconnected
      for (let p of Object.keys(this._remotePeers)) {
        if (!data['webrtc-peers'].some(p2 => p2.id === p)) {
          clearInterval(this._remotePeers[p].interval);
          delete this._remotePeers[p]
          this._removeUserUI(p)
        }
      }

      // Process files
      if ('webrtc-files' in data) {
        for (let file of data['webrtc-files'].filter(x => !(x.id in this._files))) {
          // Create file instance
          const f = new File(file)

          // Add file to the current user
          this._files[f.id] = f

          // Add file to the list
          this._addFileUI(f)
        }
      }
    }
    else if ('webrtc-file-add' in data && conn.peer in this._remotePeers) {
      this._onFileAdd(data['webrtc-file-add'])
    }
    else if ('webrtc-file-remove' in data && conn.peer in this._remotePeers) {
      this._onFileRemove(data['webrtc-file-remove'])
    }
    else if ('webrtc-file-download' in data && conn.peer in this._remotePeers) {
      this._onFileDownload(data['webrtc-file-download'])
    }
    else conn.close()
  }

  // Emitted when either you or the remote peer closes the data connection.
  _handleClose(conn) {
    // Peer: The host has closed the connection
    if (conn.peer == this._room_id) {
      if (this._status?.status == 'welcome') {
        dom.transfer_div.style.display = 'none'
        dom.error_div.style.display = 'block'
        dom.error_message.innerHTML = 'Host user has been disconnected.'
      }
    }
    // Host: A peer has closed the connection
    else if (conn.peer in this._remotePeers) {
      // Remove user from the list
      this._removeUserUI(conn.peer)

      // Update files
      for (let file of Object.values(this._files)) {
        if (file.owner_id == conn.peer) {
          document.getElementById(`file-${file.id}-abort`).style.display = 'none'
          document.getElementById(`file-${file.id}-download`).style.display = 'none'
          document.getElementById(`file-${file.id}-icon-loading`).style.display = 'none'
          document.getElementById(`file-${file.id}-icon-failed`).style.display = 'none'
          document.getElementById(`file-${file.id}-error`).style.display = 'block' 
          document.getElementById(`file-${file.id}-error`).innerHTML = 'The user has disconnected.'
          file.removed = true
        }
      }

      // Remove peer user
      clearInterval(this._remotePeers[conn.peer].interval);
      delete this._remotePeers[conn.peer]

      // If no peers, disable the Send File button
      if (Object.keys(this._remotePeers).length == 0) {
        dom.transfer_status_success.style.display = 'none'
        dom.transfer_status_wait.style.display = 'inline-block'
      }

      // Notify all peers
      const peers_list = [{"id": this._peer.id, "name": this._name }, ...Object.entries(this._remotePeers).map(([k, v]) => ({"id": k, "name": v.name}))];
      for (let p of Object.values(this._remotePeers)) {
        p.conn.send({'webrtc-peers': peers_list})
      }
    }
  }

  // Emitted when there is an unexpected error in the data connection.
  _handleError(err) {
    // Fatal errors — cannot recover
    const fatalTypes = ['browser-incompatible', 'invalid-id', 'unavailable-id', 'ssl-unavailable'];
    if (fatalTypes.includes(err.type)) {
      this._showFatalError(
        err.type === 'browser-incompatible'
          ? 'FileSync does not work with this browser.'
          : err.message
      );
      return;
    }

    // Recoverable errors — attempt reconnection
    if (['disconnected', 'network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      console.warn(`Recoverable error (${err.type}). Scheduling reconnect...`);
      this._scheduleReconnect();
      return;
    }

    // Peer-unavailable is expected when a remote peer is unreachable
    if (err.type === 'peer-unavailable') {
      console.warn('Remote peer is unavailable:', err.message);
      return;
    }

    // Fallback for unknown error types
    console.error('Unhandled peer error:', err.type, err.message);
  }

  async _onFileAdd(files) {
    let data = []
    for (const file of files) {
      // Create file instance with received data
      const fileData = {
        "id": file.id,
        "name": file.name,
        "size": file.size,
        "owner_id": file.owner_id,
        "owner_name": file.owner_name,
      };

      // Create file instance
      const f = new File(fileData)

      // Add file to the current user
      this._files[f.id] = f

      // Add file to the list
      this._addFileUI(f)

      // Store file to send it to other peers
      data.push({"id": f.id, "name": f.name, "size": f.size, "owner_id": f.owner_id, "owner_name": f.owner_name})
    }

    // Send file to all peers excluding the peer that has sent the file
    if (this._isHost) {
      const peersList = Object.entries(this._remotePeers)
        .filter(([peerId]) => peerId !== files[0].owner_id)
        .map(([, peerData]) => peerData);
      for (let peer of peersList) {
        peer.conn.send({"webrtc-file-add": data})
      }
    }
  }

  async _onFileDownload(data) {
    // If the current peer is the owner of the file
    if (this._files[data.file_id].owner_id == this._peer.id) {
      this._files[data.file_id].transfer(data)
    }
    // Redirect
    else {
      const owner_id = this._files[data.file_id].owner_id
      this._remotePeers[owner_id].conn.send({"webrtc-file-download": data})
    }
  }

  _onFileRemove(data) {
    // Abort the file transfer
    this._files[data.file_id].remove()

    document.getElementById(`file-${data.file_id}-abort`).style.display = 'none'
    document.getElementById(`file-${data.file_id}-download`).style.display = 'none'
    document.getElementById(`file-${data.file_id}-icon-loading`).style.display = 'none'
    document.getElementById(`file-${data.file_id}-icon-failed`).style.display = 'none'
    document.getElementById(`file-${data.file_id}-error`).style.display = 'block' 
    document.getElementById(`file-${data.file_id}-error`).innerHTML = 'This file has been remove it.'

    // Send file to all peers excluding the peer that has sent the file
    if (this._isHost) {
      const peersList = Object.entries(this._remotePeers)
        .filter(([peerId]) => peerId !== data.peer_id)
        .map(([, peerData]) => peerData);
      for (let peer of peersList) {
        peer.conn.send({"webrtc-file-remove": data})
      }
    }
  }

  _addUserUI(user) {
    // Add new user
    let li = document.createElement('li')
    li.setAttribute('id', `user-${user.id}`)
    li.setAttribute('class', 'list-group-item')
    li.innerHTML = `
      <span title="User">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#198754" class="bi bi-lightning-charge-fill" viewBox="0 0 16 16" style="margin-bottom:5px">
          <path d="M11.251.068a.5.5 0 0 1 .227.58L9.677 6.5H13a.5.5 0 0 1 .364.843l-8 8.5a.5.5 0 0 1-.842-.49L6.323 9.5H3a.5.5 0 0 1-.364-.843l8-8.5a.5.5 0 0 1 .615-.09z"/>
        </svg>
      </span>
      <span id="user-${user.id}-name">${user.id == this._peer.id ? `${user.name} (You)` : user.name}</span>
    `
    dom.transfer_users_list.appendChild(li)

    // Update the number of users in the list
    dom.transfer_users_count.innerHTML = ` (${dom.transfer_users_list.querySelectorAll('li').length})`

    // Show toast (skip for own user)
    if (user.id != this._peer.id && window.showToast) window.showToast(`User ${user.name} joined.`)
  }

  _removeUserUI(user_id) {
    // Get user name before removing
    const userName = this._remotePeers[user_id]?.name || document.getElementById(`user-${user_id}-name`)?.textContent?.trim() || 'A user'

    // Remove user from the list
    document.getElementById(`user-${user_id}`).remove()

    // Update the number of users in the list
    dom.transfer_users_count.innerHTML = ` (${dom.transfer_users_list.querySelectorAll('li').length})`

    // Show toast
    if (window.showToast) window.showToast(`User ${userName} left.`, 'warning')
  }

  _addFileUI(file) {
    // Add file to the list
    dom.transfer_files_list_empty.remove()
    let li = document.createElement('li')
    li.setAttribute('id', `file-${this._peer.id}`)
    li.setAttribute('class', 'list-group-item')
  
    li.innerHTML = `
      <div class="row align-items-center">
        <div class="col-auto" style="padding-right: 0">
          <div id="file-${file.id}-icon-loading" title="${file.owner_id == this._peer.id ? 'Uploading file': 'Downloading file'}" class="col-auto spinner-border" style="margin-right: 12px; color: #0d6efd; width: 1.4rem; height: 1.4rem; --bs-spinner-border-width: 0.15em; margin-top:3px; display: none"></div>
          <div id="file-${file.id}-icon-success" title="${file.owner_id == this._peer.id ? 'File uploaded': 'File downloaded'}" style="margin-right: 12px; display: none">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="#198754" class="bi bi-check-circle-fill" viewBox="0 0 16 16">
              <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zm-3.97-3.03a.75.75 0 0 0-1.08.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-.01-1.05z"/>
            </svg>
          </div>
          <div id="file-${file.id}-icon-failed" title="Failed" style="margin-right: 12px; display: none">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="#dc3545" class="bi bi-x-circle-fill" viewBox="0 0 16 16">
              <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM5.354 4.646a.5.5 0 1 0-.708.708L7.293 8l-2.647 2.646a.5.5 0 0 0 .708.708L8 8.707l2.646 2.647a.5.5 0 0 0 .708-.708L8.707 8l2.647-2.646a.5.5 0 0 0-.708-.708L8 7.293 5.354 4.646z"/>
            </svg>
          </div>
        </div>
  
        <div class="col d-flex flex-column" style="overflow-x: hidden; padding-left:0px;">
          <div style="margin-bottom: 5px; font-size: 0.875rem; font-weight: 500; text-align: left; word-break: break-all;">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="bi bi-arrow-up-short" viewBox="0 0 16 16"; style="margin-top:-3px; margin-right:-3px; margin-left:-5px; display: ${file.owner_id == this._peer.id ? 'block-inline' : 'none'}">
            <path fill-rule="evenodd" d="M8 12a.5.5 0 0 0 .5-.5V5.707l2.146 2.147a.5.5 0 0 0 .708-.708l-3-3a.5.5 0 0 0-.708 0l-3 3a.5.5 0 1 0 .708.708L7.5 5.707V11.5a.5.5 0 0 0 .5.5z"/>
          </svg>
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="bi bi-arrow-down-short" viewBox="0 0 16 16" style="margin-top:-3px; margin-right:-3px; margin-left:-5px; display: ${file.owner_id == this._peer.id ? 'none' : 'block-inline'}">
            <path fill-rule="evenodd" d="M8 4a.5.5 0 0 1 .5.5v5.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L7.5 10.293V4.5A.5.5 0 0 1 8 4z"/>
          </svg>
          ${file.name}</div>
          <div style="color: #636979; font-size: .9rem; font-weight: 500; overflow-x: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; margin-bottom:1px"><span id="file-${file.id}-progress"></span><span id="file-${file.id}-info">${this._parseBytes(file.size)} | Sent by ${file.owner_id == this._peer.id ? `${file.owner_name} (You)` : file.owner_name }</span></div>
          <div id="file-${file.id}-error" style="color: #dc3545; font-size: .9rem; font-weight: 500; overflow-x: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; margin-top:5px; margin-bottom:4px; display:none"></div>
          <div id="file-${file.id}-details" onclick="showFileDetails('${file.id}')" style="color: #0d6efd; font-size: .9rem; font-weight: 500; text-align: left; padding-top:5px; padding-bottom:4px; padding-right:4px; cursor:pointer; display: ${file.owner_id == this._peer.id ? 'block' : 'none'}">See details</div>
        </div>

        <div id="file-${file.id}-remove" onclick="removeFile('${file.id}')" class="col-auto text-end" title="Remove file" style="cursor: pointer; display: ${file.owner_id == this._peer.id ? 'block-inline' : 'none'}">
          <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" fill="#dc3545" class="bi bi-x-circle" viewBox="0 0 16 16">
            <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </div>
        <div id="file-${file.id}-abort" onclick="abortFile('${file.id}')" class="col-auto text-end" title="Stop file download" style="cursor: pointer; display: none">
          <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" fill="#dc3545" class="bi bi-x-circle" viewBox="0 0 16 16">
            <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </div>
        <div id="file-${file.id}-download" onclick="downloadFile('${file.id}')" class="col-auto text-end" title="Download file" style="cursor: pointer; display: ${file.owner_id == this._peer.id ? 'none' : 'block-inline'}">
          <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" fill="#0d6efd" class="bi bi-arrow-down-circle" viewBox="0 0 16 16">
            <path fill-rule="evenodd" d="M1 8a7 7 0 1 0 14 0A7 7 0 0 0 1 8zm15 0A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM8.5 4.5a.5.5 0 0 0-1 0v5.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V4.5z"/>
          </svg>
        </div>
      </div>
    `
    dom.transfer_files_list.appendChild(li)

    // Update the number of files in the list
    dom.transfer_files_count.innerHTML = ` (${dom.transfer_files_list.querySelectorAll('li').length})`
  }

  _generate_name() {
    const colors = ["Aqua","Aquamarine","Azure","Beige","Bisque","Black","Blue","Brown","Chartreuse","Chocolate","Coral","Cornsilk","Crimson","Cyan","Fuchsia","Gold","Gray","Grey","Green","Indigo","Ivory","Khaki","Lavender","Lime","Linen","Magenta","Maroon","Navy","Olive","Orange","Orchid","Peru","Pink","Plum","Purple","Red","Salmon","Sienna","Silver","Snow","Tan","Teal","Thistle","Tomato","Turquoise","Violet","Wheat","White","Yellow"]
    const animals = ["Aardvark","Albatross","Alligator","Alpaca","Ant","Anteater","Antelope","Ape","Armadillo","Donkey","Baboon","Badger","Barracuda","Bat","Bear","Beaver","Bee","Bison","Boar","Buffalo","Butterfly","Camel","Capybara","Caribou","Cassowary","Cat","Caterpillar","Cattle","Chamois","Cheetah","Chicken","Chimpanzee","Chinchilla","Chough","Clam","Cobra","Cockroach","Cod","Cormorant","Coyote","Crab","Crane","Crocodile","Crow","Curlew","Deer","Dinosaur","Dog","Dogfish","Dolphin","Dotterel","Dove","Dragonfly","Duck","Dugong","Dunlin","Eagle","Echidna","Eel","Eland","Elephant","Elk","Emu","Falcon","Ferret","Finch","Fish","Flamingo","Fly","Fox","Frog","Gaur","Gazelle","Gerbil","Giraffe","Gnat","Gnu","Goat","Goldfinch","Goldfish","Goose","Gorilla","Goshawk","Grasshopper","Grouse","Guanaco","Gull","Hamster","Hare","Hawk","Hedgehog","Heron","Herring","Hippopotamus","Hornet","Horse","Human","Hummingbird","Hyena","Ibex","Ibis","Jackal","Jaguar","Jay","Jellyfish","Kangaroo","Kingfisher","Koala","Kookabura","Kouprey","Kudu","Lapwing","Lark","Lemur","Leopard","Lion","Llama","Lobster","Locust","Loris","Louse","Lyrebird","Magpie","Mallard","Manatee","Mandrill","Mantis","Marten","Meerkat","Mink","Mole","Mongoose","Monkey","Moose","Mosquito","Mouse","Mule","Narwhal","Newt","Nightingale","Octopus","Okapi","Opossum","Oryx","Ostrich","Otter","Owl","Oyster","Panther","Parrot","Partridge","Peafowl","Pelican","Penguin","Pheasant","Pig","Pigeon","Pony","Porcupine","Porpoise","Quail","Quelea","Quetzal","Rabbit","Raccoon","Rail","Ram","Rat","Raven","Red deer","Red panda","Reindeer","Rhinoceros","Rook","Salamander","Salmon","Sand Dollar","Sandpiper","Sardine","Scorpion","Seahorse","Seal","Shark","Sheep","Shrew","Skunk","Snail","Snake","Sparrow","Spider","Spoonbill","Squid","Squirrel","Starling","Stingray","Stinkbug","Stork","Swallow","Swan","Tapir","Tarsier","Termite","Tiger","Toad","Trout","Turkey","Turtle","Viper","Vulture","Wallaby","Walrus","Wasp","Weasel","Whale","Wildcat","Wolf","Wolverine","Wombat","Woodcock","Woodpecker","Worm","Wren","Yak","Zebra"]
    return colors[Math.round(Math.random() * (colors.length - 1))] + ' ' + animals[Math.round(Math.random() * (animals.length - 1))]
  }

  // Function to parse bytes
  _parseBytes(bytes) {
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
    const base = 1024
    if (bytes === 0) {
      return '0 bytes'
    }
    const exponent = Math.floor(Math.log(bytes) / Math.log(base))
    const value = (bytes / Math.pow(base, exponent)).toFixed(2)
    return `${value} ${units[exponent]}`
  }

  async _getUUID() {
    const response = await fetch(`/api/uuid`);
    const data = await response.json();
    return data['uuid'];
  }
}