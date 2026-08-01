// 死ぬまでに — 残り時間と、やりたいことリストだけ。
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
    const [p, b] = await Promise.all([
      sb.from("profile").select("*").maybeSingle(),
      sb.from("bucket_items").select("*").order("created_at"),
    ]);
    if (p.error) throw new Error("profile: " + p.error.message);
    if (b.error) throw new Error("bucket_items: " + b.error.message);
    myProfile = p.data;
    bucketItems = b.data || [];
    const hasBirthdate = !!myProfile?.birthdate;
    $("#life-setup").classList.toggle("hidden", hasBirthdate);
    $("#life-view").classList.toggle("hidden", !hasBirthdate);
    if (hasBirthdate) drawLife();
    renderChips();
    renderList();
  } catch (err) {
    console.error("[死ぬまでに] 読み込み失敗:", err);
    $("#bucket-list").innerHTML = `<p class="muted">⚠読み込みエラー: ${esc(err.message)}</p>`;
  }
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
