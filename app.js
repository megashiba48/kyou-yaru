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

// ---------- シンプルモード(意思決定ツール版) ----------
// 「今日やる3つ」と「バケット」以外をUIから隠すだけ。DB・関数は一切消していないので、
// バケットタブ下のスイッチでいつでも全機能に戻せる。
const SIMPLE_KEY = "simpleMode";
let simpleMode = localStorage.getItem(SIMPLE_KEY) !== "off";

// ---------- 日付ユーティリティ ----------
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// ---------- その日の状態(TOP3/スキップ/あとで) ----------
// DB(day_state)で端末間同期する。PCで組んだTOP3がスマホでも同じに見える。
// day_stateテーブル未作成や読み込み失敗時は従来のlocalStorage動作(端末ごと)に自動フォールバック。
let dayState = null; // 同期が効いている時だけ非null
let uid = null;      // day_state保存に使うユーザーID
const lsGet = (k) => JSON.parse(localStorage.getItem(k) || "[]");
const skipKey = () => `skip:${todayStr()}`;
const laterKey = () => `later:${todayStr()}`;
const top3Key = () => `top3:${todayStr()}`;
const getSkips = () => (dayState ? dayState.skips : lsGet(skipKey()));
const getLaters = () => (dayState ? dayState.laters : lsGet(laterKey()));
const getTop3 = () => (dayState ? dayState.top3 : lsGet(top3Key()));
function setDayPart(part, arr) {
  const key = { top3: top3Key(), skips: skipKey(), laters: laterKey() }[part];
  localStorage.setItem(key, JSON.stringify(arr)); // オフライン保険で常に端末にも残す
  if (dayState) { dayState[part] = arr; pushDayState(); }
}
const addSkip = (id) => setDayPart("skips", [...getSkips(), id]);
const setTop3 = (ids) => setDayPart("top3", ids.slice(0, 3));
// 「あとで」を積む口(addLater)は「今すぐやる1個」と一緒に撤去(2026-07-28)。
// getLaters は残す=今日すでに「あとで」した分の並び順は最後まで効かせる。

async function loadDayState() {
  try {
    const { data, error } = await sb.from("day_state")
      .select("top3,skips,laters").eq("on_date", todayStr()).maybeSingle();
    if (error) { dayState = null; return; } // テーブル未作成など → localStorage動作
    if (data) {
      dayState = { top3: data.top3 || [], skips: data.skips || [], laters: data.laters || [] };
    } else {
      // 今日の行がまだない → この端末のlocalStorage分を初期値として持ち上げる
      dayState = { top3: lsGet(top3Key()), skips: lsGet(skipKey()), laters: lsGet(laterKey()) };
      if (dayState.top3.length || dayState.skips.length || dayState.laters.length) await pushDayState();
    }
  } catch { dayState = null; }
}
async function pushDayState() {
  if (!dayState || !uid) return;
  await sb.from("day_state").upsert({
    user_id: uid, on_date: todayStr(),
    top3: dayState.top3, skips: dayState.skips, laters: dayState.laters,
    updated_at: new Date().toISOString(),
  });
}

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
  uid = session?.user?.id || null;
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
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [t, r, l, d, f, g] = await Promise.all([
    sb.from("tasks").select("*").eq("status", "open").order("created_at"),
    sb.from("routines").select("*"),
    sb.from("routine_log").select("*").gte("on_date", since30),
    sb.from("tasks").select("*").eq("status", "done").order("done_at", { ascending: false }).limit(1000),
    sb.from("focus_log").select("*").gte("on_date", new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10)),
    sb.from("goals").select("*").order("created_at"),
    loadDayState(),
  ]);
  const routinesAll = r.data || [];
  const rlogs = l.data || [];
  state = { tasks: t.data || [], routinesAll, routines: routinesAll.filter((x) => x.active),
    rlogs, logs: rlogs.filter((x) => x.on_date === todayStr()), done: d.data || [],
    focus: f.data || [], goals: g.data || [] };
  // delegated_at列がまだ無いDBでも壊れないように、列の有無を実データから判定
  state.hasDelegatedAt = [...state.tasks, ...state.done].some((x) => "delegated_at" in x);
  // goals.target_value/unit の有無を実際に問い合わせて判定(行が0件でも正しく判定できる)
  const probe = await sb.from("goals").select("target_value").limit(1);
  state.hasGoalTarget = !probe.error;
}

// ルーティンの放置日数(昨日から遡り、予定曜日なのに記録がない日を数える。記録=完了/休みどちらでも可)
function missedDays(r) {
  const created = (r.created_at || "").slice(0, 10);
  let missed = 0;
  for (let i = 1; i <= 30; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const ds = dstr(d);
    if (created && ds < created) break;
    if (!r.days.includes(d.getDay())) continue;
    if (state.rlogs.some((l) => l.routine_id === r.id && l.on_date === ds)) break;
    missed++;
  }
  return missed;
}

// ルーティンの完了記録(実績カウント用)
// ルーティンの実施記録。実績(打席数・栄光リスト・14日グラフ)には入れない
// = 習慣は「一目で確認するだけ」にする(2026-07-26 賢大の判断)
const routineDones = () => (state.rlogs || []).filter((l) => l.result === "done");

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
    s += Math.min(item.missed || 0, 5) * 8; // 放置するほど浮上
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
      deadline: null, priority: 2, postpone_count: 0, top3: t3.includes(r.id), missed: missedDays(r) });
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

// TOP3(その日限り。保存はday_state同期/フォールバックはlocalStorage)
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

// 「今すぐやる1個」は撤去(2026-07-28 賢大の判断)。TOP3と役割が重複していた。
// 併せて「あとで」ボタンも消えた(このカードにしか無かったため)。

const byId = (pool, id) => pool.find((i) => i.id === id);

async function completeItem(i) {
  if (i.kind === "task") {
    await sb.from("tasks").update({ status: "done", done_at: new Date().toISOString() }).eq("id", i.id);
  } else {
    await sb.from("routine_log").insert({ routine_id: i.id, on_date: todayStr(), result: "done" });
  }
  setTop3(getTop3().filter((x) => x !== i.id)); // ルーティンも完了したらTOP3枠を空ける
  await refresh();
}

// ルーティンを今日は休む(実績には数えないが、放置扱いにもしない)
async function restRoutine(id) {
  await sb.from("routine_log").insert({ routine_id: id, on_date: todayStr(), result: "rest" });
  setTop3(getTop3().filter((x) => x !== id)); // 休んだルーティンもTOP3枠を空ける
  await refresh();
}

// 放置警告バッジ(⚠N日放置)は撤去(2026-07-28 賢大の判断)。
// ルーティンは実績に数えない=責める道具にしない方針(2026-07-26)と揃える。
// 「見て分かる」用の直近7日ストリップ(●◐○)はタスクタブに残っている。

function renderToday() {
  const d = new Date();
  $("#today-date").textContent = `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
  const pool = todayPool();
  $("#today-empty").classList.toggle("hidden", pool.length > 0);

  renderTop3(pool);
  renderRest(pool);
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
      slot.innerHTML = `<div class="t3-name">${s + 1}. ${i.kind === "routine" ? "🔁 " : ""}${esc(i.name)}${i.postpone_count >= 3 ? '<span class="warn"> ・3回見送り</span>' : ""}</div>
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

// シンプルモードでは候補をまずタスクだけに絞る(ルーティン17本が混ざると"消化"に戻るため)
let pickerRoutines = false;
function openTop3Picker(pool) {
  const cands = pool.filter((i) => !i.top3);
  const routines = cands.filter((i) => i.kind === "routine");
  const list = simpleMode && !pickerRoutines ? cands.filter((i) => i.kind === "task") : cands;
  const box = $("#top3");
  const picker = document.createElement("div");
  picker.className = "t3-picker";
  const moreBtn = simpleMode && !pickerRoutines && routines.length
    ? `<button type="button" class="rt-more ghost">🔁 ルーティンからも選ぶ(${routines.length})</button>` : "";
  picker.innerHTML = list.length
    ? `<p class="muted">今日やる3つに入れるものを選ぶ:</p>` +
      list.map((i) => `<button type="button" data-id="${i.id}">${i.kind === "routine" ? "🔁 " : ""}${esc(i.name)}</button>`).join("") +
      moreBtn + `<button type="button" class="cancel-b ghost">やめる</button>`
    : `<p class="muted">選べるものがありません。下の入力欄から追加してください。</p>` +
      moreBtn + `<button type="button" class="cancel-b ghost">閉じる</button>`;
  box.appendChild(picker);
  picker.querySelector(".cancel-b").addEventListener("click", () => { pickerRoutines = false; renderToday(); });
  const rtMore = picker.querySelector(".rt-more");
  if (rtMore) rtMore.addEventListener("click", () => { pickerRoutines = true; renderToday(); openTop3Picker(todayPool()); });
  picker.querySelectorAll("button[data-id]").forEach((b) => {
    b.addEventListener("click", () => { pickerRoutines = false; toggleTop3(b.dataset.id); renderToday(); });
  });
}

function renderRest(pool) {
  const t3ids = getTop3();
  const rest = pool.filter((i) => !t3ids.includes(i.id));
  const canTop3 = t3ids.length < 3;
  const restLi = (i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="name">${i.kind === "routine" ? "🔁 " : ""}${esc(i.name)}</span><span class="meta">${metaText(i)}</span>
      ${canTop3 ? '<button class="t3-b">TOP3</button>' : ""}${i.kind === "routine" ? '<button class="rest-b2">休む</button>' : ""}<button class="done-b2">完了</button>`;
    if (canTop3) li.querySelector(".t3-b").addEventListener("click", () => { toggleTop3(i.id); renderToday(); });
    if (i.kind === "routine") li.querySelector(".rest-b2").addEventListener("click", () => restRoutine(i.id));
    li.querySelector(".done-b2").addEventListener("click", () => completeItem(i));
    return li;
  };
  // タスクは従来どおり並べ、ルーティンは1行サマリーに畳む(17本が混ざるごちゃつき対策)
  const ul = $("#today-rest");
  ul.innerHTML = "";
  for (const i of rest.filter((x) => x.kind === "task")) ul.appendChild(restLi(i));
  renderTodayRoutines(rest.filter((x) => x.kind === "routine"), restLi);
}

// 今日のルーティン折りたたみ(「6/17 済」の1行。タップで展開)
let routinesOpen = false;
function renderTodayRoutines(routines, makeLi) {
  const box = $("#today-routines");
  const dow = new Date().getDay();
  const scheduled = state.routines.filter((r) => r.days.includes(dow));
  if (!scheduled.length) { box.innerHTML = ""; return; }
  const recorded = state.logs.filter((l) => scheduled.some((r) => r.id === l.routine_id)).length;
  box.innerHTML = `
    <button type="button" class="rt-head">🔁 ルーティン ${recorded}/${scheduled.length} 済
      <span class="rt-arrow">${routinesOpen ? "▾ とじる" : "▸ ひらく"}</span></button>
    <ul class="list rt-list${routinesOpen ? "" : " hidden"}"></ul>`;
  box.querySelector(".rt-head").addEventListener("click", () => { routinesOpen = !routinesOpen; renderToday(); });
  const ul = box.querySelector(".rt-list");
  if (routinesOpen) {
    for (const i of routines) ul.appendChild(makeLi(i));
    if (!routines.length) ul.innerHTML = `<li><span class="name muted">${recorded >= scheduled.length ? "今日の分は全部記録済み 🎉" : "残りは上のTOP3/今すぐ1個に出ています"}</span></li>`;
  }
}

// ---------- 3秒クイック追加(名前だけで即入れる) ----------
// 入力したものは、空き枠があればそのまま「今日やる3つ」に入る(v6.2)。
// 埋まっている時だけ控えに回して、その旨を伝える。「追加したのに何も起きない」を無くすのが目的。
function qaMsg(t) {
  const el = $("#qa-msg");
  if (!el) return;
  el.textContent = t;
  if (t) setTimeout(() => { if (el.textContent === t) el.textContent = ""; }, 4000);
}
$("#quick-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#qa-name").value.trim();
  if (!name) return;
  $("#qa-name").value = "";
  const { data, error } = await sb.from("tasks")
    .insert({ name, priority: 2, source: "quick" }).select("id").single();
  if (error || !data) { qaMsg("追加できませんでした。通信を確認してください。"); return; }
  await refresh(); // 先に読み直す(day_stateを最新にしてからTOP3を触る)
  if (getTop3().length < 3) {
    setTop3([...getTop3(), data.id]);
    renderToday();
    qaMsg("今日やる3つに入れました ✅");
  } else {
    qaMsg("今日やる3つは埋まっています。控えに入れました。");
  }
});

// 「🌙余白」ブロックは撤去(2026-07-28 賢大の判断)。

// ---------- ポモドーロは撤去(v6.2) ----------
// 賢大の判断:「25分作業5分休憩×4セットが1作業のMAXだと分かればいい」
// → カウントダウンは端末標準のタイマーに任せ、知識だけ今日タブに1行置く。
// fmtSec は「30分だけ集中」タイマーが使うので残置。
const fmtSec = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); o.stop(ctx.currentTime + 0.25);
  } catch (e) { /* 無音でよい */ }
}

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
  const delegate = $("#task-delegate-on").checked ? ($("#task-delegate").value.trim() || null) : null;
  const payload = {
    name,
    priority: Number($("#task-priority").value),
    minutes: $("#task-minutes").value ? Number($("#task-minutes").value) : null,
    deadline: $("#task-deadline").value || null,
    category: $("#task-hate").checked ? "嫌い" : null,
    focus_needed: $("#task-focus").checked,
    delegate,
  };
  if (delegate && state.hasDelegatedAt) payload.delegated_at = new Date().toISOString();
  await sb.from("tasks").insert(payload);
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
  const m = measuredFocusHours();
  if (m) {
    // 実測モード: ポモドーロの集中度評価から算出したあなた専用のレコメンド
    if (m.top.includes(h)) {
      cls = "reco reco-focus"; msg = "🔥 実測: あなたはこの時間に強い。重い『集中タスク』をどうぞ。"; list = focus;
    } else if (m.low.includes(h)) {
      cls = "reco reco-light"; msg = "🥱 実測: この時間は集中が落ちがち。軽いタスク・委任タスクを。"; list = light;
    } else {
      cls = "reco reco-neutral"; msg = "淡々とTOP3を進める時間帯。(実測レコメンド稼働中)"; list = [];
    }
  } else if (h >= 8 && h < 10) {
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
  const pr = { 1: "🔥緊急", 2: "前に進む", 3: "影響なし" };
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
  const doneDate = doneDateStr;
  const today = todayStr();
  const weekAgoStr = dstr(new Date(Date.now() - 6 * 86400000));
  const rmap = new Map((state.routinesAll || []).map((r) => [r.id, r.name]));
  const todayCount = state.done.filter((t) => doneDate(t) === today).length;
  const weekCount = state.done.filter((t) => doneDate(t) >= weekAgoStr).length;
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
  for (const l of routineDones()) {
    if (!groups.has(l.on_date)) groups.set(l.on_date, []);
    groups.get(l.on_date).push({ routine: true, name: rmap.get(l.routine_id) || "ルーティン" });
  }
  const sorted = [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  for (const [date, items] of sorted.slice(0, 30)) {
    const d = new Date(date + "T00:00:00");
    const div = document.createElement("div");
    div.className = "done-group";
    div.innerHTML = `<div class="done-date">${date === today ? "今日" : date.slice(5).replace("-", "/") + "(" + WEEKDAYS[d.getDay()] + ")"} — ${items.length}件</div>` +
      items.map((t) => {
        if (t.routine) return `<div class="done-item">🔁 ${esc(t.name)} <span class="meta">ルーティン</span></div>`;
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

// 委任先の候補。過去に使った名前が自動で貯まる(新しい名前はそのまま入力すれば増える)
function renderDelegateNames() {
  const used = [...state.tasks, ...(state.done || [])].map((t) => t.delegate).filter(Boolean);
  const names = [...new Set([...used, "近藤", "榊原", "竹市"])];
  $("#delegate-names").innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
}

// 直近7日の実施を一目で(●=やった ◐=休んだ ○=予定日なのに記録なし ・=予定日でない)
// 実績には数えない。習慣は「見て分かる」だけでいい(2026-07-26 賢大の判断)
function habitStrip(r) {
  const cells = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    if (!r.days.includes(d.getDay())) { cells.push('<span class="hb none">・</span>'); continue; }
    const log = (state.rlogs || []).find((l) => l.routine_id === r.id && l.on_date === dstr(d));
    if (!log) cells.push('<span class="hb miss">○</span>');
    else if (log.result === "done") cells.push('<span class="hb done">●</span>');
    else cells.push('<span class="hb rest">◐</span>');
  }
  return `<span class="habit" title="直近7日">${cells.join("")}</span>`;
}

function renderRoutines() {
  const ul = $("#routine-list");
  ul.innerHTML = "";
  for (const r of state.routines) {
    const li = document.createElement("li");
    const daysTxt = r.days.length === 7 ? "毎日" : r.days.map((d) => WEEKDAYS[d]).join("");
    const todayLog = state.logs.find((l) => l.routine_id === r.id);
    const status = todayLog ? (todayLog.result === "done" ? "・今日✅" : "・今日😴休み") : "";
    li.innerHTML = `<span class="name">${esc(r.name)}</span>
      ${habitStrip(r)}
      <span class="meta">${daysTxt}${r.minutes ? "・" + r.minutes + "分" : ""}${status}</span>
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
// 実測の集中時間帯(評価30件以上・1時間あたり3件以上で判定)
const MEASURE_MIN = 30;
function focusHourStats() {
  const rated = (state.focus || []).filter((f) => f.rating && f.created_at);
  const byHour = {};
  for (const f of rated) {
    const h = new Date(f.created_at).getHours();
    (byHour[h] = byHour[h] || []).push(f.rating);
  }
  const hours = Object.entries(byHour).map(([h, a]) => ({
    h: Number(h), n: a.length, avg: a.reduce((x, y) => x + y, 0) / a.length,
  }));
  return { total: rated.length, hours };
}
function measuredFocusHours() {
  const { total, hours } = focusHourStats();
  if (total < MEASURE_MIN) return null;
  const solid = hours.filter((x) => x.n >= 3);
  if (!solid.length) return null;
  return {
    top: solid.filter((x) => x.avg >= 2.5).map((x) => x.h),
    low: solid.filter((x) => x.avg <= 1.7).map((x) => x.h),
  };
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

// 集中時間帯ヒートマップ(実測)。上段=集中度評価、下段=タスク完了数、横軸=時間帯
// renderFocusHours は撤去(2026-07-26)。ポモ撤去で focus_log への記録が止まり、
// 判定に必要な30件へ永久に届かなくなったため(実測20件・評価17件・最終記録7/12で停止)。

function renderAtBat() {
  const ws = weekStartStr();
  const days = new Set();
  for (const t of state.done) if (t.done_at && t.done_at.slice(0, 10) >= ws) days.add(t.done_at.slice(0, 10));
  for (const f of (state.focus || [])) if (f.on_date >= ws) days.add(f.on_date);
  $("#atbat").innerHTML = `<div class="atbat-card">
    <div class="ab-label">今週の打席数</div>
    <div class="ab-num">${days.size}<span>打席</span></div>
    <div class="ab-note muted">1日1つでもタスクを完了すれば打席+1。途切れてもリセットしません。（ルーティンは数えません）</div>
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

// 栄光リスト:カテゴリ別をやめ、素直な積み上げ(今週/今月/通算)＋週の自己ベストにした(2026-07-28)。
// 理由(賢大の指摘「リセットしたい」への回答):カテゴリを付ける入口が「😤嫌い」チェックしか
// 無いので、実データの9割が「その他」に落ちて意味を持っていなかった(その他33/嫌い6/事務1)。
// 分類の手間ゼロで、消さずに増え続ける形に置き換える。
// done_at はUTC保存なので、日付は必ず端末のローカル時刻に直してから切る。
// (深夜0〜9時に完了した分が「前日」に数えられるのを防ぐ)
const doneDateStr = (t) => (t.done_at ? dstr(new Date(t.done_at)) : "");

function renderGlory() {
  const box = $("#glory");
  const all = state.done.length;
  if (!all) { box.innerHTML = `<p class="muted">タスクを完了すると、ここに消えない実績として積み上がります。</p>`; return; }

  const ws = weekStartStr();
  const monthStart = todayStr().slice(0, 8) + "01";
  const week = state.done.filter((t) => doneDateStr(t) >= ws).length;
  const month = state.done.filter((t) => doneDateStr(t) >= monthStart).length;

  // 週の自己ベスト(月曜始まりで集計)
  const byWeek = {};
  for (const t of state.done) {
    const ds = doneDateStr(t);
    if (!ds) continue;
    const d = new Date(ds + "T00:00:00");
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const k = dstr(d);
    byWeek[k] = (byWeek[k] || 0) + 1;
  }
  const best = Math.max(0, ...Object.values(byWeek));
  const bestIsNow = best > 0 && byWeek[ws] === best;

  box.innerHTML = `
    <div class="glory-stats">
      <div class="g-stat"><span class="g-n">${week}</span><span class="g-l">今週</span></div>
      <div class="g-stat"><span class="g-n">${month}</span><span class="g-l">今月</span></div>
      <div class="g-stat"><span class="g-n">${all}</span><span class="g-l">通算</span></div>
    </div>
    <p class="g-best muted">週の自己ベスト ${best}件${bestIsNow ? " — 🏆 <b>今週が自己ベストです</b>" : ""}</p>`;
}

$("#goal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("#goal-title").value.trim();
  if (!title) return;
  const threshold = Math.min(100, Math.max(1, Number($("#goal-threshold").value) || 75));
  const payload = { title, threshold, progress: 0 };
  if (state.hasGoalTarget) {
    payload.target_value = Number($("#goal-target").value) || null;
    payload.unit = $("#goal-unit").value.trim() || null;
  }
  await sb.from("goals").insert(payload);
  e.target.reset();
  $("#goal-threshold").value = 75;
  await refresh();
});

// 目標=ゲージをやめ、「目標値 × 基準% = 合格ライン」を出すだけにした(2026-07-26)。
// 理由(賢大):「何をもって75%なのかが分からない状態」。分母が無い%は意味を持たない。
// 進捗は追わない。どこからが合格かが分かれば、責めない設計は成立する。
function renderGoals() {
  const box = $("#goal-list");
  const note = $("#goal-note");
  box.innerHTML = "";
  note.textContent = state.hasGoalTarget
    ? ""
    : "⚠ 目標値の保存には、Supabaseで1回だけSQLを実行する必要があります(田中に「目標のSQL」と言えば出します)。";
  if (!state.goals.length) {
    box.innerHTML = `<p class="muted">目標はまだありません。満点でなくていい。<b>どこからが合格か</b>を先に決めるのが目的です。</p>`;
    return;
  }
  for (const g of state.goals) {
    const u = esc(g.unit || "");
    const pass = g.target_value ? Math.ceil((g.target_value * g.threshold) / 100) : null;
    const div = document.createElement("div");
    div.className = "goal";
    div.innerHTML = `
      <div class="goal-top"><span class="goal-title">${esc(g.title)}</span></div>
      <div class="goal-pass">${pass
        ? `目標 <b>${g.target_value}${u}</b> ／ <span class="pass-num">合格ライン ${pass}${u}</span>（${g.threshold}%）`
        : `<span class="muted">目標値が未設定です（作り直すと合格ラインが出ます）</span>`}</div>
      <div class="row goal-ctl"><button class="del-b danger">削除</button></div>`;
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
  $("#te-hate").checked = t.category === "嫌い";
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
    category: $("#te-hate").checked ? "嫌い" : null,
    deadline: $("#te-deadline").value || null,
    minutes: $("#te-minutes").value ? Number($("#te-minutes").value) : null,
    focus_needed: $("#te-focus").checked,
    delegate: $("#te-delegate-on").checked ? ($("#te-delegate").value.trim() || null) : null,
  };
  if (state.hasDelegatedAt) {
    const before = teCtx.task?.delegate || null;
    if (fields.delegate && fields.delegate !== before) fields.delegated_at = new Date().toISOString(); // 委任した(相手を変えた)瞬間が待ちの起点
    if (!fields.delegate) fields.delegated_at = null;
  }
  if (teCtx.task) {
    await sb.from("tasks").update(fields).eq("id", teCtx.task.id);
  } else {
    await sb.from("tasks").insert({ ...fields, source: teCtx.source || "manual" });
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

// ブレインダンプは撤去(2026-07-26 賢大「紙に書くから要らない」)。Obsidian受信箱は残置。

// ---------- タブ切り替え ----------
function openTab(btn) {
  document.querySelectorAll("#tabbar button").forEach((x) => x.classList.toggle("active", x === btn));
  document.querySelectorAll(".tab").forEach((t) => t.classList.add("hidden"));
  $("#tab-" + btn.dataset.tab).classList.remove("hidden");
}
document.querySelectorAll("#tabbar button").forEach((b) => b.addEventListener("click", () => openTab(b)));

// ---------- シンプルモードの適用/解除 ----------
function applySimpleMode() {
  document.body.classList.toggle("simple", simpleMode);
  $("#today-more").open = !simpleMode;
  $("#simple-toggle").textContent = simpleMode ? "🔧 隠している機能を表示する" : "✅「今日やる3つ」だけに戻す";
  $("#simple-note").textContent = simpleMode
    ? "タスク／実績のタブは、隠しているだけです(データは全部残っています)。"
    : "全機能を表示中です。";
  // 隠したタブを開いたままにしない
  const active = document.querySelector("#tabbar button.active");
  if (simpleMode && active?.hasAttribute("data-simple-hide")) openTab($('#tabbar button[data-tab="today"]'));
}
$("#simple-toggle").addEventListener("click", () => {
  simpleMode = !simpleMode;
  localStorage.setItem(SIMPLE_KEY, simpleMode ? "on" : "off");
  applySimpleMode();
});
applySimpleMode();

// ---------- 共通 ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 1箇所の描画エラーで全体が道連れになるのを防ぐ(v6.6)。
// 事故:renderDone内の未定義変数で refresh が途中停止し、Obsidian受信箱とタイムバケットが
// 数日間まるごと表示されなくなっていた。以後は壊れた1ブロックだけが空になり、他は動く。
function safeRender(label, fn) {
  try { fn(); } catch (e) { console.error(`[今日やる] ${label} の描画に失敗:`, e); }
}

async function refresh() {
  lastRefresh = Date.now();
  await loadAll();
  safeRender("今日", renderToday);
  safeRender("タスク", renderTasks);
  safeRender("ルーティン", renderRoutines);
  safeRender("委任先", renderDelegateNames);
  safeRender("実績", renderResults);
  await Promise.all([loadBucket(), loadInbox()]);
}

// ---------- Service Worker ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
