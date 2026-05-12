import { dom } from './dom.js';
import { User } from './webrtc/user.js';

// Single shared room: every visitor joins the same session.
const FIXED_ROOM_ID = 'main';

// Store current user
var user;

// Get theme mode
if (window.localStorage.getItem('mode') == 'light') {
  dom.theme_text.innerHTML = 'Light'
  dom.comic_img.src = "assets/comic.png"
}

// Load app version from API
async function loadVersion() {
  const res = await fetch('/api/');
  const data = await res.json();
  document.getElementById('appVersion').textContent = `v${data.version}`;
}

// On Load
async function onLoad() {
  // Load version badge
  await loadVersion();

  // Check WebRTC browser compatibility
  if (typeof RTCPeerConnection === 'undefined') {
    dom.error_div.style.display = 'block'
    dom.error_message.innerHTML = 'Your browser does not support <a href="https://caniuse.com/?search=webrtc" target="_blank" style="color: inherit; text-decoration: underline;">WebRTC</a>.<br><span style="color: #6c757d; font-size: 14px; margin-top: 10px; display: inline-block;">Please use a modern browser such as Chrome or Firefox.</span>'
    return
  }

  // Show "connecting" state while we figure out our role.
  dom.connect_div.style.display = 'block'

  // Create current user (everyone targets the same fixed room).
  user = new User(FIXED_ROOM_ID)

  // Init peer connection. The User class will try to claim the fixed room ID
  // (becoming host) and otherwise fall back to peer mode and connect to the host.
  await user.init()

  // Reveal transfer UI now that we know our role.
  dom.connect_div.style.display = 'none'
  dom.transfer_div.style.display = 'block'
  dom.transfer_users_list_host_name.innerHTML = user.isHost
    ? `${user.name} (You)`
    : 'Connecting...'

  if (user.isHost) {
    dom.transfer_users_count.innerHTML = ' (1)'
  }
}

// Theme
function themeClick() {
  if (dom.theme_text.innerHTML == 'Dark') {
    dom.theme_text.innerHTML = 'Light'
    document.documentElement.classList.remove("dark")
    document.documentElement.classList.add("light")
    document.documentElement.setAttribute('data-bs-theme', 'light')
    window.localStorage.setItem('mode', 'light')
    dom.comic_img.src = "assets/comic.png"
  }
  else if (dom.theme_text.innerHTML == 'Light') {
    dom.theme_text.innerHTML = 'Dark'
    document.documentElement.classList.remove("light")
    document.documentElement.classList.add("dark")
    document.documentElement.setAttribute('data-bs-theme', 'dark')
    window.localStorage.setItem('mode', 'dark')
    dom.comic_img.src = "assets/comic-dark.png"
  }
}
window.themeClick = themeClick;

// About
function aboutClick() {
  if (dom.about_text.innerHTML == 'About') {
    dom.transfer_div.style.display = 'none'
    dom.about_div.style.display = 'block'
    dom.about_text.innerHTML = 'Go back'
  }
  else {
    dom.about_div.style.display = 'none'
    dom.about_text.innerHTML = 'About'
    dom.transfer_div.style.display = 'block'
  }
}
window.aboutClick = aboutClick;

// Change name
function changeName() {
  dom.name_modal_value.value = ''

  const modal = new bootstrap.Modal(dom.name_modal)
  modal.show()
}
window.changeName = changeName;

function changeNameSubmit() {
  // Update name
  user.changeName(dom.name_modal_value.value.trim())
}
window.changeNameSubmit = changeNameSubmit;

// Send File
function sendFiles(event) {
  user.addFiles(event.files)
}
window.sendFiles = sendFiles;

// Remove file
function removeFile(fileId) {
  user.removeFile(fileId)
}
window.removeFile = removeFile;

// Download File
function downloadFile(id) {
  user.downloadFile(id)
}
window.downloadFile = downloadFile;

// Abort File (Stop file download)
function abortFile(fileId) {
  user.abortFile(fileId)
}
window.abortFile = abortFile;

// See details
function showFileDetails(fileId) {
  user.showFileDetails(fileId)
}
window.showFileDetails = showFileDetails;

// Download all
function downloadAll() {
  user.downloadAll()
}
window.downloadAll = downloadAll;

// Cancel download all
function cancelDownloadAll() {
  user.downloadAllCancel()
}
window.cancelDownloadAll = cancelDownloadAll;

// Toast notification
let _toastTimeout = null;
function showToast(message, type = 'success') {
  const toast = document.getElementById('notification-toast')
  const toastValue = document.getElementById('notification-toast-value')
  const iconSuccess = document.getElementById('notification-toast-icon-success')
  const iconWarning = document.getElementById('notification-toast-icon-warning')
  if (!toast || !toastValue) return
  toastValue.textContent = message
  // Toggle icon based on type
  if (iconSuccess && iconWarning) {
    iconSuccess.style.display = type === 'warning' ? 'none' : 'inline'
    iconWarning.style.display = type === 'warning' ? 'inline' : 'none'
  }
  // Clear any existing timeout
  if (_toastTimeout) clearTimeout(_toastTimeout)
  // Show
  toast.style.opacity = '1'
  toast.style.transform = 'translateX(-50%) translateY(0)'
  // Auto-hide after 2s
  _toastTimeout = setTimeout(() => {
    toast.style.opacity = '0'
    toast.style.transform = 'translateX(-50%) translateY(-100px)'
  }, 2000)
}
window.showToast = showToast;

// Drag and Drop on transfer-div
function initDropZone() {
  const transferDiv = document.getElementById('transfer-div')
  if (!transferDiv) return

  // Prevent browser default drag behavior globally
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => e.preventDefault())

  let dragCounter = 0

  transferDiv.addEventListener('dragenter', (e) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter++
    transferDiv.classList.add('drag-over')
  })

  transferDiv.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })

  transferDiv.addEventListener('dragleave', (e) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter--
    if (dragCounter === 0) {
      transferDiv.classList.remove('drag-over')
    }
  })

  transferDiv.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter = 0
    transferDiv.classList.remove('drag-over')
    const files = e.dataTransfer.files
    if (files.length > 0) {
      user.addFiles(files)
    }
  })
}

// On document loaded, execute onLoad() method.
(() => {
  onLoad()
  initDropZone()
})();
