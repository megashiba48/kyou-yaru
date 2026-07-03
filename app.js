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
  const [t, r, l, d] = await Promise.all([
    sb.from("tasks").select("*").eq("status", "open").order("created_at"),
    sb.from("routines").select("*").eq("active", true),
    sb.from("routine_log").select("*").eq("on_date", todayStr()),
    sb.from("tasks").select("*").eq("status", "done").order("done_at", { ascending: false }).limit(300),
  ]);
  state = { tasks: t.data || [], routines: r.data || [], logs: l.data || [], done: d.data || [] };
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
    card.querySelector(".task-b").addEventListener("click", async () => {
      await sb.from("tasks").insert({ name: n.content.slice(0, 100), source: "inbox" });
      await sb.from("inbox_notes").update({ state: "tasked" }).eq("id", n.id);
      await refresh();
    });
    card.querySelector(".arch-b").addEventListener("click", async () => {
      await sb.from("inbox_notes").update({ state: "archived" }).eq("id", n.id);
      await loadInbox();
    });
    box.appendChild(card);
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
  lastRefresh = Date.now();
  await loadAll();
  renderToday();
  renderTasks();
  renderRoutines();
  renderDone();
  await Promise.all([loadBucket(), loadInbox()]);
}

// ---------- Service Worker ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
