"use strict";

// Browser side script (served by Flask at /renderer.js). Talks to the
// Electron main process exclusively through the preload-exposed window.api.
(function () {
  const EXPECTED_FIELDS = [
    "python_version",
    "python_implementation",
    "platform",
    "timestamp",
  ];

  // At most one request in flight. Repeated clicks reuse this same promise.
  let pendingPromise = null;

  const els = {};

  const hasValidData = (result) =>
    result &&
    result.ok === true &&
    typeof result.data === "object" &&
    result.data !== null &&
    EXPECTED_FIELDS.every(
      (field) =>
        typeof result.data[field] === "string" &&
        result.data[field].length > 0
    );

  const setState = (state) => {
    els.panel.dataset.state = state;
    els.loading.hidden = state !== "loading";
    els.success.hidden = state !== "success";
    els.error.hidden = state !== "error";
  };

  const renderSuccess = (data) => {
    els.resultVersion.textContent = data.python_version;
    els.resultImplementation.textContent = data.python_implementation;
    els.resultPlatform.textContent = data.platform;
    els.resultTimestamp.textContent = data.timestamp;
    setState("success");
  };

  const renderError = (result) => {
    const message =
      result &&
      result.error &&
      typeof result.error.message === "string" &&
      result.error.message
        ? result.error.message
        : "获取系统信息失败，请稍后重试。";
    els.errorMessage.textContent = message;
    setState("error");
  };

  const requestSystemInfo = () => {
    if (pendingPromise) {
      return pendingPromise;
    }
    if (!window.api || !window.api.systemInfo || !window.api.systemInfo.get) {
      renderError({
        ok: false,
        error: { message: "系统信息桥接 API 不可用。" },
      });
      return Promise.resolve();
    }

    els.button.disabled = true;
    setState("loading");

    pendingPromise = Promise.resolve()
      .then(() => window.api.systemInfo.get())
      .then((result) => {
        if (hasValidData(result)) {
          renderSuccess(result.data);
        } else {
          // Main process validation already catches bad payloads; this is
          // the renderer-side defense for malformed IPC responses.
          renderError(
            result && result.ok === false
              ? result
              : {
                  ok: false,
                  error: { message: "IPC 返回的数据格式不正确。" },
                }
          );
        }
      })
      .catch(() => {
        renderError({
          ok: false,
          error: { message: "IPC 调用失败，请重试。" },
        });
      })
      .finally(() => {
        pendingPromise = null;
        els.button.disabled = false;
      });

    return pendingPromise;
  };

  document.addEventListener("DOMContentLoaded", () => {
    els.panel = document.getElementById("system-info-panel");
    els.button = document.getElementById("system-info-button");
    if (!els.panel || !els.button) {
      return;
    }
    els.loading = document.getElementById("system-info-loading");
    els.success = document.getElementById("system-info-success");
    els.error = document.getElementById("system-info-error");
    els.errorMessage = document.getElementById("system-info-error-message");
    els.resultVersion = document.getElementById("result-python-version");
    els.resultImplementation = document.getElementById(
      "result-python-implementation"
    );
    els.resultPlatform = document.getElementById("result-platform");
    els.resultTimestamp = document.getElementById("result-timestamp");
    els.retryButtons = document.querySelectorAll(".js-system-info-retry");

    els.button.addEventListener("click", requestSystemInfo);
    els.retryButtons.forEach((retryButton) => {
      retryButton.addEventListener("click", requestSystemInfo);
    });
  });
})();
