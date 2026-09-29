"use strict";

const http = require("http");
const path = require("path");

const API_URL = "http://localhost:4040/api/system-info";
const REQUEST_TIMEOUT_MS = 1500;
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [200, 400, 800, 1200];

const EXPECTED_FIELDS = [
  "python_version",
  "python_implementation",
  "platform",
  "timestamp",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const buildError = (code, message, details) => {
  const error = {
    ok: false,
    error: { code, message },
  };
  if (details !== undefined) {
    error.error.details = details;
  }
  return error;
};

// Validate that the Flask payload carries every expected field as a
// non-empty string. Missing or mistyped fields are reported as an error
// instead of leaking partial data to the renderer.
const validateSystemInfo = (payload) => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return buildError(
      "INVALID_PAYLOAD",
      "System info payload must be an object.",
      { receivedType: Array.isArray(payload) ? "array" : typeof payload }
    );
  }
  const missing = [];
  const wrongType = [];
  EXPECTED_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) {
      missing.push(field);
    } else if (
      typeof payload[field] !== "string" ||
      payload[field].length === 0
    ) {
      wrongType.push(field);
    }
  });
  if (missing.length > 0 || wrongType.length > 0) {
    return buildError(
      "INVALID_PAYLOAD",
      "System info payload failed field validation.",
      { missing, wrongType }
    );
  }
  return {
    ok: true,
    data: {
      python_version: payload.python_version,
      python_implementation: payload.python_implementation,
      platform: payload.platform,
      timestamp: payload.timestamp,
    },
  };
};

// Single GET attempt with a hard timeout. Never rejects: every failure is
// converted into a structured error object.
const fetchSystemInfo = (url = API_URL, timeoutMs = REQUEST_TIMEOUT_MS) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const req = http.get(url, (res) => {
      const { statusCode } = res;
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        if (statusCode !== 200) {
          finish(
            buildError("HTTP_ERROR", "Flask returned a non-200 status.", {
              statusCode,
            })
          );
          return;
        }
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch (error) {
          finish(
            buildError("INVALID_JSON", "Flask response was not valid JSON.", {
              message: error.message,
            })
          );
          return;
        }
        finish(validateSystemInfo(payload));
      });
    });

    req.on("error", (error) => {
      finish(
        buildError("NETWORK_ERROR", "Could not reach the Flask backend.", {
          message: error.message,
        })
      );
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(
        buildError("TIMEOUT", "Flask backend did not respond in time.", {
          timeoutMs,
        })
      );
    });
  });

// The Flask subprocess may still be starting when the user clicks the
// button, so retry a bounded number of times with exponential backoff.
// Retriable failures: the server being unreachable, timeouts and HTTP 5xx.
const RETRIABLE_CODES = new Set(["NETWORK_ERROR", "TIMEOUT", "HTTP_5XX"]);

const fetchSystemInfoWithRetry = async (
  url = API_URL,
  maxAttempts = MAX_ATTEMPTS,
  delaysMs = RETRY_DELAYS_MS
) => {
  let lastResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await fetchSystemInfo(url);
    if (result.ok) {
      return result;
    }
    const code =
      result.error && result.error.code === "HTTP_ERROR" &&
      result.error.details &&
      result.error.details.statusCode >= 500
        ? "HTTP_5XX"
        : result.error && result.error.code;
    lastResult = result;
    if (attempt === maxAttempts || !RETRIABLE_CODES.has(code)) {
      break;
    }
    await sleep(delaysMs[attempt - 1] || delaysMs[delaysMs.length - 1]);
  }
  return {
    ...lastResult,
    error: { ...lastResult.error, retriesExhausted: true },
  };
};

// Register the ipcMain handler. ``electronIpcMain`` is injected so the
// bridge can be exercised outside of an Electron runtime as well.
const registerSystemInfoIpc = (ipcMain, channel = "system-info:get") => {
  ipcMain.handle(channel, async () => {
    try {
      return await fetchSystemInfoWithRetry();
    } catch (error) {
      return buildError("INTERNAL_ERROR", "Unexpected main process failure.", {
        message: error && error.message ? error.message : String(error),
      });
    }
  });
};

const runPackager = () => {
  const spawn = require("child_process").spawn;
  const ls = spawn(
    "pyinstaller",
    [
      "-w",
      "--onefile",
      `--add-data web_app/app/templates${path.delimiter}templates`,
      `--add-data web_app/app/static${path.delimiter}static`,
      `--add-data renderer.js${path.delimiter}renderer.js`,
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

module.exports = {
  API_URL,
  EXPECTED_FIELDS,
  buildError,
  validateSystemInfo,
  fetchSystemInfo,
  fetchSystemInfoWithRetry,
  registerSystemInfoIpc,
};

if (require.main === module) {
  runPackager();
}
