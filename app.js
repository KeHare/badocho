'use strict';

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  collection,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  arrayUnion,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import QRCode from 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm';

const firebaseConfig = {
  apiKey: "AIzaSyA3Nbms2glfODUPSVmp4dIHgFHB3c8EaFc",
  authDomain: "badocho.firebaseapp.com",
  projectId: "badocho",
  storageBucket: "badocho.firebasestorage.app",
  messagingSenderId: "837496039709",
  appId: "1:837496039709:web:c2790b1805efff41c959f4"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const STORAGE_KEY = 'badcho.v2';
const LEGACY_STORAGE_KEY = 'badcho.v1';
const TEACHER_URL_KEY = 'badcho.teacherUrl'; // この端末が前回使ったけろ先生用URL（迷子防止）

function rememberTeacherUrl(url) {
  try { localStorage.setItem(TEACHER_URL_KEY, url); } catch {}
}
function recalledTeacherUrl() {
  try { return localStorage.getItem(TEACHER_URL_KEY) || ''; } catch { return ''; }
}
function forgetTeacherUrl() {
  try { localStorage.removeItem(TEACHER_URL_KEY); } catch {}
}

const CATEGORIES = [
  { id: 'match', label: '試合' },
  { id: 'practice', label: '練習' },
  { id: 'technique', label: '技術' },
  { id: 'tactics', label: '戦術' },
  { id: 'body', label: '体' },
  { id: 'mind', label: '心' },
  { id: 'gear', label: '道具' },
];

// 入力プロンプト（投稿欄プレースホルダの巡回ストック・けろ先生らしい問い）
const PROMPTS = [
  'コートで何の音がした？',
  '今日の足は重かった？軽かった？',
  '最後の1点、どんな気持ちだった？',
  '相手のラケットの色を覚えてる？',
  '今日いちばん気になった一場面は？',
  '体育館の空気はどんな匂いだった？',
  'ふとした瞬間に思ったこと、ひとことだけ',
  '今日のあなたは、何を見ていた？',
  'うまくいかなかった時、何を考えていた？',
  '今日のシューズの紐、ぎゅっと締めた？',
  'ペアの背中、どう見えた？',
  '試合前、心はどこにあった？',
  '次やるとき、何を変えたい？',
  '練習の終わり、どんな顔してた？',
  '今日は誰の声が一番聞こえた？',
  'コートの線、はっきり見えた？',
  '休憩中、何を飲んだ？',
  '今日のシャトルは、どんなふうに飛んだ？',
  '帰り道、何を考えていた？',
  '今日は、何があった日？（一文字でも）',
];

function randomPrompt() {
  return PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
}
const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.id, c.label]));

const params = new URLSearchParams(location.search);
const teacherToken = (params.get('t') || '').trim();
const studentToken = (params.get('s') || '').trim();
const archiveStudentToken = (params.get('archive') || '').trim();

const mode = (teacherToken && teacherToken.length >= 32 && archiveStudentToken && archiveStudentToken.length >= 20)
  ? 'archive'
  : teacherToken && teacherToken.length >= 32
    ? 'teacher'
    : studentToken && studentToken.length >= 20
      ? 'student'
      : 'setup';

let state = {
  view: 'home',
  activePostId: null,
  activeStudentToken: null,
  students: [],
  posts: [],
  postsByStudent: {},
  loading: true,
  error: null,
  filterMode: 'all', // 'all' | 'unanswered'
  rereadMonth: 'all', // 'all' | 'YYYY-MM'
  journal: [],
  editingJournalId: null,
  editingPostId: null,
  promptsByStudent: {}, // token -> お題[]
  answeringPromptId: null, // compose時に答えるお題のid
  cleanupHandlers: [],
};

const subscriptions = new Map();

// けろ先生のpresence（「いま読んでいる」）を多重起動させないためのガード。
// renderDetailは投稿スナップショットの度に呼ばれるため、presence送信を
// レンダー毎にやると「書き込み→再レンダー→書き込み」の無限ループになる。
// これで「投稿を開くたび1回だけ」初期化する。
let presencePostId = null;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function genToken(byteLen) {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const wk = ['日', '月', '火', '水', '木', '金', '土'][date.getDay()];
  return `${y}年${m}月${d}日（${wk}）`;
}

async function resizeImageToDataURL(file, maxSize = 1280, quality = 0.7) {
  const img = await createImageBitmap(file);
  const ratio = Math.min(maxSize / img.width, maxSize / img.height, 1);
  const w = Math.round(img.width * ratio);
  const h = Math.round(img.height * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

function fmtAgo(iso) {
  if (!iso) return '少し前';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'いま';
  if (mins < 60) return `${mins}分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}日前`;
  return new Date(iso).toLocaleDateString('ja-JP');
}

function fmtTimestamp(isoFull) {
  const d = new Date(isoFull);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${day} ${hh}:${mm}`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function navigate(view, opts = {}) {
  // 画面離脱時のクリーンアップ（presence・購読など）
  if (state.cleanupHandlers && state.cleanupHandlers.length > 0) {
    state.cleanupHandlers.forEach(fn => { try { fn(); } catch {} });
    state.cleanupHandlers = [];
  }
  state.view = view;
  if ('postId' in opts) state.activePostId = opts.postId;
  if ('studentToken' in opts) state.activeStudentToken = opts.studentToken;
  if ('editingPostId' in opts) state.editingPostId = opts.editingPostId;
  if ('answeringPromptId' in opts) state.answeringPromptId = opts.answeringPromptId;
  // home に戻る時は編集状態をリセット
  if (view === 'home') {
    state.editingPostId = null;
    state.answeringPromptId = null;
  }
  render();
  window.scrollTo(0, 0);
}

function postsForActiveStudent() {
  const tk = state.activeStudentToken;
  if (!tk) return [];
  const list = state.postsByStudent[tk] || [];
  return list.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)));
}

/* ====== Firestore I/O ====== */

function teacherIndexRef() {
  return doc(db, 'teacher_index', teacherToken);
}

function studentPostsCol(token) {
  return collection(db, 'students', token, 'posts');
}

function postRef(token, postId) {
  return doc(db, 'students', token, 'posts', postId);
}

async function loadTeacherIndex() {
  const snap = await getDoc(teacherIndexRef());
  if (!snap.exists()) {
    await setDoc(teacherIndexRef(), { students: [], createdAt: serverTimestamp() });
    state.students = [];
  } else {
    state.students = snap.data().students || [];
  }
}

function subscribeTeacherIndex() {
  const unsub = onSnapshot(teacherIndexRef(), snap => {
    if (snap.exists()) {
      state.students = snap.data().students || [];
      render();
      state.students.forEach(s => {
        subscribeStudentPosts(s.token);
        subscribeStudentPrompts(s.token);
      });
    }
  }, err => {
    console.error('teacher_index subscribe error', err);
    state.error = err.message;
    render();
  });
  subscriptions.set('teacher_index', unsub);
}

function subscribeStudentPosts(token) {
  if (subscriptions.has('posts:' + token)) return;
  const q = query(studentPostsCol(token), orderBy('createdAt', 'desc'));
  const unsub = onSnapshot(q, snap => {
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    state.postsByStudent[token] = list;
    render();
  }, err => {
    console.error('posts subscribe error', token, err);
  });
  subscriptions.set('posts:' + token, unsub);
}

async function addStudentToIndex(name) {
  const newStudent = {
    name: name.trim(),
    token: genToken(16),
    addedAt: new Date().toISOString(),
  };
  const next = [...state.students, newStudent];
  await setDoc(teacherIndexRef(), { students: next }, { merge: true });
  return newStudent;
}

async function updateStudentInIndex(token, patch) {
  const next = state.students.map(s => s.token === token ? { ...s, ...patch } : s);
  await setDoc(teacherIndexRef(), { students: next }, { merge: true });
}

async function removeStudentFromIndex(token) {
  const next = state.students.filter(s => s.token !== token);
  await setDoc(teacherIndexRef(), { students: next }, { merge: true });
  // 投稿サブコレクションは残置（誤削除防止のため自動消去しない）
}

async function completelyRemoveStudent(token) {
  // 1. その選手の全投稿を取得
  const postsCol = collection(db, 'students', token, 'posts');
  const postsSnap = await getDocs(postsCol);

  // 2. 各投稿に紐づくコーチ下書きを削除
  const draftDeletes = [];
  postsSnap.forEach(d => {
    draftDeletes.push(deleteDoc(coachDraftRef(d.id)).catch(() => {}));
  });
  await Promise.all(draftDeletes);

  // 3. 投稿本体を削除
  const postDeletes = [];
  postsSnap.forEach(d => {
    postDeletes.push(deleteDoc(doc(db, 'students', token, 'posts', d.id)));
  });
  await Promise.all(postDeletes);

  // 4. 名簿から外す
  const next = state.students.filter(s => s.token !== token);
  await setDoc(teacherIndexRef(), { students: next }, { merge: true });

  // 5. ローカル購読の解除
  const unsub = subscriptions.get('posts:' + token);
  if (unsub) {
    unsub();
    subscriptions.delete('posts:' + token);
  }
  delete state.postsByStudent[token];
  if (state.activeStudentToken === token) state.activeStudentToken = null;
}

async function createPost(token, postData) {
  const id = uid();
  await setDoc(postRef(token, id), {
    ...postData,
    createdAt: new Date().toISOString(),
    responses: [],
  });
  return id;
}

async function deletePost(token, postId) {
  // 関連する下書きも一緒に消す
  await deleteDoc(coachDraftRef(postId)).catch(() => {});
  await deleteDoc(postRef(token, postId));
}

async function updatePost(token, postId, patch) {
  // 本文・写真・カテゴリ・日付のみ更新可。responses/createdAt は触らない
  const allowed = {};
  if ('date' in patch) allowed.date = patch.date;
  if ('body' in patch) allowed.body = patch.body;
  if ('photoData' in patch) allowed.photoData = patch.photoData;
  if ('photoUrl' in patch) allowed.photoUrl = patch.photoUrl;
  if ('categories' in patch) allowed.categories = patch.categories;
  allowed.editedAt = new Date().toISOString();
  await setDoc(postRef(token, postId), allowed, { merge: true });
}

function getPhotoSrc(post) {
  return post.photoData || post.photoUrl || '';
}

async function regenerateStudentToken(oldToken) {
  const newToken = genToken(16);
  const oldCol = collection(db, 'students', oldToken, 'posts');
  const oldSnap = await getDocs(oldCol);

  // 新トークン側に複製（失敗したら index は触らない＝旧URLのまま使える状態を保つ）
  const writes = [];
  oldSnap.forEach(docSnap => {
    writes.push(setDoc(doc(db, 'students', newToken, 'posts', docSnap.id), docSnap.data()));
  });
  await Promise.all(writes);

  // index の token を差し替え（過去の addedAt は維持、regeneratedAt を追加）
  const next = state.students.map(s =>
    s.token === oldToken
      ? { ...s, token: newToken, regeneratedAt: new Date().toISOString() }
      : s
  );
  await setDoc(teacherIndexRef(), { students: next }, { merge: true });

  // 旧データを削除（旧URL無効化）
  const deletes = [];
  oldSnap.forEach(docSnap => {
    deletes.push(deleteDoc(doc(db, 'students', oldToken, 'posts', docSnap.id)));
  });
  await Promise.all(deletes);

  // ローカル購読の入れ替え
  const oldUnsub = subscriptions.get('posts:' + oldToken);
  if (oldUnsub) {
    oldUnsub();
    subscriptions.delete('posts:' + oldToken);
  }
  delete state.postsByStudent[oldToken];
  if (state.activeStudentToken === oldToken) state.activeStudentToken = newToken;
  subscribeStudentPosts(newToken);
}

function unansweredCount(token) {
  const list = state.postsByStudent[token] || [];
  return list.filter(p => !p.responses || p.responses.length === 0).length;
}

/* ====== お題（けろ先生 → 選手への問い） ====== */

function promptsCol(token) {
  return collection(db, 'students', token, 'prompts');
}

function subscribeStudentPrompts(token) {
  if (subscriptions.has('prompts:' + token)) return;
  const q = query(promptsCol(token), orderBy('createdAt', 'desc'));
  const unsub = onSnapshot(q, snap => {
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    state.promptsByStudent[token] = list;
    render();
  }, err => console.error('prompts subscribe error', token, err));
  subscriptions.set('prompts:' + token, unsub);
}

async function addPrompt(token, body) {
  const id = uid();
  await setDoc(doc(promptsCol(token), id), {
    body: body.trim(),
    status: 'open',
    createdAt: new Date().toISOString(),
  });
}

async function deletePrompt(token, promptId) {
  await deleteDoc(doc(promptsCol(token), promptId));
}

async function markPromptAnswered(token, promptId, postId) {
  await setDoc(doc(promptsCol(token), promptId), {
    status: 'answered',
    answeredPostId: postId,
    answeredAt: new Date().toISOString(),
  }, { merge: true });
}

function openPromptsFor(token) {
  return (state.promptsByStudent[token] || []).filter(p => p.status !== 'answered');
}

/* ====== 既読（選手 → けろ先生への「受け取りのしるべ」） ====== */

// その投稿に付いた、けろ先生の地の文返しのうち最新の時刻
function latestTeacherResponseAt(post) {
  const list = (post.responses || []).filter(r => (r.from || 'teacher') === 'teacher');
  if (list.length === 0) return null;
  return list.reduce((mx, r) => (r.createdAt > mx ? r.createdAt : mx), '');
}

// 選手がまだ受け取っていない地の文返しがあるか
function hasUnreadTeacherResponse(post) {
  const latest = latestTeacherResponseAt(post);
  if (!latest) return false;
  return !post.studentReadAt || post.studentReadAt < latest;
}

// 選手が地の文返しを読んだしるべを残す（採点ではなく受領）
async function markPostRead(token, postId) {
  try {
    await updateDoc(postRef(token, postId), { studentReadAt: new Date().toISOString() });
  } catch (err) {
    console.warn('markPostRead failed', err);
  }
}

/* ====== コーチの地の文返し下書き（端末跨ぎ） ====== */

function coachDraftRef(postId) {
  return doc(db, 'coach_drafts', teacherToken, 'responses', postId);
}

async function loadCoachDraft(postId) {
  if (mode !== 'teacher') return null;
  try {
    const snap = await getDoc(coachDraftRef(postId));
    return snap.exists() ? snap.data() : null;
  } catch {
    return null;
  }
}

async function saveCoachDraft(postId, body) {
  if (mode !== 'teacher') return;
  try {
    if (body && body.trim()) {
      await setDoc(coachDraftRef(postId), {
        body,
        updatedAt: new Date().toISOString(),
      });
    } else {
      await deleteDoc(coachDraftRef(postId)).catch(() => {});
    }
  } catch (err) {
    console.warn('draft save failed', err);
  }
}

async function clearCoachDraft(postId) {
  if (mode !== 'teacher') return;
  await deleteDoc(coachDraftRef(postId)).catch(() => {});
}

/* ====== コーチ専用ジャーナル（楽屋） ====== */

function journalCol() {
  return collection(db, 'coach_journal', teacherToken, 'entries');
}

function subscribeJournal() {
  if (subscriptions.has('journal')) return;
  const q = query(journalCol(), orderBy('createdAt', 'desc'));
  const unsub = onSnapshot(q, snap => {
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    state.journal = list;
    if (state.view === 'journal') render();
  }, err => console.error('journal subscribe error', err));
  subscriptions.set('journal', unsub);
}

async function addJournalEntry(body, attachedTo) {
  const id = uid();
  await setDoc(doc(journalCol(), id), {
    body,
    attachedTo: attachedTo || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function updateJournalEntry(id, body, attachedTo) {
  await setDoc(doc(journalCol(), id), {
    body,
    attachedTo: attachedTo || null,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}

async function deleteJournalEntry(id) {
  await deleteDoc(doc(journalCol(), id));
}

async function appendResponse(token, postId, body, from) {
  // from: 'teacher' | 'student'。互換性のため未指定時は 'teacher'
  const response = {
    id: uid(),
    createdAt: new Date().toISOString(),
    body,
    from: from || 'teacher',
  };
  await updateDoc(postRef(token, postId), {
    responses: arrayUnion(response),
  });
}

/* ====== Render ====== */

function render() {
  const main = document.getElementById('main');
  const back = document.getElementById('backBtn');
  const settings = document.getElementById('settingsBtn');
  const title = document.getElementById('headerTitle');
  const modeBadge = document.getElementById('modeBadge');

  // モード明示バッジ
  if (modeBadge) {
    if (mode === 'teacher') {
      modeBadge.textContent = 'けろ先生';
      modeBadge.className = 'mode-badge mode-teacher';
    } else if (mode === 'student') {
      modeBadge.textContent = 'あなた';
      modeBadge.className = 'mode-badge mode-student';
    } else if (mode === 'archive') {
      modeBadge.textContent = 'アーカイブ';
      modeBadge.className = 'mode-badge mode-archive';
    } else {
      modeBadge.textContent = '';
      modeBadge.className = 'mode-badge';
    }
  }

  if (mode === 'setup') {
    back.classList.add('hidden');
    settings.classList.add('hidden');
    title.textContent = 'バド帖';
    renderSetup(main);
    return;
  }

  if (state.loading) {
    back.classList.add('hidden');
    settings.classList.add('hidden');
    title.textContent = 'バド帖';
    main.innerHTML = `<div class="empty">読み込み中…</div>`;
    return;
  }

  if (state.view === 'home') {
    back.classList.add('hidden');
    settings.classList.toggle('hidden', mode !== 'teacher');
    title.textContent = mode === 'teacher' ? 'バド帖（けろ先生）' : 'バド帖';
  } else {
    back.classList.remove('hidden');
    settings.classList.add('hidden');
    title.textContent = ({
      compose: '投稿',
      detail: '投稿',
      settings: '設定',
      students: '選手',
      reread: '読み返し',
      journal: '楽屋',
      prompt: 'お題',
    })[state.view] || 'バド帖';
  }

  if (state.view === 'home') renderHome(main);
  else if (state.view === 'compose') renderCompose(main);
  else if (state.view === 'detail') renderDetail(main);
  else if (state.view === 'settings') renderSettings(main);
  else if (state.view === 'reread') renderReread(main);
  else if (state.view === 'journal') renderJournal(main);
  else if (state.view === 'prompt') renderPrompt(main);
}

function findOnThisDay(token) {
  const all = state.postsByStudent[token] || [];
  if (all.length === 0) return null;
  const today = new Date();
  const yyyy = today.getFullYear();
  const monthDay = `-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  // 同月日の過去年の投稿
  const sameDay = all.filter(p => p.date && p.date.endsWith(monthDay) && p.date.slice(0, 4) !== String(yyyy));
  if (sameDay.length > 0) return { post: sameDay[0], reason: 'same-day' };
  // 同月日がなければ ちょうど1ヶ月前 / 3ヶ月前 / 半年前 を探す
  const milestones = [
    { months: 1, label: '1ヶ月前のきょう' },
    { months: 3, label: '3ヶ月前のきょう' },
    { months: 6, label: '半年前のきょう' },
    { months: 12, label: '1年前のきょう' },
  ];
  for (const ms of milestones) {
    const target = new Date(yyyy, today.getMonth() - ms.months, today.getDate());
    const targetStr = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
    const m = all.find(p => p.date === targetStr);
    if (m) return { post: m, reason: ms.label };
  }
  return null;
}

function renderOnThisDayCard(token) {
  const found = findOnThisDay(token);
  if (!found) return '';
  const { post, reason } = found;
  const label = reason === 'same-day'
    ? `${post.date.slice(0, 4)}年のきょう、こう書いていました`
    : `${reason}、こう書いていました`;
  const bodyExcerpt = post.body
    ? escapeHtml(post.body.length > 60 ? post.body.slice(0, 60) + '…' : post.body)
    : '<span class="silent">（無言の便り）</span>';
  return `
    <div class="day-letter-card" data-post-id="${post.id}">
      <div class="day-letter-label">${label}</div>
      <div class="day-letter-body">${bodyExcerpt}</div>
    </div>
  `;
}

function renderSetup(root) {
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  const hasLegacy = !!legacy;
  const recalled = recalledTeacherUrl();

  // この端末で前に使ったけろ先生用URLがあれば、最優先で「おかえり」を出す（迷子防止）
  const recallHtml = recalled ? `
    <div class="setup-card recall-card">
      <h2>おかえりなさい</h2>
      <p>この端末で前に使った、<strong>あなたの帳面</strong>のURLが見つかりました。<br>
      新しく作り直すと別の空の帳面になります。<strong>続きはこちらから開いてください。</strong></p>
      <a class="btn btn-primary" href="${escapeHtml(recalled)}" style="display:block;text-decoration:none;text-align:center">前回の帳面（けろ先生用URL）を開く</a>
      <textarea readonly class="form-textarea short" style="font-size:12px;margin-top:10px">${escapeHtml(recalled)}</textarea>
      <button class="link-btn" id="forgetTeacherBtn" style="margin-top:8px">このURLの記憶を消す</button>
    </div>
  ` : '';

  // 発行カード：記憶がある時は「別の新しい帳面を作る」と明示して格下げ
  const issueTitle = recalled ? '新しく別の帳面を作る' : 'はじめに';
  const issueNote = recalled
    ? `<p class="warn-note">⚠ これは<strong>前回とは別の、空っぽの新しい帳面</strong>になります。けろ先生用URLを増やすほど迷子になりやすいので、ふつうは上の「前回の帳面を開く」を使ってください。</p>`
    : `<p>バド帖は、URLにトークンを付けて使います。発行したURL自体が<strong>あなたの帳面そのもの（ログイン代わり）</strong>です。</p>
       <ol>
         <li><strong>けろ先生用URL</strong>を発行（最初の1回だけ）</li>
         <li>そのURLを<strong>必ずブックマーク</strong>。以後はそこから開く</li>
         <li>選手用URLは「選手追加」時に自動発行</li>
       </ol>
       <p class="warn-note">⚠ 発行ボタンを押すたびに<strong>別の空の帳面</strong>ができます。何度も押さないでください。</p>`;

  root.innerHTML = `
    ${recallHtml}
    <div class="setup-card">
      <h2>${issueTitle}</h2>
      ${issueNote}
      <button class="btn ${recalled ? 'btn-secondary' : 'btn-primary'}" id="genTeacherBtn">けろ先生用URLを発行する</button>
      <div id="genTeacherResult" style="margin-top:16px"></div>
      ${hasLegacy ? `
        <hr style="margin:24px 0;border:none;border-top:1px solid #ddd">
        <p class="small">※ この端末には旧バージョンのデータが残っています。けろ先生用URLを発行してログイン後、設定画面から移行できます。</p>
      ` : ''}
    </div>
  `;

  const forgetBtn = document.getElementById('forgetTeacherBtn');
  if (forgetBtn) {
    forgetBtn.addEventListener('click', () => {
      if (!confirm('この端末からけろ先生用URLの記憶を消します。\nURL自体は無効になりません（ブックマークが別にあれば使えます）。よろしいですか？')) return;
      forgetTeacherUrl();
      render();
    });
  }

  document.getElementById('genTeacherBtn').addEventListener('click', () => {
    if (recalled && !confirm('前回とは別の、空っぽの新しい帳面を作ります。\n（今までの選手・記録は引き継がれません）\n本当に新しく作りますか？')) return;
    const token = genToken(24); // 48 hex chars
    const url = `${location.origin}${location.pathname}?t=${token}`;
    rememberTeacherUrl(url); // この端末に覚えておく
    document.getElementById('genTeacherResult').innerHTML = `
      <p><strong>あなた専用のURLです（必ずブックマーク・他言厳禁）</strong></p>
      <textarea readonly class="form-textarea short" style="font-size:12px">${url}</textarea>
      <a class="btn btn-primary" href="${url}" style="display:inline-block;margin-top:8px;text-decoration:none">このURLで開く</a>
      <p class="small" style="margin-top:8px">このURLはこの端末が覚えました。次からはトップ画面の「前回の帳面を開く」からも入れます。</p>
    `;
  });
}

function renderHome(root) {
  if (mode === 'student') {
    state.activeStudentToken = studentToken;
  } else {
    if (!state.activeStudentToken && state.students.length > 0) {
      state.activeStudentToken = state.students[0].token;
    }
  }

  if (mode === 'teacher' && state.students.length === 0) {
    root.innerHTML = `
      <div class="empty">
        まだ選手が登録されていません。<br>
        右上の <strong>⚙</strong> から追加してください。
        <div class="small" style="margin-top:18px">最初の一人を入れたら、まず断片を一つ。</div>
      </div>
    `;
    return;
  }

  if (mode === 'student' && !state.activeStudentToken) {
    root.innerHTML = `<div class="empty">URLが正しくありません。</div>`;
    return;
  }

  let studentBar = '';
  if (mode === 'teacher') {
    studentBar = `<div class="student-bar">${state.students
      .map(s => {
        const cnt = unansweredCount(s.token);
        const badge = cnt > 0 ? `<span class="pill-badge">${cnt}</span>` : '';
        return `<button class="student-pill ${s.token === state.activeStudentToken ? 'active' : ''}" data-token="${s.token}">${escapeHtml(s.name)}${badge}</button>`;
      })
      .join('')}</div>`;
  }

  let filterBar = '';
  if (mode === 'teacher') {
    const total = (state.postsByStudent[state.activeStudentToken] || []).length;
    const unread = unansweredCount(state.activeStudentToken);
    filterBar = `
      <div class="filter-bar">
        <button class="filter-btn ${state.filterMode === 'all' ? 'active' : ''}" data-filter="all">全部 (${total})</button>
        <button class="filter-btn ${state.filterMode === 'unanswered' ? 'active' : ''}" data-filter="unanswered">未返し (${unread})</button>
      </div>
    `;
  }

  let posts = postsForActiveStudent();
  if (mode === 'teacher' && state.filterMode === 'unanswered') {
    posts = posts.filter(p => !p.responses || p.responses.length === 0);
  }

  const emptyMsg = state.filterMode === 'unanswered'
    ? `<div class="empty">未返しの投稿はありません。<br><span class="small">すべての断片に何かが返されている状態です。</span></div>`
    : `<div class="empty">この選手の記録はまだありません。<br><span class="small">「投稿する」から、断片のままで構いません。</span></div>`;

  const timeline = posts.length === 0
    ? emptyMsg
    : `<ul class="timeline">${posts.map(renderPostCard).join('')}</ul>`;

  const dayLetter = state.activeStudentToken ? renderOnThisDayCard(state.activeStudentToken) : '';
  const rereadBtn = state.activeStudentToken
    ? `<button class="link-btn reread-trigger" id="rereadBtn">📖 読み返す</button>`
    : '';
  const journalBtn = mode === 'teacher'
    ? `<button class="link-btn journal-trigger" id="journalBtn">🛋 楽屋へ</button>`
    : '';
  // けろ先生：いま選んでいる選手にお題を渡す導線
  const promptBtn = (mode === 'teacher' && state.activeStudentToken)
    ? `<button class="link-btn prompt-trigger" id="promptBtn">🎯 お題を渡す</button>`
    : '';

  // 選手：けろ先生から届いた、まだ答えていないお題
  let promptCards = '';
  if (mode === 'student') {
    const open = openPromptsFor(studentToken);
    if (open.length > 0) {
      promptCards = `<div class="prompt-inbox">${open.map(p => `
        <button class="prompt-card" data-prompt-id="${p.id}">
          <span class="prompt-card-label">けろ先生からのお題</span>
          <span class="prompt-card-body">${escapeHtml(p.body)}</span>
          <span class="prompt-card-cta">この問いに、断片で答える →</span>
        </button>`).join('')}</div>`;
    }
  }

  root.innerHTML = `
    ${studentBar}
    ${dayLetter}
    ${promptCards}
    ${filterBar}
    <div class="home-actions">
      <button class="compose-btn" id="composeBtn">＋ 投稿する</button>
      ${rereadBtn}
      ${promptBtn}
      ${journalBtn}
    </div>
    ${timeline}
  `;

  root.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.filterMode = btn.dataset.filter;
      render();
    });
  });

  const rereadBtnEl = document.getElementById('rereadBtn');
  if (rereadBtnEl) {
    rereadBtnEl.addEventListener('click', () => navigate('reread'));
  }

  const journalBtnEl = document.getElementById('journalBtn');
  if (journalBtnEl) {
    journalBtnEl.addEventListener('click', () => navigate('journal'));
  }

  const promptBtnEl = document.getElementById('promptBtn');
  if (promptBtnEl) {
    promptBtnEl.addEventListener('click', () => navigate('prompt'));
  }

  root.querySelectorAll('.prompt-card').forEach(el => {
    el.addEventListener('click', () => navigate('compose', { answeringPromptId: el.dataset.promptId }));
  });

  const dayLetterEl = root.querySelector('.day-letter-card');
  if (dayLetterEl) {
    dayLetterEl.addEventListener('click', () => navigate('detail', { postId: dayLetterEl.dataset.postId }));
  }

  root.querySelectorAll('.student-pill').forEach(el => {
    el.addEventListener('click', () => {
      state.activeStudentToken = el.dataset.token;
      render();
    });
  });
  document.getElementById('composeBtn').addEventListener('click', () => navigate('compose'));
  root.querySelectorAll('.post-card').forEach(el => {
    el.addEventListener('click', () => navigate('detail', { postId: el.dataset.postId }));
  });
}

function renderPostCard(post) {
  const chips = (post.categories || []).map(c => `<span class="cat-chip ${c}">${CAT_LABEL[c] || c}</span>`).join(' ');
  const respCount = (post.responses || []).length;
  const respLine = respCount > 0 ? `地の文返し ${respCount}件` : '返しはまだ';
  const bodyHtml = post.body
    ? `<div class="post-body">${escapeHtml(post.body)}</div>`
    : `<div class="post-body silent">（無言の便り）</div>`;
  // 選手側：まだ受け取っていない地の文返しに「届いた印」
  // 未読のときは件数を省き、バッジだけにする（狭幅でも1行に収まり、窮屈にならない）
  const unread = mode === 'student' && hasUnreadTeacherResponse(post);
  const footInner = unread
    ? `<span class="unread-dot">新しい返しが届いています</span>`
    : respLine;
  return `
    <li class="post-card ${unread ? 'has-unread' : ''}" data-post-id="${post.id}">
      <div class="post-meta">
        <span class="post-date">${fmtDate(post.date)}</span>
        ${chips}
      </div>
      ${bodyHtml}
      <div class="post-foot">${footInner}</div>
    </li>
  `;
}

function renderCompose(root) {
  const studentName = mode === 'teacher'
    ? (state.students.find(s => s.token === state.activeStudentToken)?.name || '?')
    : '（自分）';

  // 編集モード判定：state.editingPostId が設定されていれば編集
  const editingId = state.editingPostId;
  const targetToken = mode === 'student' ? studentToken : state.activeStudentToken;
  let editingPost = null;
  if (editingId) {
    const posts = state.postsByStudent[targetToken] || [];
    editingPost = posts.find(p => p.id === editingId);
  }
  const isEdit = !!editingPost;

  // お題に答えるモード（選手がホームのお題カードから来たとき）
  const answeringPrompt = (!isEdit && state.answeringPromptId)
    ? (state.promptsByStudent[targetToken] || []).find(p => p.id === state.answeringPromptId)
    : null;

  const initial = {
    date: editingPost?.date || todayISO(),
    body: editingPost?.body || '',
    photoData: editingPost?.photoData || editingPost?.photoUrl || '', // 旧データ互換
    categories: editingPost?.categories || [],
  };

  const promptQuoteHtml = answeringPrompt
    ? `<div class="compose-prompt-quote">
         <span class="compose-prompt-quote-label">けろ先生からのお題</span>
         <span class="compose-prompt-quote-body">${escapeHtml(answeringPrompt.body)}</span>
       </div>`
    : '';

  root.innerHTML = `
    ${promptQuoteHtml}
    <div class="form-group">
      <label class="form-label">選手</label>
      <div style="font-size:15px;">${escapeHtml(studentName)}</div>
    </div>
    <div class="form-group">
      <label class="form-label" for="dateInput">日付</label>
      <input class="form-input" type="date" id="dateInput" value="${initial.date}">
    </div>
    <div class="form-group">
      <label class="form-label">カテゴリ（任意・複数可）</label>
      <div class="cat-toggles">
        ${CATEGORIES.map(c => `<button type="button" class="cat-toggle ${initial.categories.includes(c.id) ? 'on' : ''}" data-cat="${c.id}">${c.label}</button>`).join('')}
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="bodyInput">本文（書かなくてもOK）</label>
      <textarea class="form-textarea" id="bodyInput" placeholder="${escapeHtml(randomPrompt())}">${escapeHtml(initial.body)}</textarea>
      <div class="small prompt-hint">問いはきっかけ。書かないという選択もここでは正解です。</div>
    </div>
    <div class="form-group">
      <label class="form-label">写真（任意）</label>
      <input type="file" id="photoFileInput" accept="image/*" capture="environment" style="display:none">
      <div class="photo-zone">
        <img id="photoPreview" class="photo-preview ${initial.photoData ? '' : 'hidden'}" src="${initial.photoData || ''}" alt="">
        <div class="photo-actions">
          <button type="button" class="btn btn-secondary" id="pickPhotoBtn">${initial.photoData ? '別の写真に差し替える' : '📷 写真を選ぶ'}</button>
          ${initial.photoData ? `<button type="button" class="btn btn-secondary" id="removePhotoBtn">写真を外す</button>` : ''}
        </div>
        <div class="small" id="photoStatus"></div>
      </div>
    </div>
    <button class="btn btn-primary" id="saveBtn">${isEdit ? '上書き保存' : '保存する'}</button>
  `;

  const selectedCats = new Set(initial.categories);
  let currentPhotoData = initial.photoData;

  root.querySelectorAll('.cat-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = btn.dataset.cat;
      if (selectedCats.has(c)) {
        selectedCats.delete(c);
        btn.classList.remove('on');
      } else {
        selectedCats.add(c);
        btn.classList.add('on');
      }
    });
  });

  // 写真選択ハンドラ
  const fileInput = document.getElementById('photoFileInput');
  const pickBtn = document.getElementById('pickPhotoBtn');
  const preview = document.getElementById('photoPreview');
  const photoStatus = document.getElementById('photoStatus');

  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    photoStatus.textContent = '画像を準備中…';
    try {
      currentPhotoData = await resizeImageToDataURL(file, 1280, 0.7);
      preview.src = currentPhotoData;
      preview.classList.remove('hidden');
      pickBtn.textContent = '別の写真に差し替える';
      // サイズ表示（KB）
      const sizeKB = Math.round(currentPhotoData.length * 0.75 / 1024);
      photoStatus.textContent = `読み込み完了（約${sizeKB}KB）`;
      // 「写真を外す」ボタンを動的追加
      let removeBtn = document.getElementById('removePhotoBtn');
      if (!removeBtn) {
        removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn btn-secondary';
        removeBtn.id = 'removePhotoBtn';
        removeBtn.textContent = '写真を外す';
        pickBtn.parentNode.appendChild(removeBtn);
        removeBtn.addEventListener('click', removePhoto);
      }
    } catch (err) {
      photoStatus.textContent = '読み込みに失敗：' + err.message;
    }
  });

  function removePhoto() {
    currentPhotoData = '';
    preview.src = '';
    preview.classList.add('hidden');
    fileInput.value = '';
    pickBtn.textContent = '📷 写真を選ぶ';
    photoStatus.textContent = '';
    const removeBtn = document.getElementById('removePhotoBtn');
    if (removeBtn) removeBtn.remove();
  }
  const initialRemoveBtn = document.getElementById('removePhotoBtn');
  if (initialRemoveBtn) initialRemoveBtn.addEventListener('click', removePhoto);

  document.getElementById('saveBtn').addEventListener('click', async () => {
    const date = document.getElementById('dateInput').value || todayISO();
    const body = document.getElementById('bodyInput').value.trim();
    const photoData = currentPhotoData;
    // 無言ポスト許容：何もなくても投稿成立。日付・カテゴリだけの「いた印」も断片の最小単位
    if (!targetToken) {
      alert('対象の選手が選ばれていません。');
      return;
    }

    // 失敗時の保険：未送信の下書きをlocalStorageに退避（写真は重いので含めない）
    const draftKey = isEdit ? `badcho.draft.edit.${editingId}` : 'badcho.draft';
    const draft = { date, body, categories: Array.from(selectedCats), savedAt: Date.now() };
    localStorage.setItem(draftKey, JSON.stringify(draft));

    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    btn.textContent = isEdit ? '更新中…' : '保存中…';
    try {
      const payload = { date, body, photoData, categories: Array.from(selectedCats) };
      if (isEdit) {
        await updatePost(targetToken, editingId, payload);
        localStorage.removeItem(draftKey);
        state.editingPostId = null;
        navigate('detail', { postId: editingId });
      } else {
        if (answeringPrompt) payload.fromPromptId = answeringPrompt.id;
        const id = await createPost(targetToken, payload);
        localStorage.removeItem(draftKey);
        if (answeringPrompt) {
          await markPromptAnswered(targetToken, answeringPrompt.id, id).catch(() => {});
          state.answeringPromptId = null;
        }
        navigate('detail', { postId: id });
      }
    } catch (err) {
      console.error(err);
      alert('保存に失敗しました。下書きはこの端末に残っています。\n' + err.message);
      btn.disabled = false;
      btn.textContent = isEdit ? '上書き保存' : '保存する';
    }
  });

  // 下書き復元（新規投稿時のみ）
  if (!isEdit) {
    const draftRaw = localStorage.getItem('badcho.draft');
    if (draftRaw) {
      try {
        const draft = JSON.parse(draftRaw);
        if (confirm('前回保存できなかった下書きを復元しますか？')) {
          document.getElementById('dateInput').value = draft.date || todayISO();
          document.getElementById('bodyInput').value = draft.body || '';
          // 写真は下書きには含めない（容量都合）
          (draft.categories || []).forEach(c => {
            const btn = root.querySelector(`.cat-toggle[data-cat="${c}"]`);
            if (btn) {
              selectedCats.add(c);
              btn.classList.add('on');
            }
          });
        } else {
          localStorage.removeItem('badcho.draft');
        }
      } catch {
        // ignore
      }
    }
  }
}

function renderDetail(root) {
  const targetToken = mode === 'student' ? studentToken : state.activeStudentToken;
  const posts = state.postsByStudent[targetToken] || [];
  const post = posts.find(p => p.id === state.activePostId);
  if (!post) {
    navigate('home');
    return;
  }
  const chips = (post.categories || []).map(c => `<span class="cat-chip ${c}">${CAT_LABEL[c] || c}</span>`).join(' ');
  const photoSrc = getPhotoSrc(post);
  const photoBlock = photoSrc
    ? `<img class="detail-photo" src="${photoSrc.startsWith('data:') ? photoSrc : escapeHtml(photoSrc)}" alt="">`
    : '';

  const responses = (post.responses || []).slice().sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
  const responsesHtml = responses.length === 0
    ? `<div class="empty" style="padding:20px 0">まだ往復はありません。</div>`
    : responses.map(r => {
        const from = r.from || 'teacher';
        const fromLabel = from === 'teacher' ? 'けろ先生' : 'あなた';
        // 受け取りのしるべ：けろ先生から見て、選手がこの返しを読んだか（採点ではなく受領の気配）
        const readByStudent = post.studentReadAt && r.createdAt <= post.studentReadAt;
        const receiptHtml = (mode === 'teacher' && from === 'teacher')
          ? `<div class="receipt ${readByStudent ? 'read' : 'unread'}">${
              readByStudent
                ? `🌱 選手が受け取りました · ${fmtAgo(post.studentReadAt)}`
                : 'まだ受け取りの気配はありません'
            }</div>`
          : '';
        return `
        <div class="response-item from-${from}">
          <div class="ts"><span class="from-label">${fromLabel}</span> · ${fmtTimestamp(r.createdAt)}</div>
          <div class="body">${escapeHtml(r.body)}</div>
          ${receiptHtml}
        </div>
      `;
      }).join('');

  // 返信フォーム（コーチ・選手の両方が書けるが、UIや文言を分ける）
  let responseFormHtml = '';
  if (mode === 'teacher') {
    responseFormHtml = `
      <div class="response-form">
        <p class="hint">採点や指示ではなく、情景・観察・例えで。</p>
        <textarea class="form-textarea short" id="responseInput" placeholder="その日のコートに見えた風景を、地の文で。"></textarea>
        <div class="draft-status" id="draftStatus"></div>
        <button class="btn btn-primary" id="addResponseBtn" style="margin-top:8px">返しを記す</button>
      </div>
    `;
  } else if (mode === 'student') {
    responseFormHtml = `
      <div class="response-form student-reply">
        <p class="hint">けろ先生への返し・追記・気づいたことなど。</p>
        <textarea class="form-textarea short" id="responseInput" placeholder="（自由に）"></textarea>
        <button class="btn btn-primary" id="addResponseBtn" style="margin-top:8px">返す</button>
      </div>
    `;
  }

  // 操作ボタン：けろ先生 or 選手の両方が削除可、選手は編集可
  let actionBtns = [];
  if (mode === 'student') {
    actionBtns.push(`<button class="btn btn-secondary" id="editPostBtn">この投稿を編集</button>`);
    actionBtns.push(`<button class="btn btn-danger" id="deletePostBtn">この投稿を削除</button>`);
  } else if (mode === 'teacher') {
    actionBtns.push(`<button class="btn btn-danger" id="deletePostBtn">この投稿を削除</button>`);
  }
  const actionsHtml = actionBtns.length > 0
    ? `<div class="row-actions">${actionBtns.join('')}</div>`
    : '';

  const detailBodyHtml = post.body
    ? `<div class="detail-body">${escapeHtml(post.body)}</div>`
    : `<div class="detail-body silent">（無言の便り）</div>`;

  root.innerHTML = `
    <article class="detail-post">
      <div class="post-meta">
        <span class="post-date">${fmtDate(post.date)}</span>
        ${chips}
      </div>
      ${detailBodyHtml}
      ${photoBlock}
    </article>

    ${mode === 'student' ? `<div class="reading-banner hidden" id="readingBanner"></div>` : ''}

    <section class="responses-section">
      <h3>${mode === 'student' ? 'けろ先生からのメッセージ' : '地の文返し'}</h3>
      ${responsesHtml}
      ${responseFormHtml}
    </section>

    ${actionsHtml}
  `;

  if (mode === 'teacher') {
    const ta = document.getElementById('responseInput');
    const status = document.getElementById('draftStatus');

    // 下書きの読み込み（別端末で書きかけた続きをここで再開）
    loadCoachDraft(post.id).then(draft => {
      if (draft && ta && ta.value === '') {
        ta.value = draft.body;
        const ago = fmtAgo(draft.updatedAt);
        status.textContent = `（${ago}の下書きを読み込みました）`;
      }
    });

    // タイピング1.5秒静止で自動保存
    let draftTimer;
    ta.addEventListener('input', () => {
      clearTimeout(draftTimer);
      status.textContent = '入力中…';
      draftTimer = setTimeout(async () => {
        await saveCoachDraft(post.id, ta.value);
        status.textContent = ta.value.trim() ? '下書きを保存しました' : '';
      }, 1500);
    });

    document.getElementById('addResponseBtn').addEventListener('click', async () => {
      const body = ta.value.trim();
      if (!body) return;
      const btn = document.getElementById('addResponseBtn');
      btn.disabled = true;
      try {
        await appendResponse(targetToken, post.id, body, 'teacher');
        await clearCoachDraft(post.id);
        ta.value = '';
        status.textContent = '';
      } catch (err) {
        alert('返しの保存に失敗しました：' + err.message);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('deletePostBtn').addEventListener('click', async () => {
      if (!confirm('この投稿を削除しますか？（取り消せません）')) return;
      try {
        await deletePost(targetToken, post.id);
        navigate('home');
      } catch (err) {
        alert('削除に失敗しました：' + err.message);
      }
    });
  }

  if (mode === 'student') {
    // 受け取りのしるべ：開いた時点で、まだ受け取っていない地の文返しを既読にする
    if (hasUnreadTeacherResponse(post)) {
      markPostRead(targetToken, post.id);
    }

    document.getElementById('addResponseBtn').addEventListener('click', async () => {
      const ta = document.getElementById('responseInput');
      const body = ta.value.trim();
      if (!body) return;
      const btn = document.getElementById('addResponseBtn');
      btn.disabled = true;
      try {
        await appendResponse(targetToken, post.id, body, 'student');
        ta.value = '';
      } catch (err) {
        alert('返信の保存に失敗しました：' + err.message);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('editPostBtn').addEventListener('click', () => {
      navigate('compose', { editingPostId: post.id });
    });

    document.getElementById('deletePostBtn').addEventListener('click', async () => {
      if (!confirm('この投稿を削除しますか？（取り消せません）\n\n地の文返しなど、すべての往復もまとめて消えます。')) return;
      try {
        await deletePost(targetToken, post.id);
        navigate('home');
      } catch (err) {
        alert('削除に失敗しました：' + err.message);
      }
    });

    // 「けろ先生がいま読んでいる」シグナル：postドキュメントを購読してcoachActiveSinceを監視
    const banner = document.getElementById('readingBanner');
    let displayTimer = null;
    const updateBanner = (activeSince) => {
      if (!activeSince) {
        banner.classList.add('hidden');
        return;
      }
      const ageMs = Date.now() - new Date(activeSince).getTime();
      if (ageMs < 60000) {
        banner.textContent = 'けろ先生がいま、あなたの言葉を読んでいる最中です。';
        banner.classList.remove('hidden');
      } else {
        banner.classList.add('hidden');
      }
    };
    const unsubPost = onSnapshot(postRef(targetToken, post.id), snap => {
      const data = snap.data();
      if (data && data.coachActiveSince) {
        updateBanner(data.coachActiveSince);
        if (displayTimer) clearInterval(displayTimer);
        displayTimer = setInterval(() => updateBanner(data.coachActiveSince), 10000);
      } else {
        updateBanner(null);
      }
    });
    state.cleanupHandlers.push(() => {
      unsubPost();
      if (displayTimer) clearInterval(displayTimer);
    });
  }

  // けろ先生のpresence送信（heartbeat）
  // 投稿を開くたびに1回だけ初期化する（再レンダーでは再起動しない＝無限ループ防止）
  if (mode === 'teacher' && presencePostId !== post.id) {
    presencePostId = post.id;
    const presenceToken = targetToken;
    const presencePost = post.id;
    const sendPresence = async () => {
      try {
        await updateDoc(postRef(presenceToken, presencePost), {
          coachActiveSince: new Date().toISOString(),
        });
      } catch {}
    };
    sendPresence();
    const heartbeat = setInterval(sendPresence, 30000);
    state.cleanupHandlers.push(() => {
      clearInterval(heartbeat);
      presencePostId = null;
      // 離脱時にpresenceクリア
      updateDoc(postRef(presenceToken, presencePost), { coachActiveSince: null }).catch(() => {});
    });
  }
}

function renderJournal(root) {
  if (mode !== 'teacher') {
    root.innerHTML = `<div class="empty">この画面はけろ先生専用です。</div>`;
    return;
  }

  const studentOptions = `
    <option value="">紐付けない</option>
    ${state.students.map(s => `<option value="${s.token}">${escapeHtml(s.name)}</option>`).join('')}
  `;

  const entries = state.journal || [];
  const entriesHtml = entries.length === 0
    ? `<div class="empty">まだ何も書かれていません。<br><span class="small">楽屋は誰にも見えない、けろ先生だけの場所です。</span></div>`
    : entries.map(e => {
        const linked = e.attachedTo ? state.students.find(s => s.token === e.attachedTo)?.name : null;
        const linkedTag = linked ? `<span class="journal-tag">${escapeHtml(linked)}</span>` : '';
        return `
          <article class="journal-entry" data-entry-id="${e.id}">
            <header class="journal-entry-head">
              <time class="journal-time">${fmtAgo(e.createdAt)}</time>
              ${linkedTag}
              <button class="link-btn" data-action="edit-entry">編集</button>
              <button class="link-btn" data-action="delete-entry">削除</button>
            </header>
            <div class="journal-body">${escapeHtml(e.body)}</div>
          </article>
        `;
      }).join('');

  root.innerHTML = `
    <div class="journal-intro">
      ここはけろ先生だけの楽屋。<br>
      選手には見えない、地の文返しを練る前のメモ・観察・独白を置いておく場所です。
    </div>

    <section class="journal-form">
      <textarea class="form-textarea" id="journalInput" placeholder="今日のあの子のこと、コートで気になった一場面、地の文返しのラフ…"></textarea>
      <div class="journal-form-row">
        <label class="form-label" style="font-size:12px;margin:0">紐付け先（任意）：</label>
        <select id="journalAttach" class="reread-month-select">${studentOptions}</select>
        <button class="btn btn-primary" id="addJournalBtn">書き留める</button>
      </div>
    </section>

    <div class="journal-entries">
      ${entriesHtml}
    </div>
  `;

  document.getElementById('addJournalBtn').addEventListener('click', async () => {
    const ta = document.getElementById('journalInput');
    const attached = document.getElementById('journalAttach').value;
    const body = ta.value.trim();
    if (!body) return;
    const btn = document.getElementById('addJournalBtn');
    btn.disabled = true;
    try {
      await addJournalEntry(body, attached);
      ta.value = '';
      document.getElementById('journalAttach').value = '';
    } catch (err) {
      alert('保存に失敗しました：' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  root.querySelectorAll('.journal-entry').forEach(el => {
    const id = el.dataset.entryId;
    el.querySelector('[data-action="edit-entry"]').addEventListener('click', async () => {
      const cur = state.journal.find(e => e.id === id);
      const newBody = prompt('編集（地の文を整える）', cur.body);
      if (newBody !== null && newBody.trim() !== cur.body) {
        try {
          await updateJournalEntry(id, newBody.trim(), cur.attachedTo);
        } catch (err) {
          alert('更新に失敗しました：' + err.message);
        }
      }
    });
    el.querySelector('[data-action="delete-entry"]').addEventListener('click', async () => {
      if (!confirm('この一筆を削除しますか？（取り消せません）')) return;
      try {
        await deleteJournalEntry(id);
      } catch (err) {
        alert('削除に失敗しました：' + err.message);
      }
    });
  });
}

function renderPrompt(root) {
  if (mode !== 'teacher') {
    root.innerHTML = `<div class="empty">この画面はけろ先生専用です。</div>`;
    return;
  }
  const tk = state.activeStudentToken;
  const student = state.students.find(s => s.token === tk);
  if (!tk || !student) {
    root.innerHTML = `<div class="empty">選手が選ばれていません。<br><span class="small">ホームで選手を選んでから、お題を渡してください。</span></div>`;
    return;
  }

  const prompts = (state.promptsByStudent[tk] || []).slice()
    .sort((a, b) => {
      // 未回答を上に、その中で新しい順
      const aOpen = a.status !== 'answered';
      const bOpen = b.status !== 'answered';
      if (aOpen !== bOpen) return aOpen ? -1 : 1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });

  const listHtml = prompts.length === 0
    ? `<div class="empty" style="padding:16px 0">まだお題はありません。<br><span class="small">問いはきっかけ。気が向いた一言を、そっと置いてみてください。</span></div>`
    : prompts.map(p => {
        const answered = p.status === 'answered';
        const statusTag = answered
          ? `<span class="prompt-status answered">答えが返ってきました · ${fmtAgo(p.answeredAt)}</span>`
          : `<span class="prompt-status open">まだ答えを待っています</span>`;
        const openLink = answered && p.answeredPostId
          ? `<button class="link-btn" data-action="open-answer" data-post-id="${p.answeredPostId}">答えを見る</button>`
          : '';
        return `
          <article class="prompt-entry ${answered ? 'is-answered' : ''}" data-prompt-id="${p.id}">
            <div class="prompt-entry-body">${escapeHtml(p.body)}</div>
            <div class="prompt-entry-foot">
              ${statusTag}
              <span class="prompt-entry-actions">
                ${openLink}
                <button class="link-btn danger" data-action="delete-prompt">取り消す</button>
              </span>
            </div>
          </article>`;
      }).join('');

  root.innerHTML = `
    <div class="prompt-intro">
      <strong>${escapeHtml(student.name)}</strong> さんへ、お題を渡します。<br>
      <span class="small">指示や課題ではなく、立ち止まるきっかけの一問を。選手のホームにそっと届きます。書かないという選択も、選手の側に残されています。</span>
    </div>

    <section class="prompt-form">
      <textarea class="form-textarea" id="promptInput" placeholder="例：今日いちばん、体が素直に動いた瞬間は？"></textarea>
      <button class="btn btn-primary" id="addPromptBtn" style="margin-top:8px">この問いを渡す</button>
    </section>

    <div class="prompt-list">
      ${listHtml}
    </div>
  `;

  document.getElementById('addPromptBtn').addEventListener('click', async () => {
    const ta = document.getElementById('promptInput');
    const body = ta.value.trim();
    if (!body) return;
    const btn = document.getElementById('addPromptBtn');
    btn.disabled = true;
    try {
      await addPrompt(tk, body);
      ta.value = '';
    } catch (err) {
      alert('お題の保存に失敗しました：' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  root.querySelectorAll('.prompt-entry').forEach(el => {
    const id = el.dataset.promptId;
    const delBtn = el.querySelector('[data-action="delete-prompt"]');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm('このお題を取り消しますか？')) return;
        try {
          await deletePrompt(tk, id);
        } catch (err) {
          alert('取り消しに失敗しました：' + err.message);
        }
      });
    }
    const openBtn = el.querySelector('[data-action="open-answer"]');
    if (openBtn) {
      openBtn.addEventListener('click', () => navigate('detail', { postId: openBtn.dataset.postId }));
    }
  });
}

function renderArchive() {
  const back = document.getElementById('backBtn');
  const settings = document.getElementById('settingsBtn');
  const title = document.getElementById('headerTitle');
  back.classList.add('hidden');
  settings.classList.add('hidden');
  title.textContent = 'バド帖 アーカイブ';

  document.body.classList.add('archive-mode');

  const tk = archiveStudentToken;
  const student = state.students.find(s => s.token === tk);
  const studentName = student ? student.name : '名前不明';
  const posts = (state.postsByStudent[tk] || []).slice().sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt < b.createdAt ? -1 : 1)
  );
  const responseCount = posts.reduce((sum, p) => sum + (p.responses?.length || 0), 0);

  const dateRange = posts.length > 0
    ? `${fmtDate(posts[0].date)} 〜 ${fmtDate(posts[posts.length - 1].date)}`
    : '記録なし';

  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="archive-no-print">
      <div class="archive-help">
        <h3>このページをPDFで保存</h3>
        <ol>
          <li>キーボードで <strong>Cmd + P</strong>（Macなら）</li>
          <li>「送信先」または「保存先」で <strong>PDFに保存</strong> を選ぶ</li>
          <li>「余白：なし」または「最小」を推奨</li>
          <li>「背景のグラフィック」をオンにすると見栄え良し</li>
          <li>保存先・ファイル名（例：${studentName}_バド帖アーカイブ.pdf）を選んで完了</li>
        </ol>
        <button class="btn btn-primary" onclick="window.print()">印刷ダイアログを開く</button>
      </div>
    </div>

    <article class="archive-cover">
      <div class="archive-title">バド帖</div>
      <div class="archive-subtitle">${escapeHtml(studentName)} の記録</div>
      <div class="archive-period">${dateRange}</div>
      <div class="archive-stats">全${posts.length}投稿　地の文返し${responseCount}件</div>
    </article>

    <div class="archive-body">
      ${posts.length === 0 ? '<div class="empty">投稿がありません。</div>' : posts.map(renderArchivePage).join('')}
    </div>

    <article class="archive-closing">
      <p>—— ここに書かれているのは、断片です。</p>
      <p>整える前の言葉と、それに連なる地の文。</p>
      <p>歩んだ日々が、すこしでも誰かの何かの力になりますように。</p>
      <div class="archive-credit">バド帖</div>
    </article>
  `;
}

function renderArchivePage(post) {
  const responses = (post.responses || []).slice().sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
  const chips = (post.categories || []).map(c => `${CAT_LABEL[c] || c}`).join('・');
  const bodyHtml = post.body
    ? `<div class="archive-post-body">${escapeHtml(post.body)}</div>`
    : `<div class="archive-post-body silent">（無言の便り）</div>`;
  const archivePhotoSrc = getPhotoSrc(post);
  const photoHtml = archivePhotoSrc
    ? `<img class="archive-photo" src="${archivePhotoSrc.startsWith('data:') ? archivePhotoSrc : escapeHtml(archivePhotoSrc)}" alt="">`
    : '';
  const responsesHtml = responses.length > 0
    ? `<div class="archive-responses">
        ${responses.map(r => {
          const from = r.from || 'teacher';
          const fromLabel = from === 'teacher' ? 'けろ先生' : 'あなた';
          return `<div class="archive-response from-${from}"><span class="archive-response-from">${fromLabel}</span>${escapeHtml(r.body)}</div>`;
        }).join('')}
      </div>`
    : '';
  return `
    <article class="archive-page">
      <header class="archive-page-head">
        <span class="archive-date">${fmtDate(post.date)}</span>
        ${chips ? `<span class="archive-cat">${escapeHtml(chips)}</span>` : ''}
      </header>
      ${bodyHtml}
      ${photoHtml}
      ${responsesHtml}
    </article>
  `;
}

function renderReread(root) {
  const tk = mode === 'student' ? studentToken : state.activeStudentToken;
  if (!tk) {
    navigate('home');
    return;
  }

  const all = (state.postsByStudent[tk] || []).slice().sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt < b.createdAt ? -1 : 1)
  );

  if (all.length === 0) {
    root.innerHTML = `<div class="empty">読み返す断片はまだありません。</div>`;
    return;
  }

  // 月別グループ
  const months = [...new Set(all.map(p => p.date.slice(0, 7)))].sort();
  const monthLabel = m => `${m.slice(0, 4)}年${parseInt(m.slice(5, 7), 10)}月`;

  const monthFilter = state.rereadMonth || 'all';
  const filtered = monthFilter === 'all' ? all : all.filter(p => p.date.startsWith(monthFilter));

  const studentName = mode === 'teacher'
    ? (state.students.find(s => s.token === tk)?.name || '')
    : '';

  root.innerHTML = `
    <div class="reread-controls">
      ${studentName ? `<div class="reread-student">${escapeHtml(studentName)}</div>` : ''}
      <label class="reread-month-label">期間：
        <select id="rereadMonthSelect" class="reread-month-select">
          <option value="all" ${monthFilter === 'all' ? 'selected' : ''}>全部（${all.length}件）</option>
          ${months.map(m => {
            const cnt = all.filter(p => p.date.startsWith(m)).length;
            return `<option value="${m}" ${monthFilter === m ? 'selected' : ''}>${monthLabel(m)}（${cnt}件）</option>`;
          }).join('')}
        </select>
      </label>
    </div>

    <div class="reread-pages">
      ${filtered.map(renderRereadPage).join('')}
    </div>

    <div class="reread-end">— ここまで —</div>
  `;

  document.getElementById('rereadMonthSelect').addEventListener('change', e => {
    state.rereadMonth = e.target.value;
    render();
  });
}

function renderRereadPage(post) {
  const responses = (post.responses || []).slice().sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
  const chips = (post.categories || []).map(c => `<span class="cat-chip ${c}">${CAT_LABEL[c] || c}</span>`).join(' ');
  const bodyHtml = post.body
    ? `<div class="reread-body">${escapeHtml(post.body)}</div>`
    : `<div class="reread-body silent">（無言の便り）</div>`;
  const rereadPhotoSrc = getPhotoSrc(post);
  const photoHtml = rereadPhotoSrc
    ? `<img class="reread-photo" src="${rereadPhotoSrc.startsWith('data:') ? rereadPhotoSrc : escapeHtml(rereadPhotoSrc)}" alt="">`
    : '';
  const responsesHtml = responses.length > 0
    ? `<div class="reread-responses">
        ${responses.map(r => {
          const from = r.from || 'teacher';
          const fromLabel = from === 'teacher' ? 'けろ先生' : 'あなた';
          return `
          <div class="reread-response from-${from}">
            <div class="reread-response-from">${fromLabel}</div>
            <div class="reread-response-body">${escapeHtml(r.body)}</div>
          </div>
          `;
        }).join('')}
      </div>`
    : '';
  return `
    <article class="reread-page">
      <header class="reread-head">
        <span class="reread-date">${fmtDate(post.date)}</span>
        ${chips}
      </header>
      ${bodyHtml}
      ${photoHtml}
      ${responsesHtml}
    </article>
  `;
}

function renderSettings(root) {
  if (mode !== 'teacher') {
    root.innerHTML = `<div class="empty">この画面はけろ先生専用です。</div>`;
    return;
  }

  const studentRows = state.students.length === 0
    ? `<div class="empty" style="padding:12px 0">まだ登録されていません。</div>`
    : state.students.map(s => {
        const url = `${location.origin}${location.pathname}?s=${s.token}`;
        return `
        <div class="student-row" data-token="${s.token}">
          <div style="flex:1;min-width:0">
            <div class="name">${escapeHtml(s.name)}</div>
            <textarea readonly class="form-textarea short" style="font-size:11px;margin-top:6px;color:#666">${url}</textarea>
            <div class="row-actions-inline">
              <button class="link-btn" data-action="copy">URLをコピー</button>
              <button class="link-btn" data-action="qr">QRを表示</button>
              <button class="link-btn" data-action="archive">アーカイブを開く</button>
              <button class="link-btn" data-action="regen">URL再発行</button>
              <button class="link-btn" data-action="remove">名簿から外す</button>
              <button class="link-btn danger" data-action="purge">完全削除</button>
            </div>
            <div class="qr-area hidden" data-qr></div>
          </div>
          <button class="icon-btn" data-action="rename" aria-label="名前変更">✎</button>
        </div>`;
      }).join('');

  const hasLegacy = !!localStorage.getItem(LEGACY_STORAGE_KEY);
  const migrationSection = hasLegacy ? `
    <section class="settings-section">
      <h2>旧データの移行</h2>
      <p style="font-size:13px;color:var(--ink-soft);line-height:1.7">
        この端末に旧バージョン（端末内保存）のデータが残っています。Firestoreへ移行できます。<br>
        移行後も旧データは念のため残ります（手動削除まで保持）。
      </p>
      <button class="btn btn-secondary" id="migrateBtn" style="margin-top:8px">旧データを移行する</button>
      <div id="migrateResult" style="margin-top:8px;font-size:13px"></div>
    </section>
  ` : '';

  root.innerHTML = `
    <section class="settings-section">
      <h2>選手</h2>
      <div id="studentList">${studentRows}</div>
      <div class="add-student-form">
        <input type="text" id="newStudentName" placeholder="名前を追加" maxlength="40">
        <button id="addStudentBtn">追加</button>
      </div>
      <p style="font-size:12px;color:var(--ink-soft);margin-top:8px;line-height:1.7">
        追加すると、その選手専用のURLが発行されます。LINEなどで本人に送ってください。
      </p>
    </section>

    ${migrationSection}

    <section class="settings-section">
      <h2>このツールについて</h2>
      <p style="font-size:13px;color:var(--ink-soft);margin:0;line-height:1.85">
        バド帖は、選手の断片メモを蓄積し、けろ先生が地の文で返すための記録器です。<br>
        整える前の言葉を、そのまま投げ込んでください。
      </p>
    </section>
  `;

  document.getElementById('addStudentBtn').addEventListener('click', addStudentHandler);
  document.getElementById('newStudentName').addEventListener('keydown', e => {
    if (e.key === 'Enter') addStudentHandler();
  });

  root.querySelectorAll('.student-row').forEach(row => {
    const token = row.dataset.token;
    const url = `${location.origin}${location.pathname}?s=${token}`;

    row.querySelector('[data-action="rename"]').addEventListener('click', async () => {
      const cur = state.students.find(s => s.token === token);
      const name = prompt('新しい名前', cur.name);
      if (name && name.trim()) {
        try {
          await updateStudentInIndex(token, { name: name.trim() });
        } catch (err) {
          alert('変更に失敗しました：' + err.message);
        }
      }
    });
    row.querySelector('[data-action="remove"]').addEventListener('click', async () => {
      const cur = state.students.find(s => s.token === token);
      if (!confirm(`${cur.name} さんを名簿から外しますか？\n\n・名簿から消えますが、投稿データはFirestoreに残ります\n・同じURLトークンを再登録すれば復活できます`)) return;
      try {
        await removeStudentFromIndex(token);
      } catch (err) {
        alert('処理に失敗しました：' + err.message);
      }
    });

    row.querySelector('[data-action="purge"]').addEventListener('click', async () => {
      const cur = state.students.find(s => s.token === token);
      const postCount = (state.postsByStudent[token] || []).length;
      const msg = `⚠️ 完全削除：${cur.name} さんと、その投稿 ${postCount}件・地の文返しすべてを永久に削除します。\n\nこの操作は取り消せません。本当に進めますか？`;
      if (!confirm(msg)) return;
      // 二重確認
      const typed = prompt(`念のため確認です。\n選手の名前「${cur.name}」を入力してください：`);
      if (typed !== cur.name) {
        if (typed !== null) alert('名前が一致しないため中止しました。');
        return;
      }
      const btn = row.querySelector('[data-action="purge"]');
      btn.disabled = true;
      btn.textContent = '削除中…';
      try {
        await completelyRemoveStudent(token);
      } catch (err) {
        alert('完全削除に失敗しました：' + err.message);
        btn.disabled = false;
        btn.textContent = '完全削除';
      }
    });

    row.querySelector('[data-action="copy"]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        const btn = row.querySelector('[data-action="copy"]');
        const orig = btn.textContent;
        btn.textContent = 'コピーしました';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      } catch {
        // クリップボード不可な環境では選択して見せる
        row.querySelector('textarea').select();
      }
    });

    row.querySelector('[data-action="qr"]').addEventListener('click', async () => {
      const area = row.querySelector('[data-qr]');
      if (!area.classList.contains('hidden') && area.dataset.shown === '1') {
        area.classList.add('hidden');
        area.dataset.shown = '';
        return;
      }
      area.classList.remove('hidden');
      area.dataset.shown = '1';
      area.innerHTML = '<div class="small">生成中…</div>';
      try {
        const dataUrl = await QRCode.toDataURL(url, { width: 240, margin: 1, color: { dark: '#2b2a26', light: '#ffffff' } });
        area.innerHTML = `<img src="${dataUrl}" alt="QRコード" style="display:block;margin:8px auto;border:1px solid var(--line);border-radius:6px"><div class="small" style="text-align:center">選手のスマホでスキャン</div>`;
      } catch (err) {
        area.innerHTML = `<div class="small" style="color:var(--warn)">QR生成失敗：${escapeHtml(err.message)}</div>`;
      }
    });

    row.querySelector('[data-action="archive"]').addEventListener('click', () => {
      const archiveUrl = `${location.origin}${location.pathname}?t=${teacherToken}&archive=${token}`;
      window.open(archiveUrl, '_blank');
    });

    row.querySelector('[data-action="regen"]').addEventListener('click', async () => {
      const cur = state.students.find(s => s.token === token);
      if (!confirm(`${cur.name} さんのURLを再発行しますか？\n\n・古いURLは即座に使えなくなります\n・過去の投稿は新URLに引き継がれます\n・流出時の対応に使ってください`)) return;
      const btn = row.querySelector('[data-action="regen"]');
      btn.disabled = true;
      btn.textContent = '再発行中…';
      try {
        await regenerateStudentToken(token);
      } catch (err) {
        alert('再発行に失敗しました：' + err.message);
        btn.disabled = false;
        btn.textContent = 'URL再発行';
      }
    });
  });

  if (hasLegacy) {
    document.getElementById('migrateBtn').addEventListener('click', migrateLegacyHandler);
  }
}

async function addStudentHandler() {
  const input = document.getElementById('newStudentName');
  const name = input.value.trim();
  if (!name) return;
  const btn = document.getElementById('addStudentBtn');
  btn.disabled = true;
  try {
    await addStudentToIndex(name);
    input.value = '';
  } catch (err) {
    alert('追加に失敗しました：' + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function migrateLegacyHandler() {
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) return;
  let legacy;
  try {
    legacy = JSON.parse(raw);
  } catch {
    alert('旧データの読み込みに失敗しました。');
    return;
  }
  if (!confirm(`旧データを移行します：\n・選手 ${legacy.students?.length || 0}人\n・投稿 ${legacy.posts?.length || 0}件\n\nよろしいですか？`)) return;

  const result = document.getElementById('migrateResult');
  result.textContent = '移行中…';
  let added = 0;
  let postsAdded = 0;
  try {
    const tokenByOldId = {};
    for (const s of (legacy.students || [])) {
      const newStudent = await addStudentToIndex(s.name);
      tokenByOldId[s.id] = newStudent.token;
      added++;
    }
    for (const p of (legacy.posts || [])) {
      const tk = tokenByOldId[p.studentId];
      if (!tk) continue;
      const id = uid();
      await setDoc(postRef(tk, id), {
        date: p.date,
        createdAt: p.createdAt || new Date().toISOString(),
        categories: p.categories || [],
        body: p.body || '',
        photoUrl: p.photoUrl || '',
        responses: p.responses || [],
      });
      postsAdded++;
    }
    result.innerHTML = `<span style="color:green">✓ 移行完了：選手 ${added}人 / 投稿 ${postsAdded}件</span>`;
  } catch (err) {
    result.innerHTML = `<span style="color:red">移行中にエラー：${escapeHtml(err.message)}</span>`;
  }
}

/* ====== Init ====== */

document.getElementById('backBtn').addEventListener('click', () => navigate('home'));
document.getElementById('settingsBtn').addEventListener('click', () => navigate('settings'));

// ブラウザを閉じる時のクリーンアップ（presenceなど）
window.addEventListener('beforeunload', () => {
  if (state.cleanupHandlers) {
    state.cleanupHandlers.forEach(fn => { try { fn(); } catch {} });
  }
});

async function init() {
  if (mode === 'setup') {
    state.loading = false;
    render();
    return;
  }

  if (mode === 'archive') {
    try {
      // 名簿から名前取得
      await loadTeacherIndex();
      // 投稿を一度だけ取得（購読しない）
      const snap = await getDocs(query(
        collection(db, 'students', archiveStudentToken, 'posts'),
        orderBy('date', 'asc')
      ));
      const posts = [];
      snap.forEach(d => posts.push({ id: d.id, ...d.data() }));
      state.postsByStudent[archiveStudentToken] = posts;
      state.activeStudentToken = archiveStudentToken;
      state.loading = false;
      renderArchive();
      return;
    } catch (err) {
      document.getElementById('main').innerHTML = `<div class="empty">アーカイブの読み込みに失敗しました：${escapeHtml(err.message)}</div>`;
      return;
    }
  }

  try {
    if (mode === 'teacher') {
      // けろ先生用URLで開けたら、この端末に覚えておく（次回トップから戻れる・迷子防止）
      rememberTeacherUrl(`${location.origin}${location.pathname}?t=${teacherToken}`);
      await loadTeacherIndex();
      subscribeTeacherIndex();
      state.students.forEach(s => {
        subscribeStudentPosts(s.token);
        subscribeStudentPrompts(s.token);
      });
      subscribeJournal();
    } else if (mode === 'student') {
      subscribeStudentPosts(studentToken);
      subscribeStudentPrompts(studentToken);
      state.activeStudentToken = studentToken;
    }
    state.loading = false;
    render();
  } catch (err) {
    console.error(err);
    state.loading = false;
    state.error = err.message;
    document.getElementById('main').innerHTML = `
      <div class="empty">
        接続に失敗しました。<br>
        <span class="small">${escapeHtml(err.message)}</span><br>
        <span class="small" style="margin-top:12px;display:block">URLが正しいか、ネット接続を確認してください。</span>
      </div>`;
  }
}

init();

// PWA Service Worker 登録
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('SW registration failed', err);
    });
  });
}
