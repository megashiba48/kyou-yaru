// 死ぬまでに — 残り時間 / 今日やる3つ / やりたいことリスト。
//
// 2026-08-07 v7.2:「今日やる3つ」を追加。1日3行・ストック無し・未完は繰越して放置日数を出す。
//
// 2026-08-01 v7.0:「今日やる」から全機能を撤去し、タイムバケット1画面に絞った。
// 賢大の結論=「必要なのはタイムバケットだけ」。データもそう言っていた:
//   TOP3を実際に入れた日=2日(最終7/17) / 目標=1件 / 受信箱=7/3から放置 / 未完タスク=2件
// タスク・ルーティン・実績・アイデアのUIは全廃。**DBのテーブルとデータは1行も消していない**ので、
// 旧UIを戻したくなったらgit履歴から復元できる(v6.9が最後の全機能版)。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const $ = (sel) => document.querySelector(sel);
const cfg = window.APP_CONFIG || {};
const configured = cfg.SUPABASE_URL?.startsWith("https://") && cfg.SUPABASE_ANON_KEY?.length > 20;

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

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- 認証(ここは触っていない。マジックリンク＋iPhone用の貼り付けログイン) ----------
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
});

let signedIn = false;
sb.auth.onAuthStateChange((_event, session) => {
  signedIn = !!session;
  if (session) { show("app-view"); refresh(); }
  else show("auth-view");
});

// 前面に戻ったら読み直す(別端末で足した分を拾う)
let lastRefresh = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && signedIn && Date.now() - lastRefresh > 20000) refresh();
});

// ---------- 残り時間 ----------
const HORIZONS = { "1y": "1年以内", "3y": "3年以内", "5y": "5年以内", "10y": "10年以内", "life": "死ぬまでに" };
let bucketItems = [];
let bucketFilter = "all";
let myProfile = null;
let todayItems = [];   // 今日の3つ
let dayRows = [];      // day_state の履歴(実績の材料)

$("#birthdate-save").addEventListener("click", async () => {
  const bd = $("#birthdate").value;
  if (!bd) return;
  const { data: { user } } = await sb.auth.getUser();
  await sb.from("profile").upsert({ user_id: user.id, birthdate: bd }, { onConflict: "user_id" });
  await refresh();
});

function drawLife() {
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

// ---------- 画面の切り替え(v7.3) ----------
// 2画面:「今日やる」と「死ぬまでに」。開いた時は必ず今日やるから始める(記憶しない)。
// 残り時間ゲージは両方の頭に出すが、今日やる側は数字1行だけに畳む(縦に伸ばさないため)。
let tab = "today";

function setTab(next) {
  tab = next;
  for (const b of document.querySelectorAll("#tabs .tab")) {
    b.classList.toggle("on", b.dataset.tab === next);
  }
  $("#panel-today").classList.toggle("hidden", next !== "today");
  $("#panel-bucket").classList.toggle("hidden", next !== "bucket");
  // ゲージのバーと注釈は「死ぬまでに」側だけ
  $("#life-meter").classList.toggle("hidden", next !== "bucket");
  $("#life-meter-label").classList.toggle("hidden", next !== "bucket");
  window.scrollTo(0, 0);
}

for (const b of document.querySelectorAll("#tabs .tab")) {
  b.addEventListener("click", () => setTab(b.dataset.tab));
}
setTab("today");

// ---------- 今日やる3つ ----------
// 設計(2026-08-07・賢大の指示):
//   ・1日に置けるのは最大3行。ストック(あとで用の置き場)は作らない。ジャンル分けもしない。
//   ・未完は翌日へ繰り越す。繰り越したら「⚠️N日放置」を出す(先延ばし癖を自分に見せるため)。
//   ・順位は↑↓で入れ替え。1番目が最優先で、そこだけ色を変える。
//   ・完了した行は消さずに残して実績になる。枠は空かない(=1日3つの上限は守られる)。
//     「やめる」で捨てた枠だけは空く。捨てるのは意識的な判断なので、そこは通す。
// 保存先は既存の day_state.top3(jsonb)。列の追加もテーブルの新設もしていない。
const MAX_TODAY = 3;
const WDAY = ["日", "月", "火", "水", "木", "金", "土"];

const dstr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const dayDiff = (from, to) =>
  Math.round((new Date(to + "T00:00:00") - new Date(from + "T00:00:00")) / 86400000);

const newId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + String(Math.random()).slice(2));

// 旧TOP3(v6.x)は tasks の UUID 文字列を並べていた。形が違う行は黙って捨てる。
function normalizeItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && typeof x === "object" && typeof x.text === "string" && x.text.trim())
    .map((x) => ({
      id: x.id || newId(),
      text: x.text,
      since: x.since || dstr(),      // 最初に書いた日。放置日数の起点
      done_at: x.done_at || null,
    }));
}

async function saveToday() {
  const { data: { user } } = await sb.auth.getUser();
  const { error } = await sb.from("day_state").upsert(
    { user_id: user.id, on_date: dstr(), top3: todayItems, updated_at: new Date().toISOString() },
    { onConflict: "user_id,on_date" }
  );
  if (error) throw new Error(error.message);
}

// 保存 → 即描画。失敗したら黙らずに画面へ出す。
async function commitToday() {
  $("#today-msg").textContent = "";
  try {
    await saveToday();
  } catch (err) {
    $("#today-msg").textContent = "⚠保存できませんでした: " + err.message;
  }
  renderToday();
  renderLog();
}

$("#today-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#today-name").value.trim();
  if (!text) return;
  if (todayItems.length >= MAX_TODAY) return;
  todayItems.push({ id: newId(), text, since: dstr(), done_at: null });
  $("#today-name").value = "";
  await commitToday();
});

function renderToday() {
  const ol = $("#today-list");
  const today = dstr();
  ol.innerHTML = "";
  $("#today-count").textContent = ` ${todayItems.length}/${MAX_TODAY}`;

  if (!todayItems.length) {
    ol.innerHTML = `<p class="muted">今日やることを3つまで。少ないほどいい。</p>`;
  }

  let rank = 0;
  todayItems.forEach((it, i) => {
    const li = document.createElement("li");
    const isDone = !!it.done_at;
    if (!isDone) rank++;
    li.className = "t-item" + (isDone ? " done" : rank === 1 ? " top" : "");

    const age = dayDiff(it.since, today);
    const warn = !isDone && age > 0
      ? `<span class="age ${age >= 7 ? "hot" : age >= 3 ? "warm" : ""}">⚠️${age}日放置</span>`
      : "";
    const tag = !isDone && rank === 1 ? `<span class="tag">最優先</span>` : "";

    // 完了した行は順位から外れるので、↑↓は出さない(押せないボタンを置かない)
    const undoneN = todayItems.filter((x) => !x.done_at).length;
    const arrows = isDone || undoneN <= 1 ? "" : `
        <button class="mv up" title="順位を上げる" ${rank === 1 ? "disabled" : ""}>↑</button>
        <button class="mv down" title="順位を下げる" ${rank === undoneN ? "disabled" : ""}>↓</button>`;

    li.innerHTML = `
      <span class="rank">${isDone ? "🏆" : rank}</span>
      <div class="body"><span class="text">${esc(it.text)}</span>${tag}${warn}</div>
      <div class="ops">${arrows}
        <button class="ok">${isDone ? "戻す" : "やった!"}</button>
        <button class="danger drop">やめる</button>
      </div>`;

    li.querySelector(".up")?.addEventListener("click", async () => {
      [todayItems[i - 1], todayItems[i]] = [todayItems[i], todayItems[i - 1]];
      await commitToday();
    });
    li.querySelector(".down")?.addEventListener("click", async () => {
      [todayItems[i], todayItems[i + 1]] = [todayItems[i + 1], todayItems[i]];
      await commitToday();
    });
    li.querySelector(".ok").addEventListener("click", async () => {
      const [row] = todayItems.splice(i, 1);
      if (isDone) {
        row.done_at = null;
        // 未完に戻す時は、完了済みの手前へ挿す
        const firstDone = todayItems.findIndex((x) => x.done_at);
        todayItems.splice(firstDone < 0 ? todayItems.length : firstDone, 0, row);
      } else {
        row.done_at = new Date().toISOString();
        todayItems.push(row); // 完了は一番下へ
      }
      await commitToday();
    });
    li.querySelector(".drop").addEventListener("click", async () => {
      if (!confirm(`「${it.text}」をやめますか?(記録には残りません)`)) return;
      todayItems.splice(i, 1);
      await commitToday();
    });

    ol.appendChild(li);
  });

  const full = todayItems.length >= MAX_TODAY;
  $("#today-form").classList.toggle("hidden", full);
  $("#today-full").classList.toggle("hidden", !full);
}

// ---------- 実績(何日に何をやったか) ----------
function renderLog() {
  const today = dstr();
  const byDate = new Map();
  for (const r of dayRows) {
    if (r.on_date === today) continue; // 今日はメモリ側(todayItems)が正
    const done = normalizeItems(r.top3).filter((x) => x.done_at);
    if (done.length) byDate.set(r.on_date, done);
  }
  const doneToday = todayItems.filter((x) => x.done_at);
  if (doneToday.length) byDate.set(today, doneToday);

  const dates = [...byDate.keys()].sort().reverse();
  const total = dates.reduce((n, d) => n + byDate.get(d).length, 0);
  $("#log-total").textContent = total ? ` 通算${total}件` : "";

  const box = $("#log-body");
  if (!dates.length) {
    box.innerHTML = `<p class="muted">まだありません。1つ終わらせるとここに残ります。</p>`;
    return;
  }
  box.innerHTML = dates
    .slice(0, 30)
    .map((d) => {
      const dt = new Date(d + "T00:00:00");
      const label = `${dt.getMonth() + 1}/${dt.getDate()}(${WDAY[dt.getDay()]})` + (d === today ? " 今日" : "");
      const rows = byDate.get(d).map((x) => `<li>${esc(x.text)}</li>`).join("");
      return `<div class="logday"><p class="logdate">${label}</p><ul>${rows}</ul></div>`;
    })
    .join("");
}

// ---------- やりたいことリスト ----------
$("#bucket-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const content = $("#bucket-name").value.trim();
  if (!content) return;
  const horizon = $("#bucket-horizon").value;
  await sb.from("bucket_items").insert({ content, horizon });
  $("#bucket-name").value = "";
  await refresh();
});

function renderChips() {
  const box = $("#bucket-chips");
  box.innerHTML = "";
  const counts = {};
  for (const b of bucketItems) counts[b.horizon] = (counts[b.horizon] || 0) + 1;
  for (const [key, label] of [["all", "全部"], ...Object.entries(HORIZONS)]) {
    const n = key === "all" ? bucketItems.length : (counts[key] || 0);
    if (key !== "all" && !n) continue; // 0件の期限はチップを出さない(横に伸びるだけなので)
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (bucketFilter === key ? " on" : "");
    chip.textContent = `${label} ${n}`;
    chip.addEventListener("click", () => { bucketFilter = key; renderChips(); renderList(); });
    box.appendChild(chip);
  }
}

function renderList() {
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
      <button class="ach-b">${b.achieved ? "戻す" : "やった!"}</button>
      <button class="danger del-b">削除</button>`;
    li.querySelector(".ach-b").addEventListener("click", async () => {
      await sb.from("bucket_items").update({ achieved: !b.achieved }).eq("id", b.id);
      await refresh();
    });
    li.querySelector(".del-b").addEventListener("click", async () => {
      if (!confirm(`「${b.content}」を削除しますか?`)) return;
      await sb.from("bucket_items").delete().eq("id", b.id);
      await refresh();
    });
    ul.appendChild(li);
  }
}

// ---------- 読み込み ----------
// 1箇所のエラーで画面全体が落ちないようにする(2026-07-29の事故対策。failures.md参照)
async function refresh() {
  lastRefresh = Date.now();
  try {
    const [p, b, d] = await Promise.all([
      sb.from("profile").select("*").maybeSingle(),
      sb.from("bucket_items").select("*").order("created_at"),
      sb.from("day_state").select("on_date, top3").order("on_date", { ascending: false }).limit(180),
    ]);
    if (p.error) throw new Error("profile: " + p.error.message);
    if (b.error) throw new Error("bucket_items: " + b.error.message);
    if (d.error) throw new Error("day_state: " + d.error.message);
    myProfile = p.data;
    bucketItems = b.data || [];
    dayRows = d.data || [];

    // 今日の行が無ければ、直近の日から「未完だけ」を繰り越す。
    // since(最初に書いた日)は引き継ぐので、放置日数はここでリセットされない。
    const today = dstr();
    const todayRow = dayRows.find((r) => r.on_date === today);
    if (todayRow) {
      todayItems = normalizeItems(todayRow.top3);
    } else {
      const prev = dayRows.find((r) => r.on_date < today);
      todayItems = prev ? normalizeItems(prev.top3).filter((x) => !x.done_at) : [];
      if (todayItems.length) await saveToday(); // 繰り越しがある時だけ行を作る(空の行は作らない)
    }

    const hasBirthdate = !!myProfile?.birthdate;
    $("#life-setup").classList.toggle("hidden", hasBirthdate);
    $("#life-view").classList.toggle("hidden", !hasBirthdate);
    if (hasBirthdate) drawLife();
    renderToday();
    renderLog();
    renderChips();
    renderList();
  } catch (err) {
    console.error("[死ぬまでに] 読み込み失敗:", err);
    $("#today-msg").textContent = "⚠読み込みエラー: " + err.message;
    $("#bucket-list").innerHTML = `<p class="muted">⚠読み込みエラー: ${esc(err.message)}</p>`;
  }
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
