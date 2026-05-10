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

const mode = teacherToken && teacherToken.length >= 32
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
  // 投稿サブコレクションは残置（手動削除可能、誤削除防止のため自動消去しない）
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
    title.textContent = mode === 'teacher' ? 'バド帖（教師）' : 'バド帖';
  } else {
    back.classList.remove('hidden');
    settings.classList.add('hidden');
    title.textContent = ({
      compose: '投稿',
      detail: '投稿',
      settings: '設定',
      students: '教え子',
    })[state.view] || 'バド帖';
  }

  if (state.view === 'home') renderHome(main);
  else if (state.view === 'compose') renderCompose(main);
  else if (state.view === 'detail') renderDetail(main);
  else if (state.view === 'settings') renderSettings(main);
}

function renderSetup(root) {
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  const hasLegacy = !!legacy;
  root.innerHTML = `
    <div class="setup-card">
      <h2>はじめに</h2>
      <p>バド帖は、URLにトークンを付けて使います。</p>
      <ol>
        <li><strong>渡部さん用URL</strong>を発行してください（このボタン）</li>
        <li>そのURLをブックマーク</li>
        <li>教え子用URLは「教え子追加」時に自動発行</li>
      </ol>
      <button class="btn btn-primary" id="genTeacherBtn">渡部さん用URLを発行する</button>
      <div id="genTeacherResult" style="margin-top:16px"></div>
      ${hasLegacy ? `
        <hr style="margin:24px 0;border:none;border-top:1px solid #ddd">
        <p class="small">※ この端末には旧バージョンのデータが残っています。渡部さん用URLを発行してログイン後、設定画面から移行できます。</p>
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
        まだ教え子が登録されていません。<br>
        右上の <strong>⚙</strong> から追加してください。
        <div class="small" style="margin-top:18px">蘆原より：「最初の一人を入れたら、まず断片を一つ。」</div>
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
    : `<div class="empty">この教え子の記録はまだありません。<br><span class="small">「投稿する」から、断片のままで構いません。</span></div>`;

  const timeline = posts.length === 0
    ? emptyMsg
    : `<ul class="timeline">${posts.map(renderPostCard).join('')}</ul>`;

  root.innerHTML = `
    ${studentBar}
    ${filterBar}
    <button class="compose-btn" id="composeBtn">＋ 投稿する</button>
    ${timeline}
  `;

  root.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.filterMode = btn.dataset.filter;
      render();
    });
  });

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
  return `
    <li class="post-card" data-post-id="${post.id}">
      <div class="post-meta">
        <span class="post-date">${fmtDate(post.date)}</span>
        ${chips}
      </div>
      <div class="post-body">${escapeHtml(post.body)}</div>
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
      <label class="form-label">教え子</label>
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
      <label class="form-label" for="bodyInput">本文（断片のままでOK）</label>
      <textarea class="form-textarea" id="bodyInput" placeholder="今日のひと言・気になったこと・うまくいかなかった一場面…"></textarea>
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
    if (!body && !photoUrl) {
      alert('本文か写真URLのいずれかを入力してください。');
      return;
    }
    const targetToken = mode === 'student' ? studentToken : state.activeStudentToken;
    if (!targetToken) {
      alert('対象の教え子が選ばれていません。');
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

  // 教え子モードでは「返し」入力欄を表示しない（読み専用）
  const responseFormHtml = mode === 'teacher' ? `
      <div class="response-form">
        <p class="hint">採点や指示ではなく、情景・観察・例えで。</p>
        <textarea class="form-textarea short" id="responseInput" placeholder="その日のコートに見えた風景を、地の文で。"></textarea>
        <button class="btn btn-primary" id="addResponseBtn" style="margin-top:8px">返しを記す</button>
      </div>
  ` : '';

  const deleteBtnHtml = mode === 'teacher' ? `
    <div class="row-actions">
      <button class="btn btn-danger" id="deletePostBtn">この投稿を削除</button>
    </div>
  ` : '';

  root.innerHTML = `
    <article class="detail-post">
      <div class="post-meta">
        <span class="post-date">${fmtDate(post.date)}</span>
        ${chips}
      </div>
      <div class="detail-body">${escapeHtml(post.body)}</div>
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
    document.getElementById('addResponseBtn').addEventListener('click', async () => {
      const ta = document.getElementById('responseInput');
      const body = ta.value.trim();
      if (!body) return;
      const btn = document.getElementById('addResponseBtn');
      btn.disabled = true;
      try {
        await appendResponse(targetToken, post.id, body);
        ta.value = '';
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

function renderSettings(root) {
  if (mode !== 'teacher') {
    root.innerHTML = `<div class="empty">この画面は渡部さん専用です。</div>`;
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
              <button class="link-btn" data-action="regen">URL再発行</button>
            </div>
            <div class="qr-area hidden" data-qr></div>
          </div>
          <button class="icon-btn" data-action="rename" aria-label="名前変更">✎</button>
          <button class="icon-btn" data-action="delete" aria-label="削除">×</button>
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
      <h2>教え子</h2>
      <div id="studentList">${studentRows}</div>
      <div class="add-student-form">
        <input type="text" id="newStudentName" placeholder="名前を追加" maxlength="40">
        <button id="addStudentBtn">追加</button>
      </div>
      <p style="font-size:12px;color:var(--ink-soft);margin-top:8px;line-height:1.7">
        追加すると、その教え子専用のURLが発行されます。LINEなどで本人に送ってください。
      </p>
    </section>

    ${migrationSection}

    <section class="settings-section">
      <h2>このツールについて</h2>
      <p style="font-size:13px;color:var(--ink-soft);margin:0;line-height:1.85">
        バド帖は、教え子の断片メモを蓄積し、渡部さんが地の文で返すための記録器です。<br>
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
    row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      const cur = state.students.find(s => s.token === token);
      if (!confirm(`${cur.name} さんを名簿から外しますか？\n（投稿データはFirestoreに残ります。完全削除はFirebaseコンソールから）`)) return;
      try {
        await removeStudentFromIndex(token);
      } catch (err) {
        alert('削除に失敗しました：' + err.message);
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
        area.innerHTML = `<img src="${dataUrl}" alt="QRコード" style="display:block;margin:8px auto;border:1px solid var(--line);border-radius:6px"><div class="small" style="text-align:center">教え子のスマホでスキャン</div>`;
      } catch (err) {
        area.innerHTML = `<div class="small" style="color:var(--warn)">QR生成失敗：${escapeHtml(err.message)}</div>`;
      }
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
  if (!confirm(`旧データを移行します：\n・教え子 ${legacy.students?.length || 0}人\n・投稿 ${legacy.posts?.length || 0}件\n\nよろしいですか？`)) return;

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
    result.innerHTML = `<span style="color:green">✓ 移行完了：教え子 ${added}人 / 投稿 ${postsAdded}件</span>`;
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

  try {
    if (mode === 'teacher') {
      await loadTeacherIndex();
      subscribeTeacherIndex();
      state.students.forEach(s => subscribeStudentPosts(s.token));
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
