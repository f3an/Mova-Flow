import { contextBridge, ipcRenderer } from 'electron';

// Same API shape as window.pywebview.api from the Python version — so the
// renderer code carries over almost 1:1 (just window.pywebview.api.X() -> window.api.X()).
contextBridge.exposeInMainWorld('api', {
  get_state: () => ipcRenderer.invoke('get-state'),
  save_config: (role: string, host: string, port: number, clientSecret: string) =>
    ipcRenderer.invoke('save-config', role, host, port, clientSecret),
  start_server: () => ipcRenderer.invoke('start-server'),
  stop_server: () => ipcRenderer.invoke('stop-server'),
  check_remote: (host: string, port: number, secret: string) =>
    ipcRenderer.invoke('check-remote', host, port, secret),
  regenerate_secret: () => ipcRenderer.invoke('regenerate-secret'),
  get_token: () => ipcRenderer.invoke('get-token'),
  set_language: (lang: string) => ipcRenderer.invoke('set-language', lang),
});
