"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const { SYSTEM_INFO_CHANNEL } = require("./package_python.js");

contextBridge.exposeInMainWorld("api", {
  // Resolves to { ok: true, data } or { ok: false, error } — never rejects.
  getSystemInfo: () => ipcRenderer.invoke(SYSTEM_INFO_CHANNEL),
});
