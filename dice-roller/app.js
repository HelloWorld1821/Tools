/* app.js —— 掷骰子页面交互，驱动 DiceScene 渲染 */
(function () {
  "use strict";

  const FACE_OPTIONS = [4, 6, 8, 10, 12, 20];
  const MIN_COUNT = 1;
  const MAX_COUNT = 12;
  const MAX_HISTORY = 15;
  const STORAGE_KEY = "diceRoller.history.v1";

  const facesEl = document.getElementById("faces");
  const countVal = document.getElementById("countVal");
  const minusBtn = document.getElementById("minusBtn");
  const plusBtn = document.getElementById("plusBtn");
  const tray = document.getElementById("tray");
  const trayHint = document.getElementById("trayHint");
  const result = document.getElementById("result");
  const rollBtn = document.getElementById("rollBtn");
  const historyBtn = document.getElementById("historyBtn");
  const history = document.getElementById("history");
  const historyList = document.getElementById("historyList");
  const clearBtn = document.getElementById("clearBtn");

  let faces = 6;
  let count = 1;
  let rolling = false;
  let historyData = loadHistory();

  const scene = new DiceScene(tray);
  scene.setup(faces, count);

  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) { /* 忽略损坏数据 */ }
    return [];
  }

  function saveHistory() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(historyData)); } catch (e) {}
  }

  function renderFaces() {
    facesEl.innerHTML = "";
    FACE_OPTIONS.forEach(f => {
      const btn = document.createElement("button");
      btn.className = "face-btn" + (f === faces ? " active" : "");
      btn.textContent = "D" + f;
      btn.addEventListener("click", () => {
        if (rolling || f === faces) return;
        faces = f;
        renderFaces();
        scene.setup(faces, count);
        result.classList.remove("show");
      });
      facesEl.appendChild(btn);
    });
  }

  function updateCount(next) {
    count = Math.min(MAX_COUNT, Math.max(MIN_COUNT, next));
    countVal.textContent = count;
    minusBtn.disabled = count <= MIN_COUNT;
    plusBtn.disabled = count >= MAX_COUNT;
    scene.setup(faces, count);
    result.classList.remove("show");
  }

  function roll() {
    if (rolling) return;
    rolling = true;
    rollBtn.disabled = true;
    minusBtn.disabled = true;
    plusBtn.disabled = true;
    rollBtn.textContent = "投掷中…";
    result.classList.remove("show");
    if (trayHint) trayHint.style.opacity = "0";

    const finals = [];
    for (let i = 0; i < count; i++) finals.push(Math.floor(Math.random() * faces) + 1);

    scene.roll(finals, () => finish(finals));
  }

  function finish(values) {
    const sum = values.reduce((a, b) => a + b, 0);
    result.innerHTML = (count === 1 ? "点数 " : "总点数 ") +
      `<span class="total">${sum}</span>`;
    result.classList.add("show");

    addHistory(values, sum);

    rolling = false;
    rollBtn.disabled = false;
    minusBtn.disabled = count <= MIN_COUNT;
    plusBtn.disabled = count >= MAX_COUNT;
    rollBtn.textContent = "🎲 再掷一次";
  }

  function addHistory(values, sum) {
    historyData.unshift({ faces, count, values: values.slice(), sum });
    if (historyData.length > MAX_HISTORY) historyData.length = MAX_HISTORY;
    saveHistory();
    renderHistory();
  }

  function renderHistory() {
    historyList.innerHTML = "";
    if (!historyData.length) {
      const empty = document.createElement("div");
      empty.className = "hist-empty";
      empty.textContent = "还没有记录，掷一次试试～";
      historyList.appendChild(empty);
      return;
    }
    historyData.forEach(rec => {
      const item = document.createElement("div");
      item.className = "hist-item";
      const rollsText = rec.count > 1 ? rec.values.join(" + ") : String(rec.values[0]);
      item.innerHTML =
        `<span class="tag">${rec.count}×D${rec.faces}</span>` +
        `<span class="rolls">${rollsText}</span>` +
        `<span class="sum">= ${rec.sum}</span>`;
      historyList.appendChild(item);
    });
  }

  function clearHistory() {
    if (!historyData.length) return;
    if (!confirm("确定清空全部投掷历史吗？")) return;
    historyData = [];
    saveHistory();
    renderHistory();
  }

  minusBtn.addEventListener("click", () => { if (!rolling) updateCount(count - 1); });
  plusBtn.addEventListener("click", () => { if (!rolling) updateCount(count + 1); });
  rollBtn.addEventListener("click", roll);
  historyBtn.addEventListener("click", () => {
    history.classList.toggle("show");
    historyBtn.textContent = history.classList.contains("show") ? "📜 收起" : "📜 历史";
  });
  clearBtn.addEventListener("click", clearHistory);

  renderFaces();
  updateCount(1);
  renderHistory();
})();
