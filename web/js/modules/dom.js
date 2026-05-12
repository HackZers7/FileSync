export const dom = {
  // TOP BAR
  theme_text: document.getElementById('theme-text'),
  about_text: document.getElementById('about-text'),

  // ABOUT
  about_div: document.getElementById('about-div'),
  comic_img: document.getElementById('comic-img'),

  // ERROR
  error_div: document.getElementById('error-div'),
  error_message: document.getElementById('error-message'),

  // CONNECT
  connect_div: document.getElementById('connect-div'),

  // TRANSFER
  transfer_div: document.getElementById('transfer-div'),

  transfer_status_wait: document.getElementById('transfer-status-wait'),
  transfer_status_success: document.getElementById('transfer-status-success'),

  transfer_select_file: document.getElementById('transfer-select-file'),
  transfer_select_file_input: document.getElementById('transfer-select-file-input'),

  transfer_users_div: document.getElementById('transfer-users-div'),
  transfer_users_count: document.getElementById('transfer-users-count'),
  transfer_users_list: document.getElementById('transfer-users-list'),
  transfer_users_list_host: document.getElementById('transfer-users-list-host'),
  transfer_users_list_host_name: document.getElementById('transfer-users-list-host-name'),

  transfer_files_div: document.getElementById('transfer-files-div'),
  transfer_files_count: document.getElementById('transfer-files-count'),
  transfer_files_download: document.getElementById('transfer-files-download'),
  transfer_files_list: document.getElementById('transfer-files-list'),
  transfer_files_list_empty: document.getElementById('transfer-files-list-empty'),

  // NAME MODAL
  name_modal: document.getElementById('name-modal'),
  name_modal_value: document.getElementById('name-modal-value'),

  // FILE MODAL
  file_modal: document.getElementById('file-modal'),
  file_modal_table: document.getElementById('file-modal-table'),
  file_modal_table_empty: document.getElementById('file-modal-table-empty'),
  file_modal_refresh: document.getElementById('file-modal-refresh'),

  // DOWNLOAD MODAL
  download_modal: document.getElementById('download-modal'),
  download_modal_value: document.getElementById('download-modal-value'),
  download_modal_active: document.getElementById('download-modal-active'),
  download_modal_success: document.getElementById('download-modal-success'),
  download_modal_error: document.getElementById('download-modal-error'),
  download_modal_cancel: document.getElementById('download-modal-cancel'),
  download_modal_cancel_spinner: document.getElementById('download-modal-cancel-spinner'),
  download_modal_close: document.getElementById('download-modal-close'),

  // NOTIFICATION
  notification_modal: document.getElementById('notification-modal'),
  notification_modal_value: document.getElementById('notification-modal-value'),
}

// Display a confirmation dialog when the user attempts to refresh or navigate away from the page.
window.addEventListener("beforeunload", (event) => {
  event.preventDefault();
});

// Focus the name input after the fade animation
dom.name_modal.addEventListener('shown.bs.modal', () => {
  dom.name_modal_value.focus()
});
