// 今日やる — Phase 0+1(器+タスク管理+候補3つ)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const $ = (sel) => document.querySelector(sel);
const cfg = window.APP_CONFIG || {};
const configured = cfg.SUPABASE_URL?.startsWith("https://") && cfg.SUPABASE_ANON_KEY?.length > 20;

// ---------- 画面切り替え ----------
function show(viewId) {
  for (const id of ["auth-view", "setup-view", "app-view"]) {
    $("#" + id).classList.toggle("hidden", id !== viewId);
  }
}

if (!configured) {
  show("setup-view");
  throw new Error("config.js 未設定");
}

const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

// ---------- 日付ユーティリティ ----------
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// 「今日はやらない」の記録(端末ローカル・その日限り)
const skipKey = () => `skip:${todayStr()}`;
const getSkips = () => JSON.parse(localStorage.getItem(skipKey()) || "[]");
const addSkip = (id) => localStorage.setItem(skipKey(), JSON.stringify([...getSkips(), id]));
// 「あとで」の後回し記録(その日限り・候補の並びを下げる)
const laterKey = () => `later:${todayStr()}`;
const getLaters = () => JSON.parse(localStorage.getItem(laterKey()) || "[]");
const addLater = (id) => localStorage.setItem(laterKey(), JSON.stringify([...getLaters(), id]));

// ---------- 認証 ----------
$("#auth-send").addEventListener("click", async () => {
  const email = $("#auth-email").value.trim();
  if (!email) return;
  $("#auth-msg").textContent = "送信中…";
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin + location.pathname },
  });
  $("#auth-msg").textContent = error
    ? "送信できませんでした: " + error.message
    : "メールを確認して、届いたリンクを開いてください(この端末で開くとログイン完了)";
});

sb.auth.onAuthStateChange((_event, session) => {
  if (session) { show("app-view"); refresh(); }
  else show("auth-view");
});

// ---------- データ取得 ----------
let state = { tasks: [], routines: [], logs: [] };

async function loadAll() {
  const [t, r, l] = await Promise.all([
    sb.from("tasks").select("*").eq("status", "open").order("created_at"),
    sb.from("routines").select("*").eq("active", true),
    sb.from("routine_log").select("*").eq("on_date", todayStr()),
  ]);
  state = { tasks: t.data || [], routines: r.data || [], logs: l.data || [] };
}

// ---------- 「今日の候補」スコア ----------
// 大きいほど先。締切の近さ > 優先度 > 放置ペナルティ > 短時間優遇
function score(item) {
  let s = 0;
  if (item.kind === "task") {
    if (item.deadline) {
      const days = (new Date(item.deadline) - new Date(todayStr())) / 86400000;
      if (days < 0) s += 120;          // 期限切れ
      else if (days === 0) s += 100;   // 今日締切
      else if (days <= 2) s += 60;
      else if (days <= 7) s += 30;
    }
    s += (4 - item.priority) * 20;              // 高=60 中=40 低=20
    s += Math.min(item.postpone_count, 5) * 8;  // 放置するほど浮上
  } else {
    s += 50; // ルーティンは「毎日の約束」として中程度で浮上
  }
  if (item.minutes && item.minutes <= 15) s += 10; // 着手しやすいものを少し上げる
  return s;
}

// 今日の実行候補リスト(タスク+今日のルーティン)を作る
function buildTodayItems() {
  const skips = getSkips();
  const laters = getLaters();
  const dow = new Date().getDay();
  const items = [];
  for (const t of state.tasks) {
    items.push({ kind: "task", id: t.id, name: t.name, minutes: t.minutes,
      deadline: t.deadline, priority: t.priority, postpone_count: t.postpone_count });
  }
  for (const r of state.routines) {
    if (!r.days.includes(dow)) continue;
    if (state.logs.some((l) => l.routine_id === r.id)) continue; // 今日済み/スキップ済み
    items.push({ kind: "routine", id: r.id, name: r.name, minutes: r.minutes,
      deadline: null, priority: 2, postpone_count: 0 });
  }
  const visible = items.filter((i) => !skips.includes(i.id));
  visible.sort((a, b) => {
    const la = laters.includes(a.id) ? 1 : 0;
    const lb = laters.includes(b.id) ? 1 : 0;
    if (la !== lb) return la - lb;               // 「あとで」した物は後ろへ
    return score(b) - score(a) || (a.minutes || 99) - (b.minutes || 99);
  });
  return visible;
}

// ---------- 今日タブ描画 ----------
let focused = null; // 選択中の1件

function metaText(i) {
  const parts = [];
  if (i.kind === "routine") parts.push("ルーティン");
  if (i.minutes) parts.push(`目安${i.minutes}分`);
  if (i.deadline) parts.push(i.deadline === todayStr() ? "締切今日" : `締切${i.deadline.slice(5).replace("-", "/")}`);
  return parts.join("・") || "　";
}

function renderToday() {
  const d = new Date();
  $("#today-date").textContent = `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
  const items = buildTodayItems();

  $("#today-empty").classList.toggle("hidden", items.length > 0);
  $("#pick3-area").classList.toggle("hidden", !!focused || items.length === 0);
  $("#focus-area").classList.toggle("hidden", !focused);

  // 候補3枚
  const pick3 = $("#pick3");
  pick3.innerHTML = "";
  for (const i of items.slice(0, 3)) {
    const card = document.createElement("div");
    card.className = "pick-card";
    card.innerHTML = `<div class="name">${esc(i.name)}${i.postpone_count >= 3 ? '<div class="warn">3回見送り中 — やめる?分割する?</div>' : ""}</div>
      <div class="meta">${metaText(i)}</div>`;
    card.addEventListener("click", () => { focused = i; renderToday(); });
    pick3.appendChild(card);
  }

  // フォーカスカード
  if (focused) {
    $("#focus-card").innerHTML = `
      <div class="name">${esc(focused.name)}</div>
      <div class="meta">${metaText(focused)}</div>
      <div class="actions">
        <button class="done-btn">やった ✅</button>
        <button class="later-btn">あとで</button>
        <button class="skip-btn">今日はやらない</button>
      </div>`;
    $("#focus-card .done-btn").addEventListener("click", () => act("done"));
    $("#focus-card .later-btn").addEventListener("click", () => act("later"));
    $("#focus-card .skip-btn").addEventListener("click", () => act("skip"));
  }

  // 残りリスト
  const rest = $("#today-rest");
  rest.innerHTML = "";
  for (const i of items.slice(focused ? 0 : 3)) {
    if (focused && i.id === focused.id) continue;
    const li = document.createElement("li");
    li.innerHTML = `<span class="name">${esc(i.name)}</span><span class="meta">${metaText(i)}</span>`;
    li.addEventListener("click", () => { focused = i; renderToday(); });
    rest.appendChild(li);
  }
}

async function act(action) {
  const i = focused;
  if (!i) return;
  if (action === "done") {
    if (i.kind === "task") {
      await sb.from("tasks").update({ status: "done", done_at: new Date().toISOString() }).eq("id", i.id);
    } else {
      await sb.from("routine_log").insert({ routine_id: i.id, on_date: todayStr(), result: "done" });
    }
  } else if (action === "later") {
    addLater(i.id);
  } else if (action === "skip") {
    addSkip(i.id);
    if (i.kind === "task") {
      await sb.from("tasks").update({ postpone_count: i.postpone_count + 1 }).eq("id", i.id);
    } else {
      await sb.from("routine_log").insert({ routine_id: i.id, on_date: todayStr(), result: "skip" });
    }
  }
  focused = null;
  await refresh();
}

// ---------- タスクタブ ----------
$("#task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#task-name").value.trim();
  if (!name) return;
  await sb.from("tasks").insert({
    name,
    priority: Number($("#task-priority").value),
    minutes: $("#task-minutes").value ? Number($("#task-minutes").value) : null,
    deadline: $("#task-deadline").value || null,
  });
  e.target.reset();
  await refresh();
});

function renderTasks() {
  const ul = $("#task-list");
  ul.innerHTML = "";
  const pr = { 1: "高", 2: "中", 3: "低" };
  for (const t of state.tasks) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="name">${esc(t.name)}</span>
      <span class="meta">${pr[t.priority]}${t.minutes ? "・" + t.minutes + "分" : ""}${t.deadline ? "・〆" + t.deadline.slice(5).replace("-", "/") : ""}${t.postpone_count ? "・見送り" + t.postpone_count : ""}</span>
      <button class="done-b">完了</button><button class="danger del-b">削除</button>`;
    li.querySelector(".done-b").addEventListener("click", async () => {
      await sb.from("tasks").update({ status: "done", done_at: new Date().toISOString() }).eq("id", t.id);
      await refresh();
    });
    li.querySelector(".del-b").addEventListener("click", async () => {
      if (!confirm(`「${t.name}」を削除しますか?`)) return;
      await sb.from("tasks").update({ status: "dropped" }).eq("id", t.id);
      await refresh();
    });
    ul.appendChild(li);
  }
}

// ルーティン
const daysBox = $("#routine-days");
WEEKDAYS.forEach((w, idx) => {
  const label = document.createElement("label");
  label.textContent = w;
  label.className = idx !== 0 && idx !== 6 ? "on" : ""; // 平日デフォルトON
  label.dataset.day = idx;
  label.addEventListener("click", () => label.classList.toggle("on"));
  daysBox.appendChild(label);
});

$("#routine-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#routine-name").value.trim();
  if (!name) return;
  const days = [...daysBox.querySelectorAll("label.on")].map((l) => Number(l.dataset.day));
  await sb.from("routines").insert({
    name,
    days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
    minutes: $("#routine-minutes").value ? Number($("#routine-minutes").value) : null,
  });
  e.target.reset();
  await refresh();
});

function renderRoutines() {
  const ul = $("#routine-list");
  ul.innerHTML = "";
  for (const r of state.routines) {
    const li = document.createElement("li");
    const daysTxt = r.days.length === 7 ? "毎日" : r.days.map((d) => WEEKDAYS[d]).join("");
    li.innerHTML = `<span class="name">${esc(r.name)}</span>
      <span class="meta">${daysTxt}${r.minutes ? "・" + r.minutes + "分" : ""}</span>
      <button class="danger del-b">削除</button>`;
    li.querySelector(".del-b").addEventListener("click", async () => {
      if (!confirm(`ルーティン「${r.name}」を削除しますか?`)) return;
      await sb.from("routines").update({ active: false }).eq("id", r.id);
      await refresh();
    });
    ul.appendChild(li);
  }
}

// ---------- タブ切り替え ----------
document.querySelectorAll("#tabbar button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#tabbar button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tab").forEach((t) => t.classList.add("hidden"));
    $("#tab-" + b.dataset.tab).classList.remove("hidden");
  });
});

// ---------- 共通 ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function refresh() {
  await loadAll();
  renderToday();
  renderTasks();
  renderRoutines();
}

// ---------- Service Worker ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
