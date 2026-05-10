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

const CATEGORIES = [
  { id: 'match', label: '試合' },
  { id: 'practice', label: '練習' },
  { id: 'technique', label: '技術' },
  { id: 'tactics', label: '戦術' },
  { id: 'body', label: '体' },
  { id: 'mind', label: '心' },
  { id: 'gear', label: '道具' },
];
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
};

const subscriptions = new Map();

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
  state.view = view;
  if ('postId' in opts) state.activePostId = opts.postId;
  if ('studentToken' in opts) state.activeStudentToken = opts.studentToken;
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
      state.students.forEach(s => subscribeStudentPosts(s.token));
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
  await deleteDoc(postRef(token, postId));
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

async function appendResponse(token, postId, body) {
  const response = {
    id: uid(),
    createdAt: new Date().toISOString(),
    body,
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
    })[state.view] || 'バド帖';
  }

  if (state.view === 'home') renderHome(main);
  else if (state.view === 'compose') renderCompose(main);
  else if (state.view === 'detail') renderDetail(main);
  else if (state.view === 'settings') renderSettings(main);
  else if (state.view === 'reread') renderReread(main);
  else if (state.view === 'journal') renderJournal(main);
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
  root.innerHTML = `
    <div class="setup-card">
      <h2>はじめに</h2>
      <p>バド帖は、URLにトークンを付けて使います。</p>
      <ol>
        <li><strong>けろ先生用URL</strong>を発行してください（このボタン）</li>
        <li>そのURLをブックマーク</li>
        <li>選手用URLは「選手追加」時に自動発行</li>
      </ol>
      <button class="btn btn-primary" id="genTeacherBtn">けろ先生用URLを発行する</button>
      <div id="genTeacherResult" style="margin-top:16px"></div>
      ${hasLegacy ? `
        <hr style="margin:24px 0;border:none;border-top:1px solid #ddd">
        <p class="small">※ この端末には旧バージョンのデータが残っています。けろ先生用URLを発行してログイン後、設定画面から移行できます。</p>
      ` : ''}
    </div>
  `;
  document.getElementById('genTeacherBtn').addEventListener('click', () => {
    const token = genToken(24); // 48 hex chars
    const url = `${location.origin}${location.pathname}?t=${token}`;
    document.getElementById('genTeacherResult').innerHTML = `
      <p><strong>あなた専用のURLです（必ずブックマーク・他言厳禁）</strong></p>
      <textarea readonly class="form-textarea short" style="font-size:12px">${url}</textarea>
      <a class="btn btn-primary" href="${url}" style="display:inline-block;margin-top:8px;text-decoration:none">このURLで開く</a>
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

  root.innerHTML = `
    ${studentBar}
    ${dayLetter}
    ${filterBar}
    <div class="home-actions">
      <button class="compose-btn" id="composeBtn">＋ 投稿する</button>
      ${rereadBtn}
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
  return `
    <li class="post-card" data-post-id="${post.id}">
      <div class="post-meta">
        <span class="post-date">${fmtDate(post.date)}</span>
        ${chips}
      </div>
      ${bodyHtml}
      <div class="post-foot">${respLine}</div>
    </li>
  `;
}

function renderCompose(root) {
  const studentName = mode === 'teacher'
    ? (state.students.find(s => s.token === state.activeStudentToken)?.name || '?')
    : '（自分）';

  root.innerHTML = `
    <div class="form-group">
      <label class="form-label">選手</label>
      <div style="font-size:15px;">${escapeHtml(studentName)}</div>
    </div>
    <div class="form-group">
      <label class="form-label" for="dateInput">日付</label>
      <input class="form-input" type="date" id="dateInput" value="${todayISO()}">
    </div>
    <div class="form-group">
      <label class="form-label">カテゴリ（任意・複数可）</label>
      <div class="cat-toggles">
        ${CATEGORIES.map(c => `<button type="button" class="cat-toggle" data-cat="${c.id}">${c.label}</button>`).join('')}
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="bodyInput">本文（書かなくてもOK）</label>
      <textarea class="form-textarea" id="bodyInput" placeholder="今日のひと言・気になったこと・うまくいかなかった一場面…&#10;（何も書かずに「いた印」だけ残してもいい）"></textarea>
    </div>
    <div class="form-group">
      <label class="form-label" for="photoInput">写真URL（任意）</label>
      <input class="form-input" type="url" id="photoInput" placeholder="https://...">
    </div>
    <button class="btn btn-primary" id="saveBtn">保存する</button>
  `;

  const selectedCats = new Set();
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

  document.getElementById('saveBtn').addEventListener('click', async () => {
    const date = document.getElementById('dateInput').value || todayISO();
    const body = document.getElementById('bodyInput').value.trim();
    const photoUrl = document.getElementById('photoInput').value.trim();
    // 無言ポスト許容：何もなくても投稿成立。日付・カテゴリだけの「いた印」も断片の最小単位
    const targetToken = mode === 'student' ? studentToken : state.activeStudentToken;
    if (!targetToken) {
      alert('対象の選手が選ばれていません。');
      return;
    }

    // 失敗時の保険：未送信の下書きをlocalStorageに退避
    const draft = { date, body, photoUrl, categories: Array.from(selectedCats), savedAt: Date.now() };
    localStorage.setItem('badcho.draft', JSON.stringify(draft));

    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const id = await createPost(targetToken, { date, body, photoUrl, categories: Array.from(selectedCats) });
      localStorage.removeItem('badcho.draft');
      navigate('detail', { postId: id });
    } catch (err) {
      console.error(err);
      alert('保存に失敗しました。下書きはこの端末に残っています。\n' + err.message);
      btn.disabled = false;
      btn.textContent = '保存する';
    }
  });

  // 下書き復元
  const draftRaw = localStorage.getItem('badcho.draft');
  if (draftRaw) {
    try {
      const draft = JSON.parse(draftRaw);
      if (confirm('前回保存できなかった下書きを復元しますか？')) {
        document.getElementById('dateInput').value = draft.date || todayISO();
        document.getElementById('bodyInput').value = draft.body || '';
        document.getElementById('photoInput').value = draft.photoUrl || '';
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

function renderDetail(root) {
  const targetToken = mode === 'student' ? studentToken : state.activeStudentToken;
  const posts = state.postsByStudent[targetToken] || [];
  const post = posts.find(p => p.id === state.activePostId);
  if (!post) {
    navigate('home');
    return;
  }
  const chips = (post.categories || []).map(c => `<span class="cat-chip ${c}">${CAT_LABEL[c] || c}</span>`).join(' ');
  const photoBlock = post.photoUrl
    ? `<img class="detail-photo" src="${escapeHtml(post.photoUrl)}" alt="">`
    : '';

  const responses = (post.responses || []).slice().sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
  const responsesHtml = responses.length === 0
    ? `<div class="empty" style="padding:20px 0">まだ地の文返しはありません。</div>`
    : responses.map(r => `
        <div class="response-item">
          <div class="ts">${fmtTimestamp(r.createdAt)}</div>
          <div class="body">${escapeHtml(r.body)}</div>
        </div>
      `).join('');

  // 選手モードでは「返し」入力欄を表示しない（読み専用）
  const responseFormHtml = mode === 'teacher' ? `
      <div class="response-form">
        <p class="hint">採点や指示ではなく、情景・観察・例えで。</p>
        <textarea class="form-textarea short" id="responseInput" placeholder="その日のコートに見えた風景を、地の文で。"></textarea>
        <div class="draft-status" id="draftStatus"></div>
        <button class="btn btn-primary" id="addResponseBtn" style="margin-top:8px">返しを記す</button>
      </div>
  ` : '';

  const deleteBtnHtml = mode === 'teacher' ? `
    <div class="row-actions">
      <button class="btn btn-danger" id="deletePostBtn">この投稿を削除</button>
    </div>
  ` : '';

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

    <section class="responses-section">
      <h3>地の文返し</h3>
      ${responsesHtml}
      ${responseFormHtml}
    </section>

    ${deleteBtnHtml}
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
        await appendResponse(targetToken, post.id, body);
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
  const photoHtml = post.photoUrl
    ? `<img class="archive-photo" src="${escapeHtml(post.photoUrl)}" alt="">`
    : '';
  const responsesHtml = responses.length > 0
    ? `<div class="archive-responses">
        ${responses.map(r => `<div class="archive-response">${escapeHtml(r.body)}</div>`).join('')}
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
  const photoHtml = post.photoUrl
    ? `<img class="reread-photo" src="${escapeHtml(post.photoUrl)}" alt="">`
    : '';
  const responsesHtml = responses.length > 0
    ? `<div class="reread-responses">
        ${responses.map(r => `
          <div class="reread-response">
            <div class="reread-response-body">${escapeHtml(r.body)}</div>
          </div>
        `).join('')}
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
      await loadTeacherIndex();
      subscribeTeacherIndex();
      state.students.forEach(s => subscribeStudentPosts(s.token));
      subscribeJournal();
    } else if (mode === 'student') {
      subscribeStudentPosts(studentToken);
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
