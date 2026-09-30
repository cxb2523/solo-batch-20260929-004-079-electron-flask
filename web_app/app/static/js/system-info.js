"use strict";

(function () {
  const button = document.getElementById("system-info-btn");
  const result = document.getElementById("system-info-result");
  if (!button || !result) return;

  let inflight = null;

  const setState = (state, content) => {
    result.dataset.state = state;
    result.innerHTML = "";
    if (content) result.appendChild(content);
  };

  const renderLoading = () => {
    const text = document.createElement("p");
    text.className = "system-info-loading";
    text.textContent = "加载中…";
    setState("loading", text);
  };

  const renderSuccess = (data) => {
    const list = document.createElement("dl");
    list.className = "system-info-data";
    const entries = [
      ["Python 版本", data.python_version],
      ["实现", data.implementation],
      ["平台", data.platform],
      ["时间戳", data.timestamp],
    ];
    entries.forEach(([label, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      list.appendChild(dt);
      list.appendChild(dd);
    });
    setState("success", list);
  };

  const renderError = (error) => {
    const wrapper = document.createElement("div");
    wrapper.className = "system-info-error";
    const message = document.createElement("p");
    message.textContent = `获取失败（${error.code}）：${error.message}`;
    const hint = document.createElement("p");
    hint.className = "system-info-retry-hint";
    hint.textContent = "可点击按钮重试。";
    wrapper.appendChild(message);
    wrapper.appendChild(hint);
    setState("error", wrapper);
  };

  const fetchSystemInfo = () => {
    if (inflight) return inflight; // 复用在途请求，忽略重复点击
    button.disabled = true;
    renderLoading();
    inflight = window.api
      .getSystemInfo()
      .then((response) => {
        if (response && response.ok) {
          renderSuccess(response.data);
        } else {
          const error = (response && response.error) || {
            code: "UNKNOWN",
            message: "未知错误",
          };
          renderError(error);
        }
      })
      .catch((err) => {
        renderError({ code: "IPC_FAILURE", message: String(err) });
      })
      .finally(() => {
        inflight = null;
        button.disabled = false; // 失败（或成功）后允许再次点击/重试
      });
    return inflight;
  };

  button.addEventListener("click", fetchSystemInfo);
})();
