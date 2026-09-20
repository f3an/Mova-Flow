import { contextBridge, ipcRenderer } from 'electron';

// Renderer needs this to know whether to leave room for macOS's traffic-light
// buttons, which — unlike Windows' titleBarOverlay — draw on top of the page
// with no room reserved for them automatically.
contextBridge.exposeInMainWorld('platform', process.platform);

// Same API shape as window.pywebview.api from the Python version — so the
// renderer code carries over almost 1:1 (just window.pywebview.api.X() -> window.api.X()).
contextBridge.exposeInMainWorld('api', {
  get_state: () => ipcRenderer.invoke('get-state'),
  save_config: (
    role: string,
    host: string,
    port: number,
    clientSecret: string,
    modelPreset: string,
    modelPath: string,
    lanExpose: boolean,
  ) => ipcRenderer.invoke('save-config', role, host, port, clientSecret, modelPreset, modelPath, lanExpose),
  choose_model_file: () => ipcRenderer.invoke('choose-model-file'),
  start_server: () => ipcRenderer.invoke('start-server'),
  stop_server: () => ipcRenderer.invoke('stop-server'),
  check_remote: (host: string, port: number, secret: string) =>
    ipcRenderer.invoke('check-remote', host, port, secret),
  regenerate_secret: () => ipcRenderer.invoke('regenerate-secret'),
  get_token: () => ipcRenderer.invoke('get-token'),
  set_language: (lang: string) => ipcRenderer.invoke('set-language', lang),
  save_client_history_entry: (
    filename: string,
    language: string,
    audioExt: string,
    audioBytes: ArrayBuffer,
    text: string,
  ) => ipcRenderer.invoke('save-client-history-entry', filename, language, audioExt, audioBytes, text),
  get_client_history: () => ipcRenderer.invoke('get-client-history'),
  get_client_history_text: (id: string) => ipcRenderer.invoke('get-client-history-text', id),
  get_client_history_audio: (id: string) => ipcRenderer.invoke('get-client-history-audio', id),
  delete_client_history_entry: (id: string) => ipcRenderer.invoke('delete-client-history-entry', id),
  get_update_state: () => ipcRenderer.invoke('get-update-state'),
  install_update: () => ipcRenderer.invoke('install-update'),
  open_releases_page: () => ipcRenderer.invoke('open-releases-page'),
  discover_hosts: () => ipcRenderer.invoke('discover-hosts'),
});
