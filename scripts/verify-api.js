"use strict";

// Verification entry point for `npm run verify:api`.
// 1. Boots the Flask backend on port 4040.
// 2. Asserts GET /api/system-info fields and types.
// 3. Shape-checks the preload-exposed contract.
// 4. Exercises the package_python.js IPC handler end to end, including
//    malformed payload rejection.

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const vm = require("vm");

const HOST = "127.0.0.1";
const PORT = 4040;
const BASE_URL = `http://${HOST}:${PORT}`;
const REPO_ROOT = path.join(__dirname, "..");

let failures = 0;
const checks = [];

const check = (name, condition, details) => {
  checks.push({ name, ok: Boolean(condition), details });
  if (!condition) {
    failures += 1;
  }
};

const request = (urlPath) =>
  new Promise((resolve, reject) => {
    const req = http.get(`${BASE_URL}${urlPath}`, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => resolve({ statusCode: res.statusCode, body: raw }));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("request timed out"));
    });
  });

const waitForPort = (timeoutMs) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const probe = () => {
      const socket = net.connect({ host: HOST, port: PORT });
      let done = false;
      const finish = (ready) => {
        if (done) return;
        done = true;
        socket.destroy();
        if (ready || Date.now() - startedAt >= timeoutMs) {
          resolve(ready);
        } else {
          setTimeout(probe, 200);
        }
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    };
    probe();
  });

const isPortFree = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(PORT, HOST);
  });

const killProcessTree = (child) => {
  if (!child || child.killed) return;
  const pid = child.pid;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      try {
        child.kill("SIGKILL");
      } catch (innerError) {
        /* already gone */
      }
    }
  }
};

const validatePreloadContract = () => {
  const preloadSource = fs.readFileSync(
    path.join(REPO_ROOT, "preload.js"),
    "utf8"
  );

  let exposedApi = null;
  const ipcHandlers = new Map();
  const fakeIpcRenderer = {
    invoke: (channel) => {
      if (!ipcHandlers.has(channel)) {
        return Promise.reject(new Error(`no handler for ${channel}`));
      }
      return ipcHandlers.get(channel)();
    },
  };
  const fakeElectron = {
    ipcRenderer: fakeIpcRenderer,
    contextBridge: {
      exposeInMainWorld: (name, value) => {
        if (name === "api") exposedApi = value;
      },
    },
  };

  const sandbox = {
    require: (moduleName) => {
      if (moduleName === "electron") return fakeElectron;
      throw new Error(`unexpected require: ${moduleName}`);
    },
    window: {},
    console,
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(preloadSource, sandbox, { filename: "preload.js" });

  check(
    "preload exposes window.api",
    exposedApi !== null && typeof exposedApi === "object",
    `received: ${typeof exposedApi}`
  );
  check(
    "window.api exposes exactly one namespace: systemInfo",
    exposedApi && Object.keys(exposedApi).join(",") === "systemInfo",
    exposedApi ? Object.keys(exposedApi).join(",") : "missing"
  );
  check(
    "api.systemInfo.get is a function",
    exposedApi &&
      typeof exposedApi.systemInfo === "object" &&
      Object.keys(exposedApi.systemInfo).join(",") === "get" &&
      typeof exposedApi.systemInfo.get === "function",
    "namespace shape mismatch"
  );

  return { exposedApi, ipcHandlers };
};

const validateIpcBridge = async (exposedApi, bridge, ipcHandlers) => {
  const handlers = new Map();
  const fakeIpcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
  };
  bridge.registerSystemInfoIpc(fakeIpcMain);

  check(
    "ipcMain.handle registers exactly one channel: system-info:get",
    handlers.size === 1 && handlers.has("system-info:get"),
    `channels: ${[...handlers.keys()].join(",")}`
  );

  const handler = handlers.get("system-info:get");
  const liveResult = await handler();
  check(
    "IPC handler returns ok result against live Flask",
    liveResult.ok === true &&
      typeof liveResult.data === "object" &&
      bridge.EXPECTED_FIELDS.every(
        (field) => typeof liveResult.data[field] === "string"
      ),
    JSON.stringify(liveResult)
  );

  const missingField = bridge.validateSystemInfo({
    python_version: "3.12.10",
    python_implementation: "CPython",
    platform: "Windows",
  });
  check(
    "missing timestamp field is treated as an error",
    missingField.ok === false &&
      missingField.error.code === "INVALID_PAYLOAD" &&
      Array.isArray(missingField.error.details.missing) &&
      missingField.error.details.missing.includes("timestamp"),
    JSON.stringify(missingField)
  );

  const wrongType = bridge.validateSystemInfo({
    python_version: 3,
    python_implementation: "CPython",
    platform: "Windows",
    timestamp: "2026-09-30T00:00:00+00:00",
  });
  check(
    "non-string python_version is treated as an error",
    wrongType.ok === false &&
      wrongType.error.code === "INVALID_PAYLOAD" &&
      wrongType.error.details.wrongType.includes("python_version"),
    JSON.stringify(wrongType)
  );

  const deadServer = await bridge.fetchSystemInfoWithRetry(
    "http://127.0.0.1:9/api/system-info",
    2,
    [10]
  );
  check(
    "unreachable backend yields structured error (never throws)",
    deadServer.ok === false &&
      typeof deadServer.error.code === "string" &&
      deadServer.error.retriesExhausted === true,
    JSON.stringify(deadServer)
  );

  let invokeValue = null;
  if (exposedApi && ipcHandlers.has("system-info:get")) {
    invokeValue = await exposedApi.systemInfo.get();
  }
  check(
    "preload get() resolves to the validated IPC result",
    invokeValue !== null && invokeValue.ok === true,
    JSON.stringify(invokeValue)
  );
};

const main = async () => {
  if (!(await isPortFree())) {
    console.error(`Port ${PORT} is already in use; aborting verify:api.`);
    process.exit(1);
  }

  const flask = spawn(
    process.platform === "win32" ? "python" : "python3",
    [path.join(REPO_ROOT, "web_app", "run_app.py")],
    {
      cwd: path.join(REPO_ROOT, "web_app"),
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    }
  );
  flask.stderr.on("data", () => {
    // Swallow Flask stderr; failures surface via the assertions below.
  });

  try {
    const ready = await waitForPort(20000);
    check("Flask backend starts and accepts connections", ready);
    if (!ready) {
      throw new Error("Flask did not start within 20s");
    }

    const response = await request("/api/system-info");
    check(
      "GET /api/system-info responds with HTTP 200",
      response.statusCode === 200,
      `status: ${response.statusCode}`
    );

    let payload = null;
    try {
      payload = JSON.parse(response.body);
      check("response body is valid JSON", true);
    } catch (error) {
      check("response body is valid JSON", false, error.message);
    }

    if (payload) {
      const fieldExpectations = [
        ["python_version", "string"],
        ["python_implementation", "string"],
        ["platform", "string"],
        ["timestamp", "string"],
      ];
      fieldExpectations.forEach(([field, type]) => {
        check(
          `field ${field} is a non-empty ${type}`,
          typeof payload[field] === type && payload[field].length > 0,
          `received: ${JSON.stringify(payload[field])}`
        );
      });
      check(
        "payload contains no unexpected top-level fields",
        Object.keys(payload)
          .sort()
          .join(",") === fieldExpectations.map(([f]) => f).sort().join(","),
        Object.keys(payload).join(",")
      );

      const timestamp = Date.parse(payload.timestamp);
      check(
        "timestamp parses as an ISO-8601 date",
        !Number.isNaN(timestamp),
        payload.timestamp
      );
      const ageSeconds = Math.abs(Date.now() - timestamp) / 1000;
      check(
        "timestamp is current (within 120s)",
        ageSeconds < 120,
        `age: ${ageSeconds.toFixed(1)}s`
      );
    }

    const rendererAsset = await request("/renderer.js");
    check(
      "GET /renderer.js serves the browser renderer",
      rendererAsset.statusCode === 200 &&
        rendererAsset.body.includes("system-info-button"),
      `status: ${rendererAsset.statusCode}`
    );

    const homePage = await request("/");
    check(
      "home page renders with HTTP 200",
      homePage.statusCode === 200,
      `status: ${homePage.statusCode}`
    );
    [
      ['id="system-info-button"', "system info button is present"],
      ["获取系统信息", "button label is rendered"],
      ['id="system-info-loading"', "loading state is present"],
      ['id="system-info-success"', "success state is present"],
      ['id="system-info-error"', "error state is present"],
      ["js-system-info-retry", "retry controls are present"],
      ['src="/renderer.js"', "renderer script is wired into the page"],
    ].forEach(([needle, label]) => {
      check(label, homePage.body.includes(needle));
    });

    const { exposedApi, ipcHandlers } = validatePreloadContract();
    check(
      "preload contract captured api bridge",
      exposedApi && typeof exposedApi.systemInfo.get === "function"
    );
    const bridge = require(path.join(REPO_ROOT, "package_python.js"));
    bridge.registerSystemInfoIpc({
      handle: (channel, handler) => ipcHandlers.set(channel, handler),
    });
    check(
      "preload invokes the registered system-info:get channel",
      ipcHandlers.has("system-info:get")
    );
    await validateIpcBridge(exposedApi, bridge, ipcHandlers);
  } finally {
    killProcessTree(flask);
  }

  checks.forEach((item) => {
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}`);
    if (!item.ok && item.details) {
      console.log(`        ${item.details}`);
    }
  });

  if (failures > 0) {
    console.error(`\nverify:api failed: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nverify:api passed: ${checks.length} checks.`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
