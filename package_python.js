"use strict";

const path = require("path");

const FLASK_BASE_URL = process.env.FLASK_BASE_URL || "http://localhost:4040";
const SYSTEM_INFO_CHANNEL = "system-info:get";
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 3000;
const INITIAL_BACKOFF_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isValidSystemInfo = (payload) => {
  return (
    payload !== null &&
    typeof payload === "object" &&
    typeof payload.python_version === "string" &&
    typeof payload.implementation === "string" &&
    typeof payload.platform === "string" &&
    typeof payload.timestamp === "string" &&
    !Number.isNaN(Date.parse(payload.timestamp))
  );
};

const fetchSystemInfoOnce = () => {
  return new Promise((resolve, reject) => {
    const request = require("http").get(
      `${FLASK_BASE_URL}/api/system-info`,
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Unexpected status code ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${error.message}`));
          }
        });
      }
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    request.on("error", reject);
  });
};

const fetchSystemInfoWithRetry = async () => {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const payload = await fetchSystemInfoOnce();
      if (!isValidSystemInfo(payload)) {
        return {
          ok: false,
          error: {
            code: "INVALID_PAYLOAD",
            message: "Response is missing required string fields or has wrong types.",
            attempts: attempt,
          },
        };
      }
      return { ok: true, data: payload };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1));
      }
    }
  }
  return {
    ok: false,
    error: {
      code: "BACKEND_UNAVAILABLE",
      message: lastError ? lastError.message : "Unknown error",
      attempts: MAX_ATTEMPTS,
    },
  };
};

// Register the IPC handler bridging the renderer to the Flask backend.
// Returns a structured result ({ ok, data } or { ok, error }) instead of throwing.
const registerSystemInfoIpc = (ipcMain) => {
  ipcMain.handle(SYSTEM_INFO_CHANNEL, () => fetchSystemInfoWithRetry());
};

const packagePython = () => {
  const spawn = require("child_process").spawn,
    ls = spawn(
      "pyinstaller",
      [
        "-w",
        "--onefile",
        `--add-data web_app/app/templates${path.delimiter}templates`,
        `--add-data web_app/app/static${path.delimiter}static`,
        "--distpath dist-python",
        "web_app/run_app.py",
      ],
      {
        shell: true,
      }
    );

  ls.stdout.on("data", function (data) {
    // stream output of build process
    console.log(data.toString());
  });

  ls.stderr.on("data", function (data) {
    console.log("Packaging error: " + data.toString());
  });
  ls.on("exit", function (code) {
    console.log("child process exited with code " + code.toString());
  });
};

if (require.main === module) {
  packagePython();
}

module.exports = {
  registerSystemInfoIpc,
  fetchSystemInfoWithRetry,
  isValidSystemInfo,
  SYSTEM_INFO_CHANNEL,
};
