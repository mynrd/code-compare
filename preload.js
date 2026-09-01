const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickFile: () => ipcRenderer.invoke('pick-file'),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  compareFolders: (args) => ipcRenderer.invoke('compare-folders', args),
  compareFiles: (args) => ipcRenderer.invoke('compare-files', args),
  readPair: (args) => ipcRenderer.invoke('read-pair', args),
  copyFile: (args) => ipcRenderer.invoke('copy-file', args),
  deleteFile: (args) => ipcRenderer.invoke('delete-file', args),
  tempWrite: (args) => ipcRenderer.invoke('temp-write', args),
  tempRead: (args) => ipcRenderer.invoke('temp-read', args),
  tempDelete: (args) => ipcRenderer.invoke('temp-delete', args),
  tempList: () => ipcRenderer.invoke('temp-list'),
  applyTemp: (args) => ipcRenderer.invoke('apply-temp', args),
  git: {
    hasGit: () => ipcRenderer.invoke('git-has-git'),
    repoRoot: (args) => ipcRenderer.invoke('git-repo-root', args),
    currentBranch: (args) => ipcRenderer.invoke('git-current-branch', args),
    listBranches: (args) => ipcRenderer.invoke('git-list-branches', args),
    diffNameStatus: (args) => ipcRenderer.invoke('git-diff-name-status', args),
    showFile: (args) => ipcRenderer.invoke('git-show-file', args),
    log: (args) => ipcRenderer.invoke('git-log', args),
    commitFiles: (args) => ipcRenderer.invoke('git-commit-files', args),
    parentOf: (args) => ipcRenderer.invoke('git-parent-of', args),
    pickRepo: () => ipcRenderer.invoke('pick-repo')
  }
});
