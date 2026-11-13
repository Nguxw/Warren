// The shell's own page, shown while the daemon is not running. It asks the shell to connect
// every few seconds and offers the same Chinese/English choice as the main interface.
const TEXT = {
  zh: {
    title: "Warren 守护进程未运行",
    body: "Warren 的工作由后台守护进程完成。请在终端中运行以下任一命令：",
    service: "开机自动运行（推荐）",
    foreground: "只在当前终端中运行",
    retrying: "守护进程启动后会自动连接…",
    retry: "立即重试",
    switch: "English",
  },
  en: {
    title: "The Warren daemon is not running",
    body: "Warren's work is done by a background daemon. Start it from a terminal with either command:",
    service: "Start at login (recommended)",
    foreground: "Run in this terminal only",
    retrying: "Connecting automatically once the daemon is up…",
    retry: "Retry now",
    switch: "中文",
  },
};

let lang = "zh";
try {
  lang = localStorage.getItem("warren.lang") === "en" ? "en" : "zh";
} catch {}

function render() {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = TEXT[lang][node.dataset.i18n];
  }
  document.getElementById("lang").textContent = TEXT[lang].switch;
}

function connect() {
  window.__TAURI__?.core.invoke("connect").catch(() => {});
}

document.getElementById("retry").addEventListener("click", connect);
document.getElementById("lang").addEventListener("click", () => {
  lang = lang === "zh" ? "en" : "zh";
  try {
    localStorage.setItem("warren.lang", lang);
  } catch {}
  render();
});

render();
setInterval(connect, 3000);
