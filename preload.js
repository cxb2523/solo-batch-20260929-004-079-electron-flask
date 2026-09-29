"use strict";

// Runs in the isolated renderer world. Exposes a minimal, explicit bridge
// between the browser side renderer and the Electron main process.
try {
  const { contextBridge, ipcRenderer } = require("electron");

  contextBridge.exposeInMainWorld("api", {
    systemInfo: {
      get: () => ipcRenderer.invoke("system-info:get"),
    },
  });
} catch (error) {
  // Allows the contract check (and a plain browser) to load this file
  // without an Electron runtime present.
  if (typeof window !== "undefined") {
    window.__PRELOAD_ERROR__ =
      error && error.message ? error.message : String(error);
  }
}
