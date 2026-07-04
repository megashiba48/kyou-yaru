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
  if (error) {
    $("#auth-msg").textContent = "送信できませんでした: " + error.message;
    return;
  }
  $("#otp-area").classList.remove("hidden");
  $("#auth-msg").textContent = "メールを送りました";
});

$("#auth-verify").addEventListener("click", async () => {
  const raw = $("#auth-link").value.trim();
  if (!raw) return;
  let token_hash, type;
  try {
    const u = new URL(raw);
    token_hash = u.searchParams.get("token") || u.searchParams.get("token_hash");
    type = u.searchParams.get("type") || "magiclink";
  } catch {
    $("#auth-msg").textContent = "リンクの形が読めません。メールのリンクを丸ごとコピーして貼ってください";
    return;
  }
  if (!token_hash) {
    $("#auth-msg").textContent = "リンクにログイン情報が見つかりません";
    return;
  }
  $("#auth-msg").textContent = "確認中…";
  const { error } = await sb.auth.verifyOtp({ token_hash, type });
  if (error) $("#auth-msg").textContent = "期限切れかもしれません。もう一度メールを送ってやり直してください(" + error.message + ")";
  // 成功時は onAuthStateChange がアプリ画面へ切り替える
});

let signedIn = false;
sb.auth.onAuthStateChange((_event, session) => {
  signedIn = !!session;
  if (session) { show("app-view"); refresh(); }
  else show("auth-view");
});

// アプリが前面に戻ったら最新を読み直す(受信箱の新着などを反映)
let lastRefresh = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && signedIn && Date.now() - lastRefresh > 20000) {
    refresh();
  }
});

// ---------- データ取得 ----------
let state = { tasks: [], routines: [], logs: [], done: [] };

async function loadAll() {
  const since14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const [t, r, l, d, f, g] = await Promise.all([
    sb.from("tasks").select("*").eq("status", "open").order("created_at"),
    sb.from("routines").select("*").eq("active", true),
    sb.from("routine_log").select("*").eq("on_date", todayStr()),
    sb.from("tasks").select("*").eq("status", "done").order("done_at", { ascending: false }).limit(1000),
    sb.from("focus_log").select("on_date").gte("on_date", since14),
    sb.from("goals").select("*").order("created_at"),
  ]);
  state = { tasks: t.data || [], routines: r.data || [], logs: l.data || [], done: d.data || [],
    focus: f.data || [], goals: g.data || [] };
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

// 今日の実行候補(タスク+今日のルーティン)。top3フラグ付きでスコア順に返す
function todayPool() {
  const skips = getSkips();
  const laters = getLaters();
  const dow = new Date().getDay();
  const t3 = getTop3();
  const items = [];
  for (const t of state.tasks) {
    items.push({ kind: "task", id: t.id, name: t.name, minutes: t.minutes,
      deadline: t.deadline, priority: t.priority, postpone_count: t.postpone_count,
      top3: t3.includes(t.id) });
  }
  for (const r of state.routines) {
    if (!r.days.includes(dow)) continue;
    if (state.logs.some((l) => l.routine_id === r.id)) continue; // 今日済み/スキップ済み
    items.push({ kind: "routine", id: r.id, name: r.name, minutes: r.minutes,
      deadline: null, priority: 2, postpone_count: 0, top3: false });
  }
  const visible = items.filter((i) => !skips.includes(i.id));
  visible.sort((a, b) => {
    const la = laters.includes(a.id) ? 1 : 0;
    const lb = laters.includes(b.id) ? 1 : 0;
    if (la !== lb) return la - lb;
    return score(b) - score(a) || (a.minutes || 99) - (b.minutes || 99);
  });
  return visible;
}

// TOP3(端末内保存・その日限り)
const top3Key = () => `top3:${todayStr()}`;
const getTop3 = () => JSON.parse(localStorage.getItem(top3Key()) || "[]");
const setTop3 = (ids) => localStorage.setItem(top3Key(), JSON.stringify(ids.slice(0, 3)));
function toggleTop3(id) {
  let ids = getTop3();
  if (ids.includes(id)) ids = ids.filter((x) => x !== id);
  else { if (ids.length >= 3) return; ids.push(id); }
  setTop3(ids);
}

function metaText(i) {
  const parts = [];
  if (i.kind === "routine") parts.push("ルーティン");
  if (i.minutes) parts.push(`目安${i.minutes}分`);
  if (i.deadline) parts.push(i.deadline === todayStr() ? "締切今日" : `締切${i.deadline.slice(5).replace("-", "/")}`);
  return parts.join("・") || "　";
}

// 今すぐ1個
let nowOneId = null;
let nowOneMode = "priority";
function pickNowOne(pool) {
  const t3 = pool.filter((i) => i.top3);
  const cands = t3.length ? t3 : pool;
  if (!cands.length) { nowOneId = null; return; }
  nowOneId = nowOneMode === "random"
    ? cands[Math.floor(Math.random() * cands.length)].id
    : cands[0].id;
}

const byId = (pool, id) => pool.find((i) => i.id === id);

async function completeItem(i) {
  if (i.kind === "task") {
    await sb.from("tasks").update({ status: "done", done_at: new Date().toISOString() }).eq("id", i.id);
    setTop3(getTop3().filter((x) => x !== i.id));
  } else {
    await sb.from("routine_log").insert({ routine_id: i.id, on_date: todayStr(), result: "done" });
  }
  if (nowOneId === i.id) nowOneId = null;
  await refresh();
}

function renderToday() {
  const d = new Date();
  $("#today-date").textContent = `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
  const pool = todayPool();
  $("#today-empty").classList.toggle("hidden", pool.length > 0);

  renderTop3(pool);
  if (!nowOneId || !pool.some((i) => i.id === nowOneId)) pickNowOne(pool);
  renderNowOne(pool);
  renderBlank();
  renderRest(pool);
  updatePomoTask(pool);
}

function renderTop3(pool) {
  const box = $("#top3");
  box.innerHTML = "";
  const t3 = getTop3().map((id) => byId(pool, id)).filter(Boolean);
  for (let s = 0; s < 3; s++) {
    const i = t3[s];
    const slot = document.createElement("div");
    slot.className = "top3-slot" + (i ? "" : " empty");
    if (i) {
      slot.innerHTML = `<div class="t3-name">${s + 1}. ${esc(i.name)}${i.postpone_count >= 3 ? '<span class="warn"> ・3回見送り</span>' : ""}</div>
        <div class="t3-btns"><button class="done-b primary">完了</button><button class="off-b ghost">外す</button></div>`;
      slot.querySelector(".done-b").addEventListener("click", () => completeItem(i));
      slot.querySelector(".off-b").addEventListener("click", () => { toggleTop3(i.id); renderToday(); });
    } else {
      slot.innerHTML = `<button class="add-b ghost">＋ ${s + 1}枠目に入れる</button>`;
      slot.querySelector(".add-b").addEventListener("click", () => openTop3Picker(pool));
    }
    box.appendChild(slot);
  }
}

function openTop3Picker(pool) {
  const cands = pool.filter((i) => i.kind === "task" && !i.top3);
  const box = $("#top3");
  const picker = document.createElement("div");
  picker.className = "t3-picker";
  picker.innerHTML = cands.length
    ? `<p class="muted">TOP3に入れるタスクを選ぶ:</p>` +
      cands.map((i) => `<button type="button" data-id="${i.id}">${esc(i.name)}</button>`).join("") +
      `<button type="button" class="cancel-b ghost">やめる</button>`
    : `<p class="muted">入れられるタスクがありません。タスクタブで追加してください。</p><button type="button" class="cancel-b ghost">閉じる</button>`;
  box.appendChild(picker);
  picker.querySelector(".cancel-b").addEventListener("click", () => renderToday());
  picker.querySelectorAll("button[data-id]").forEach((b) => {
    b.addEventListener("click", () => { toggleTop3(b.dataset.id); renderToday(); });
  });
}

function renderNowOne(pool) {
  const box = $("#now-one");
  const i = nowOneId ? byId(pool, nowOneId) : null;
  if (!i) { box.innerHTML = `<p class="muted">タスクがありません。タスクタブで足すと、ここに1個ハイライトされます。</p>`; return; }
  box.innerHTML = `
    <div class="now-card">
      <div class="now-name">${esc(i.name)}</div>
      <div class="now-meta">${metaText(i)}</div>
      <div class="row now-actions">
        <button class="done-btn primary">やった ✅</button>
        <button class="later-btn">あとで</button>
      </div>
      <div class="row now-repick">
        <span class="muted">選び直す:</span>
        <button class="rp-pri ghost">優先度順</button>
        <button class="rp-rnd ghost">ランダム</button>
      </div>
    </div>`;
  box.querySelector(".done-btn").addEventListener("click", () => completeItem(i));
  box.querySelector(".later-btn").addEventListener("click", () => { addLater(i.id); nowOneId = null; renderToday(); });
  box.querySelector(".rp-pri").addEventListener("click", () => { nowOneMode = "priority"; nowOneId = null; renderToday(); });
  box.querySelector(".rp-rnd").addEventListener("click", () => { nowOneMode = "random"; nowOneId = null; renderToday(); });
}

function renderRest(pool) {
  const t3ids = getTop3();
  const rest = pool.filter((i) => !t3ids.includes(i.id) && i.id !== nowOneId);
  const ul = $("#today-rest");
  ul.innerHTML = "";
  for (const i of rest) {
    const li = document.createElement("li");
    const canTop3 = i.kind === "task" && t3ids.length < 3;
    li.innerHTML = `<span class="name">${esc(i.name)}</span><span class="meta">${metaText(i)}</span>
      ${canTop3 ? '<button class="t3-b">TOP3</button>' : ""}<button class="done-b2">完了</button>`;
    if (canTop3) li.querySelector(".t3-b").addEventListener("click", () => { toggleTop3(i.id); renderToday(); });
    li.querySelector(".done-b2").addEventListener("click", () => completeItem(i));
    ul.appendChild(li);
  }
}

// 余白ブロック(何もしない時間・端末内保存)
const getBlank = () => JSON.parse(localStorage.getItem("blank") || '{"start":"13:00","min":30}');
function addMinutes(hhmm, min) {
  const [h, m] = hhmm.split(":").map(Number);
  const t = h * 60 + m + min;
  return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
function renderBlank() {
  const b = getBlank();
  $("#blank-block").innerHTML = `
    <div class="blank-card">
      <span>🌙 余白 ${b.start}–${addMinutes(b.start, b.min)}(${b.min}分・何もしない)</span>
      <button class="edit-b ghost">変更</button>
    </div>`;
  $("#blank-block .edit-b").addEventListener("click", () => {
    $("#blank-block").innerHTML = `
      <div class="blank-card row">
        <input type="time" class="bs" value="${b.start}">
        <input type="number" class="bm" min="5" step="5" value="${b.min}" style="width:64px">分
        <button class="save-b primary">保存</button>
      </div>`;
    $("#blank-block .save-b").addEventListener("click", () => {
      const start = $("#blank-block .bs").value || "13:00";
      const min = Number($("#blank-block .bm").value) || 30;
      localStorage.setItem("blank", JSON.stringify({ start, min }));
      renderBlank();
    });
  });
}

// ---------- ポモドーロ ----------
const WORK_SEC = 25 * 60, BREAK_SEC = 5 * 60;
let pomo = { phase: "work", remaining: WORK_SEC, running: false, endsAt: 0 };
const pomoKey = () => `pomo:${todayStr()}`;
const pomoCount = () => Number(localStorage.getItem(pomoKey()) || 0);
const pomoInc = () => localStorage.setItem(pomoKey(), pomoCount() + 1);
const fmtSec = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

function updatePomo() {
  const el = $("#pomodoro");
  if (!el) return;
  el.classList.toggle("work", pomo.phase === "work");
  el.classList.toggle("break", pomo.phase === "break");
  $("#pomo-phase").textContent = pomo.phase === "work" ? "作業" : "休憩";
  $("#pomo-time").textContent = fmtSec(pomo.remaining);
  $("#pomo-toggle").textContent = pomo.running ? "一時停止" : "開始";
  $("#pomo-count").textContent = `今日 ${pomoCount()}セット`;
}

function updatePomoTask(pool) {
  const i = nowOneId && pool ? byId(pool, nowOneId) : null;
  const el = $("#pomo-task");
  if (el) el.textContent = i ? "▶ " + i.name : "紐付けなし(今すぐ1個に自動連動)";
}

function beep() {
  if (localStorage.getItem("pomoSound") === "off") return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); o.stop(ctx.currentTime + 0.25);
  } catch (e) { /* 無音でよい */ }
}

function pomoAdvance(natural) {
  const wasWork = pomo.phase === "work";
  if (natural) { if (wasWork) { pomoInc(); logFocusSet(); } beep(); }
  pomo.phase = wasWork ? "break" : "work";
  pomo.remaining = pomo.phase === "work" ? WORK_SEC : BREAK_SEC;
  pomo.endsAt = Date.now() + pomo.remaining * 1000; // 自動で次フェーズへ
  updatePomo();
}

setInterval(() => {
  if (!pomo.running) return;
  const left = Math.max(0, Math.round((pomo.endsAt - Date.now()) / 1000));
  pomo.remaining = left;
  if (left <= 0) pomoAdvance(true);
  else updatePomo();
}, 500);

$("#pomo-toggle").addEventListener("click", () => {
  if (pomo.running) {
    pomo.remaining = Math.max(0, Math.round((pomo.endsAt - Date.now()) / 1000));
    pomo.running = false;
  } else {
    pomo.endsAt = Date.now() + pomo.remaining * 1000;
    pomo.running = true;
  }
  updatePomo();
});
$("#pomo-skip").addEventListener("click", () => pomoAdvance(false));
$("#pomo-sound").addEventListener("click", () => {
  const off = localStorage.getItem("pomoSound") === "off";
  localStorage.setItem("pomoSound", off ? "on" : "off");
  $("#pomo-sound").textContent = off ? "🔔" : "🔕";
});
if (localStorage.getItem("pomoSound") === "off") $("#pomo-sound").textContent = "🔕";
updatePomo();

// ---------- タスクタブ ----------
const DELEGATE_COLORS = { "近藤": "#0e9f6e", "榊原": "#d97706", "竹市": "#7c3aed" };
let taskFilter20 = false;
let taskCatFilter = "";

$("#task-delegate-on").addEventListener("change", (e) => {
  $("#task-delegate").classList.toggle("hidden", !e.target.checked);
});
document.querySelectorAll(".mins-chips button[data-min]").forEach((b) => {
  b.addEventListener("click", () => {
    $("#task-minutes").value = b.dataset.min;
    document.querySelectorAll(".mins-chips button[data-min]").forEach((x) => x.classList.toggle("on", x === b));
  });
});
$("#filter-20").addEventListener("click", () => {
  taskFilter20 = !taskFilter20;
  $("#filter-20").classList.toggle("on", taskFilter20);
  renderTasks();
});

$("#task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#task-name").value.trim();
  if (!name) return;
  const delegate = $("#task-delegate-on").checked ? $("#task-delegate").value : null;
  await sb.from("tasks").insert({
    name,
    priority: Number($("#task-priority").value),
    minutes: $("#task-minutes").value ? Number($("#task-minutes").value) : null,
    deadline: $("#task-deadline").value || null,
    category: $("#task-category").value || null,
    focus_needed: $("#task-focus").checked,
    delegate,
  });
  e.target.reset();
  $("#task-delegate").classList.add("hidden");
  document.querySelectorAll(".mins-chips button[data-min]").forEach((x) => x.classList.remove("on"));
  await refresh();
});

// 時間帯レコメンド(今の時刻に合わせて出すだけ)
function renderTimeReco() {
  const box = $("#time-reco");
  if (!box) return;
  const h = new Date().getHours();
  const focus = state.tasks.filter((t) => t.focus_needed);
  const light = state.tasks.filter((t) => (t.minutes && t.minutes <= 20) || t.delegate);
  let cls, msg, list;
  if (h >= 8 && h < 10) {
    cls = "reco reco-focus"; msg = "🌅 朝の集中タイム。重い『集中タスク』をどうぞ。"; list = focus;
  } else if (h >= 19 && h < 21) {
    cls = "reco reco-focus"; msg = "🌙 夜の集中タイム(21時まで)。重い『集中タスク』を。"; list = focus;
  } else if (h >= 12 && h < 15) {
    cls = "reco reco-light"; msg = "🥱 昼は一番しんどい時間。軽いタスク・委任タスクを。集中タスクは朝か夜に。"; list = light;
  } else {
    cls = "reco reco-neutral"; msg = "淡々とTOP3を進める時間帯。"; list = [];
  }
  box.className = cls;
  box.innerHTML = `<div class="reco-msg">${msg}</div>` +
    (list.length ? `<div class="reco-list">${list.slice(0, 5).map((t) => `<span>・${esc(t.name)}</span>`).join("")}</div>` : "");
}

function renderTasks() {
  renderTimeReco();
  // カテゴリ絞り込みチップ
  const cats = [...new Set(state.tasks.map((t) => t.category).filter(Boolean))];
  const cf = $("#cat-filter");
  cf.innerHTML = "";
  for (const c of cats) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (taskCatFilter === c ? " on" : "");
    b.textContent = c;
    b.addEventListener("click", () => { taskCatFilter = taskCatFilter === c ? "" : c; renderTasks(); });
    cf.appendChild(b);
  }

  const ul = $("#task-list");
  ul.innerHTML = "";
  const pr = { 1: "高", 2: "中", 3: "低" };
  let list = state.tasks;
  if (taskFilter20) list = list.filter((t) => t.minutes && t.minutes <= 20);
  if (taskCatFilter) list = list.filter((t) => t.category === taskCatFilter);
  for (const t of list) {
    const li = document.createElement("li");
    if (t.delegate) { li.classList.add("delegated"); li.style.setProperty("--tag", DELEGATE_COLORS[t.delegate] || "#888"); }
    if (t.category === "嫌い") li.classList.add("hate");
    const badges = [
      t.category ? `<span class="badge cat">${esc(t.category)}</span>` : "",
      t.delegate ? `<span class="badge dg">🤝${esc(t.delegate)}</span>` : "",
      t.focus_needed ? `<span class="badge fc">🎯</span>` : "",
    ].join("");
    li.innerHTML = `<span class="name editable">${esc(t.name)} ${badges}</span>
      <span class="meta">${pr[t.priority]}${t.minutes ? "・" + t.minutes + "分" : ""}${t.deadline ? "・〆" + t.deadline.slice(5).replace("-", "/") : ""}${t.postpone_count ? "・見送り" + t.postpone_count : ""}</span>
      ${t.category === "嫌い" ? '<button class="hate-b">30分</button>' : ""}
      <button class="edit-b">編集</button><button class="done-b">完了</button><button class="danger del-b">削除</button>`;
    li.querySelector(".name").addEventListener("click", () => openTaskEditor({ task: t }));
    li.querySelector(".edit-b").addEventListener("click", () => openTaskEditor({ task: t }));
    if (t.category === "嫌い") li.querySelector(".hate-b").addEventListener("click", () => startFocus30(t.name));
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

// 嫌いなことを30分だけ集中して片付けるタイマー
let f30 = { endsAt: 0, name: "", timer: null };
function startFocus30(name) {
  f30.endsAt = Date.now() + 30 * 60 * 1000;
  f30.name = name;
  clearInterval(f30.timer);
  f30.timer = setInterval(renderFocus30, 1000);
  renderFocus30();
}
function renderFocus30() {
  const box = $("#focus30");
  if (!box) return;
  if (!f30.endsAt) { box.innerHTML = ""; return; }
  const left = Math.max(0, Math.round((f30.endsAt - Date.now()) / 1000));
  if (left <= 0) {
    clearInterval(f30.timer); beep();
    box.innerHTML = `<div class="f30 done">✅ 30分完了:${esc(f30.name)}<button class="x-b">閉じる</button></div>`;
    box.querySelector(".x-b").onclick = () => { f30.endsAt = 0; renderFocus30(); };
    return;
  }
  box.innerHTML = `<div class="f30"><span>😤 30分だけ集中:${esc(f30.name)}</span><span class="t">${fmtSec(left)}</span><button class="x-b">やめる</button></div>`;
  box.querySelector(".x-b").onclick = () => { f30.endsAt = 0; clearInterval(f30.timer); renderFocus30(); };
}

// 実績(完了タスクの振り返り)
function renderDone() {
  const doneDate = (t) => {
    const d = new Date(t.done_at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const today = todayStr();
  const weekAgo = new Date(Date.now() - 6 * 86400000);
  const todayCount = state.done.filter((t) => doneDate(t) === today).length;
  const weekCount = state.done.filter((t) => new Date(t.done_at) >= weekAgo).length;
  $("#done-summary").textContent = state.done.length
    ? `今日 ${todayCount}件 / 直近7日 ${weekCount}件 / 記録上 ${state.done.length}件`
    : "まだありません。タスクを完了するとここに貯まります。";

  const box = $("#done-list");
  box.innerHTML = "";
  const groups = new Map();
  for (const t of state.done) {
    const key = doneDate(t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  for (const [date, items] of [...groups.entries()].slice(0, 30)) {
    const d = new Date(date + "T00:00:00");
    const div = document.createElement("div");
    div.className = "done-group";
    div.innerHTML = `<div class="done-date">${date === today ? "今日" : date.slice(5).replace("-", "/") + "(" + WEEKDAYS[d.getDay()] + ")"} — ${items.length}件</div>` +
      items.map((t) => {
        const hm = new Date(t.done_at);
        return `<div class="done-item">✅ ${esc(t.name)} <span class="meta">${String(hm.getHours()).padStart(2, "0")}:${String(hm.getMinutes()).padStart(2, "0")}</span></div>`;
      }).join("");
    box.appendChild(div);
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

// ---------- タイムバケット ----------
const HORIZONS = { "1y": "1年以内", "3y": "3年以内", "5y": "5年以内", "10y": "10年以内", "life": "死ぬまでに" };
let bucketItems = [];
let bucketFilter = "all";
let myProfile = null;

async function loadBucket() {
  try {
    const [p, b] = await Promise.all([
      sb.from("profile").select("*").maybeSingle(),
      sb.from("bucket_items").select("*").order("created_at"),
    ]);
    if (p.error) throw new Error("profile: " + p.error.message);
    if (b.error) throw new Error("bucket_items: " + b.error.message);
    myProfile = p.data;
    bucketItems = b.data || [];
    $("#life-setup").classList.toggle("hidden", !!myProfile?.birthdate);
    $("#life-view").classList.toggle("hidden", !myProfile?.birthdate);
    if (myProfile?.birthdate) drawLifeGrid();
    renderBucketChips();
    renderBucketList();
  } catch (err) {
    $("#bucket-list").innerHTML = `<p class="muted">⚠読み込みエラー: ${esc(err.message)}</p>`;
  }
}

$("#birthdate-save").addEventListener("click", async () => {
  const bd = $("#birthdate").value;
  if (!bd) return;
  const { data: { user } } = await sb.auth.getUser();
  await sb.from("profile").upsert({ user_id: user.id, birthdate: bd }, { onConflict: "user_id" });
  await loadBucket();
});

function drawLifeGrid() {
  const lifeYears = myProfile.life_years || 85;
  const born = new Date(myProfile.birthdate + "T00:00:00");
  const now = new Date();
  const weeksLived = Math.floor((now - born) / (7 * 86400000));
  const totalWeeks = lifeYears * 52;
  const age = Math.floor((now - born) / (365.25 * 86400000));
  const weeksLeft = Math.max(0, totalWeeks - weeksLived);
  const pct = Math.min(100, Math.round((weeksLived / totalWeeks) * 1000) / 10);
  $("#life-stats").innerHTML =
    `いま${age}歳 — 残り <b class="big">${lifeYears - age}年</b>(約${weeksLeft.toLocaleString()}週)`;
  $("#life-fill").style.width = pct + "%";
  $("#life-meter-label").textContent = `${lifeYears}歳までのゲージ:${pct}%経過・残り${Math.round((100 - pct) * 10) / 10}%`;
}

function renderBucketChips() {
  const box = $("#bucket-chips");
  box.innerHTML = "";
  const counts = {};
  for (const b of bucketItems) counts[b.horizon] = (counts[b.horizon] || 0) + 1;
  for (const [key, label] of [["all", "全部"], ...Object.entries(HORIZONS)]) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (bucketFilter === key ? " on" : "");
    chip.textContent = key === "all" ? `${label} ${bucketItems.length}` : `${label} ${counts[key] || 0}`;
    chip.addEventListener("click", () => { bucketFilter = key; renderBucketChips(); renderBucketList(); });
    box.appendChild(chip);
  }
}

$("#bucket-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const content = $("#bucket-name").value.trim();
  if (!content) return;
  await sb.from("bucket_items").insert({ content, horizon: $("#bucket-horizon").value });
  e.target.reset();
  await loadBucket();
});

function renderBucketList() {
  const ul = $("#bucket-list");
  ul.innerHTML = "";
  const items = bucketItems
    .filter((b) => bucketFilter === "all" || b.horizon === bucketFilter)
    .sort((a, b) => a.achieved - b.achieved);
  if (!items.length) {
    ul.innerHTML = `<p class="muted">まだありません。思いついたら書き殴ってOK。</p>`;
    return;
  }
  for (const b of items) {
    const li = document.createElement("li");
    if (b.achieved) li.className = "done";
    li.innerHTML = `<span class="name">${b.achieved ? "🏆 " : ""}${esc(b.content)}</span>
      <span class="meta">${HORIZONS[b.horizon] || ""}</span>
      <button class="ach-b">${b.achieved ? "戻す" : "達成!"}</button>
      <button class="danger del-b">削除</button>`;
    li.querySelector(".ach-b").addEventListener("click", async () => {
      await sb.from("bucket_items").update({ achieved: !b.achieved }).eq("id", b.id);
      await loadBucket();
    });
    li.querySelector(".del-b").addEventListener("click", async () => {
      if (!confirm(`「${b.content}」を削除しますか?`)) return;
      await sb.from("bucket_items").delete().eq("id", b.id);
      await loadBucket();
    });
    ul.appendChild(li);
  }
}

// ---------- 受信箱(Obsidian・アイデア1件=1カード) ----------
let inboxNotes = [];

async function loadInbox() {
  try {
    const { data, error } = await sb.from("inbox_notes").select("*")
      .eq("state", "new").order("modified_at", { ascending: false }).limit(200);
    if (error) throw new Error(error.message);
    inboxNotes = data || [];
    renderInbox();
  } catch (err) {
    $("#inbox-list").innerHTML = `<p class="muted">⚠読み込みエラー: ${esc(err.message)}</p>`;
  }
}

function renderInbox() {
  const box = $("#inbox-list");
  box.innerHTML = "";
  if (!inboxNotes.length) {
    box.innerHTML = `<p class="muted">新しいアイデアはありません。Obsidianに1行書くと、次の同期でここに1件ずつ届きます。</p>`;
    return;
  }
  for (const n of inboxNotes) {
    const card = document.createElement("div");
    card.className = "inbox-card";
    card.innerHTML = `
      <p class="idea">💡 ${esc(n.content)}</p>
      <div class="row">
        <button type="button" class="task-b primary">タスクにする</button>
        <button type="button" class="arch-b">アーカイブ</button>
      </div>`;
    card.querySelector(".task-b").addEventListener("click", () => {
      openTaskEditor({
        name: n.content.slice(0, 100),
        source: "inbox",
        onSaved: async () => { await sb.from("inbox_notes").update({ state: "tasked" }).eq("id", n.id); },
      });
    });
    card.querySelector(".arch-b").addEventListener("click", async () => {
      await sb.from("inbox_notes").update({ state: "archived" }).eq("id", n.id);
      await loadInbox();
    });
    box.appendChild(card);
  }
}

// ---------- 実績タブ ----------
function logFocusSet() {
  sb.auth.getUser().then(({ data }) => {
    if (data?.user) sb.from("focus_log").insert({ user_id: data.user.id, on_date: todayStr(), task_id: nowOneId || null });
  });
}

const dstr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function weekStartStr() {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // 月曜=0
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return dstr(d);
}

function renderResults() {
  renderAtBat();
  renderActivity14();
  renderGlory();
  renderGoals();
  renderDone();
}

function renderAtBat() {
  const ws = weekStartStr();
  const days = new Set();
  for (const t of state.done) if (t.done_at && t.done_at.slice(0, 10) >= ws) days.add(t.done_at.slice(0, 10));
  for (const f of (state.focus || [])) if (f.on_date >= ws) days.add(f.on_date);
  $("#atbat").innerHTML = `<div class="atbat-card">
    <div class="ab-label">今週の打席数</div>
    <div class="ab-num">${days.size}<span>打席</span></div>
    <div class="ab-note muted">1日1つでも完了 or ポモ1セットで打席+1。途切れてもリセットしません。</div>
  </div>`;
}

function renderActivity14() {
  const counts = {};
  for (const t of state.done) if (t.done_at) { const ds = t.done_at.slice(0, 10); counts[ds] = (counts[ds] || 0) + 1; }
  for (const f of (state.focus || [])) counts[f.on_date] = (counts[f.on_date] || 0) + 1;
  const days = [];
  let max = 1;
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const c = counts[dstr(d)] || 0;
    max = Math.max(max, c);
    days.push({ d, c });
  }
  $("#activity14").innerHTML = `<div class="bars">` + days.map((x) => {
    const h = Math.round((x.c / max) * 100);
    return `<div class="bar-col"><div class="bar${x.c ? "" : " zero"}" style="height:${x.c ? Math.max(10, h) : 4}%"></div><div class="bar-d">${x.d.getDate()}</div></div>`;
  }).join("") + `</div>`;
}

function renderGlory() {
  const tally = {};
  for (const t of state.done) { const c = t.category || "その他"; tally[c] = (tally[c] || 0) + 1; }
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const box = $("#glory");
  if (!entries.length) { box.innerHTML = `<p class="muted">完了タスクが貯まると、カテゴリ別にここへ積み上がります。</p>`; return; }
  const top = entries[0][1];
  box.innerHTML = entries.map(([c, n]) =>
    `<div class="glory-row"><span class="g-cat">${esc(c)}</span><span class="g-bar-wrap"><span class="g-bar" style="width:${Math.round((n / top) * 100)}%"></span></span><span class="g-num">${n}</span></div>`
  ).join("");
}

$("#goal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("#goal-title").value.trim();
  if (!title) return;
  const threshold = Math.min(100, Math.max(1, Number($("#goal-threshold").value) || 75));
  await sb.from("goals").insert({ title, threshold, progress: 0 });
  e.target.reset();
  $("#goal-threshold").value = 75;
  await refresh();
});

function renderGoals() {
  const box = $("#goal-list");
  box.innerHTML = "";
  if (!state.goals.length) { box.innerHTML = `<p class="muted">目標はまだありません。75%で成功、完璧じゃなくていい。</p>`; return; }
  for (const g of state.goals) {
    const ok = g.progress >= g.threshold;
    const div = document.createElement("div");
    div.className = "goal" + (ok ? " ok" : "");
    div.innerHTML = `
      <div class="goal-top"><span class="goal-title">${ok ? "✅ " : ""}${esc(g.title)}</span><span class="goal-pct">${g.progress}%</span></div>
      <div class="goal-bar"><div class="goal-fill" style="width:${Math.min(100, g.progress)}%"></div><div class="goal-line" style="left:${g.threshold}%"></div></div>
      <div class="row goal-ctl">
        <input type="range" min="0" max="100" value="${g.progress}" class="gr">
        <button class="save-b ghost">保存</button>
        <button class="del-b danger">削除</button>
      </div>`;
    const range = div.querySelector(".gr");
    range.addEventListener("input", () => {
      div.querySelector(".goal-pct").textContent = range.value + "%";
      div.querySelector(".goal-fill").style.width = Math.min(100, range.value) + "%";
    });
    div.querySelector(".save-b").addEventListener("click", async () => {
      await sb.from("goals").update({ progress: Number(range.value) }).eq("id", g.id);
      await refresh();
    });
    div.querySelector(".del-b").addEventListener("click", async () => {
      if (!confirm(`目標「${g.title}」を削除しますか?`)) return;
      await sb.from("goals").delete().eq("id", g.id);
      await refresh();
    });
    box.appendChild(div);
  }
}

// ---------- タスク編集モーダル(新規タスク化・後から編集の共通画面) ----------
let teCtx = null; // { task?, source?, onSaved? }
function openTaskEditor(opts = {}) {
  teCtx = opts;
  const t = opts.task || {};
  $("#te-title").textContent = opts.task ? "タスクを編集" : "タスクにする";
  $("#te-name").value = opts.name ?? t.name ?? "";
  $("#te-priority").value = String(t.priority || 2);
  $("#te-category").value = t.category || "";
  $("#te-deadline").value = t.deadline || "";
  $("#te-minutes").value = t.minutes || "";
  $("#te-focus").checked = !!t.focus_needed;
  const dg = t.delegate || "";
  $("#te-delegate-on").checked = !!dg;
  $("#te-delegate").classList.toggle("hidden", !dg);
  if (dg) $("#te-delegate").value = dg;
  $("#te-delete").classList.toggle("hidden", !opts.task);
  $("#task-editor").classList.remove("hidden");
  $("#te-name").focus();
}
function closeTaskEditor() { $("#task-editor").classList.add("hidden"); teCtx = null; }

$("#te-delegate-on").addEventListener("change", (e) => $("#te-delegate").classList.toggle("hidden", !e.target.checked));
$("#task-editor").querySelectorAll(".te-mins button[data-min]").forEach((b) => {
  b.addEventListener("click", () => { $("#te-minutes").value = b.dataset.min; });
});
$("#te-cancel").addEventListener("click", closeTaskEditor);
$("#task-editor").addEventListener("click", (e) => { if (e.target.id === "task-editor") closeTaskEditor(); });
$("#te-save").addEventListener("click", async () => {
  if (!teCtx) return;
  const name = $("#te-name").value.trim();
  if (!name) { $("#te-name").focus(); return; }
  const fields = {
    name,
    priority: Number($("#te-priority").value),
    category: $("#te-category").value || null,
    deadline: $("#te-deadline").value || null,
    minutes: $("#te-minutes").value ? Number($("#te-minutes").value) : null,
    focus_needed: $("#te-focus").checked,
    delegate: $("#te-delegate-on").checked ? $("#te-delegate").value : null,
  };
  if (teCtx.task) {
    await sb.from("tasks").update(fields).eq("id", teCtx.task.id);
  } else {
    await sb.from("tasks").insert({ ...fields, source: teCtx.source || "braindump" });
    if (teCtx.onSaved) await teCtx.onSaved();
  }
  closeTaskEditor();
  await refresh();
});
$("#te-delete").addEventListener("click", async () => {
  if (!teCtx || !teCtx.task) return;
  if (!confirm(`「${teCtx.task.name}」を削除しますか?`)) return;
  await sb.from("tasks").update({ status: "dropped" }).eq("id", teCtx.task.id);
  closeTaskEditor();
  await refresh();
});

// ---------- アイデア:ブレインダンプ ----------
$("#braindump").value = localStorage.getItem("braindump") || "";
$("#braindump").addEventListener("input", () => localStorage.setItem("braindump", $("#braindump").value));
$("#bd-tasks").addEventListener("click", () => {
  const lines = $("#braindump").value.split("\n").map((l) => l.trim()).filter((l) => l.length >= 2);
  const box = $("#bd-picker");
  if (!lines.length) { box.innerHTML = `<p class="muted">先にアイデアを書いてください。</p>`; return; }
  box.innerHTML = `<p class="muted">行をタップ→優先度・いつやる等を決めてタスク化(タスク化した行はダンプから消えます):</p>` +
    lines.map((l, i) => `<button type="button" class="bd-line" data-i="${i}">${esc(l)}</button>`).join("");
  box.querySelectorAll(".bd-line").forEach((b) => {
    b.addEventListener("click", () => {
      const line = lines[Number(b.dataset.i)];
      openTaskEditor({
        name: line.slice(0, 100),
        source: "braindump",
        onSaved: async () => {
          const remaining = $("#braindump").value.split("\n").filter((l) => l.trim() !== line);
          $("#braindump").value = remaining.join("\n");
          localStorage.setItem("braindump", $("#braindump").value);
          b.remove();
        },
      });
    });
  });
});

// ---------- 運用:連絡タイム + 週一人会議 ----------
const getSlots = () => JSON.parse(localStorage.getItem("contactSlots") || "[]");
const setSlots = (a) => localStorage.setItem("contactSlots", JSON.stringify(a.slice(0, 2)));
let ctFilterOn = false;

function nowHM() {
  const n = new Date();
  return `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`;
}
function nowInSlot() {
  const hm = nowHM();
  return getSlots().some((s) => s.start <= hm && hm <= s.end);
}

$("#ct-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const start = $("#ct-start").value, end = $("#ct-end").value;
  if (!start || !end) return;
  const a = getSlots();
  if (a.length >= 2) { alert("連絡タイムは1日2枠までがおすすめです。"); return; }
  a.push({ start, end });
  a.sort((x, y) => x.start.localeCompare(y.start));
  setSlots(a);
  e.target.reset();
  renderOps();
});
$("#ct-filter").addEventListener("click", () => {
  ctFilterOn = !ctFilterOn;
  $("#ct-filter").classList.toggle("on", ctFilterOn);
  renderContact();
});

function renderOps() { renderContact(); renderSolo(); }

function renderContact() {
  const inSlot = nowInSlot();
  $("#contact-status").innerHTML = inSlot
    ? `<div class="ct-on">🟢 連絡タイムです。まとめて返信しましょう。</div>`
    : `<div class="ct-off">連絡は指定時間にまとめて。今は連絡タスクを目立たせません。</div>`;

  const slots = getSlots();
  const cs = $("#contact-slots");
  cs.innerHTML = slots.length
    ? slots.map((s, i) => `<div class="ct-slot">🕐 ${s.start}–${s.end}<button class="del-slot ghost" data-i="${i}">削除</button></div>`).join("")
    : `<p class="muted">まだ枠がありません。1日1〜2枠がおすすめ(例:12:00–12:30 / 20:00–20:20)。</p>`;
  cs.querySelectorAll(".del-slot").forEach((b) => b.addEventListener("click", () => {
    const a = getSlots(); a.splice(Number(b.dataset.i), 1); setSlots(a); renderOps();
  }));

  const box = $("#ct-list");
  if (!(ctFilterOn || inSlot)) { box.innerHTML = ""; return; }
  const tasks = state.tasks.filter((t) => t.category === "連絡");
  box.innerHTML = tasks.length
    ? `<ul class="list">` + tasks.map((t) => `<li data-id="${t.id}"><span class="name">📮 ${esc(t.name)}</span><button class="done-c">完了</button></li>`).join("") + `</ul>`
    : `<p class="muted">連絡カテゴリのタスクはありません。</p>`;
  box.querySelectorAll(".done-c").forEach((b) => b.addEventListener("click", async () => {
    await sb.from("tasks").update({ status: "done", done_at: new Date().toISOString() }).eq("id", b.closest("li").dataset.id);
    await refresh();
  }));
}

const soloKey = () => `solo:${weekStartStr()}`;
const getSolo = () => JSON.parse(localStorage.getItem(soloKey()) || '{"when":"","fun":""}');
function renderSolo() {
  const s = getSolo();
  $("#solo-meeting").innerHTML = `
    <div class="solo-card">
      <p class="muted">今週の一人会議(1人で考える時間)、いつやる?</p>
      <input id="solo-when" placeholder="例:土曜の朝、カフェで" value="${esc(s.when)}">
      <p class="muted">今週やりたい楽しいこと</p>
      <input id="solo-fun" placeholder="例:サウナ / 映画" value="${esc(s.fun)}">
      <div class="row"><button id="solo-save" class="primary">保存</button><span id="solo-msg" class="muted"></span></div>
    </div>`;
  $("#solo-save").addEventListener("click", () => {
    localStorage.setItem(soloKey(), JSON.stringify({ when: $("#solo-when").value, fun: $("#solo-fun").value }));
    $("#solo-msg").textContent = "保存しました ✅";
    setTimeout(() => { const m = $("#solo-msg"); if (m) m.textContent = ""; }, 2500);
  });
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
  lastRefresh = Date.now();
  await loadAll();
  renderToday();
  renderTasks();
  renderRoutines();
  renderResults();
  renderOps();
  await Promise.all([loadBucket(), loadInbox()]);
}

// ---------- Service Worker ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
