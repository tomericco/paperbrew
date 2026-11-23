import { contextBridge, ipcRenderer } from 'electron';

// The paste window's only capability: hand a code to the main process.
contextBridge.exposeInMainWorld('paperbrew', {
  submitCode: (code: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('paste:submit', String(code)),
});
