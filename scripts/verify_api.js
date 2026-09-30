"use strict";

// verify:api — starts the Flask backend, asserts /api/system-info returns
// the expected fields with the expected types, and shape-checks the preload
// bridge contract. Exits 0 on success, 1 on any failure.

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const BASE_URL = process.env.FLASK_BASE_URL || "http://localhost:4040";
const STARTUP_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 300;

const failures = [];
const check = (condition, label) => {
  if (condition) {
    console.log(`  ok - ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL - ${label}`);
  }
};

const getJson = (url) =>
  new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(3000, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });

const waitForBackend = async () => {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return await getJson(`${BASE_URL}/api/system-info`);
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
  throw new Error(`Flask backend not ready within ${STARTUP_TIMEOUT_MS}ms`);
};

const verifyApiShape = ({ statusCode, body }) => {
  console.log("Checking /api/system-info response...");
  check(statusCode === 200, "HTTP status is 200");
  check(body !== null && typeof body === "object", "response is a JSON object");
  check(typeof body.python_version === "string", "python_version is a string");
  check(typeof body.implementation === "string", "implementation is a string");
  check(typeof body.platform === "string", "platform is a string");
  check(typeof body.timestamp === "string", "timestamp is a string");
  check(
    typeof body.timestamp === "string" && !Number.isNaN(Date.parse(body.timestamp)),
    "timestamp is an ISO-8601 parseable string"
  );
};

const verifyPreloadContract = () => {
  console.log("Checking preload bridge contract...");
  const preloadPath = path.join(ROOT, "preload.js");
  check(fs.existsSync(preloadPath), "preload.js exists");

  const exposed = {};
  const invokedChannels = [];
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld: (key, value) => {
        exposed[key] = value;
      },
    },
    ipcRenderer: {
      invoke: (channel, ...args) => {
        invokedChannels.push(channel);
        return Promise.resolve({ ok: true, data: {} });
      },
    },
  };

  const sandbox = {
    require: Module.createRequire(preloadPath),
    module: { exports: {} },
    exports: {},
    __dirname: path.dirname(preloadPath),
    __filename: preloadPath,
    console,
    process,
  };
  const originalRequire = sandbox.require;
  sandbox.require = (id) => (id === "electron" ? fakeElectron : originalRequire(id));

  let loaded = true;
  try {
    vm.runInNewContext(fs.readFileSync(preloadPath, "utf8"), sandbox, {
      filename: preloadPath,
    });
  } catch (error) {
    loaded = false;
    console.error(`  preload evaluation error: ${error.message}`);
  }
  check(loaded, "preload.js evaluates without electron installed");

  const api = exposed.api;
  check(api !== null && typeof api === "object", "window.api is exposed");
  check(api && typeof api.getSystemInfo === "function", "api.getSystemInfo is a function");

  if (api && typeof api.getSystemInfo === "function") {
    const result = api.getSystemInfo();
    check(
      result && typeof result.then === "function",
      "api.getSystemInfo() returns a Promise"
    );
    check(
      invokedChannels.length === 1 && invokedChannels[0] === "system-info:get",
      "getSystemInfo invokes IPC channel 'system-info:get'"
    );
    return result;
  }
  return Promise.resolve();
};

const main = async () => {
  const flask = spawn("python", [path.join(ROOT, "web_app", "run_app.py")], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  flask.stderr.on("data", (data) => process.stderr.write(`[flask] ${data}`));

  try {
    const response = await waitForBackend();
    verifyApiShape(response);
    await verifyPreloadContract();
  } catch (error) {
    failures.push(error.message);
    console.error(`  FAIL - ${error.message}`);
  } finally {
    flask.kill();
  }

  if (failures.length > 0) {
    console.error(`\nverify:api failed (${failures.length} check(s))`);
    process.exit(1);
  }
  console.log("\nverify:api passed");
  process.exit(0);
};

main();
