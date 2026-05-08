'use strict';

const STORAGE_KEY = 'badcho.v1';

const CATEGORIES = [
  { id: 'match', label: '試合' },
  { id: 'practice', label: '練習' },
  { id: 'technique', label: '技術' },
];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.id, c.label]));

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState();
    const data = JSON.parse(raw);
    return {
      ...initialState(),
      ...data,
      view: 'home',
      activePostId: null,
    };
  } catch {
    return initialState();
  }
}

function initialState() {
  return {
    students: [],
    currentStudentId: null,
    posts: [],
    view: 'home',
    activePostId: null,
  };
}

function persist() {
  const { students, currentStudentId, posts } = state;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ students, currentStudentId, posts }));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
  render();
  window.scrollTo(0, 0);
}

function getCurrentStudent() {
  return state.students.find(s => s.id === state.currentStudentId) || null;
}

function postsForCurrentStudent() {
  return state.posts
    .filter(p => p.studentId === state.currentStudentId)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)));
}

/* ====== Render ====== */

function render() {
  const main = document.getElementById('main');
  const back = document.getElementById('backBtn');
  const settings = document.getElementById('settingsBtn');
  const title = document.getElementById('headerTitle');

  if (state.view === 'home') {
    back.classList.add('hidden');
    settings.classList.remove('hidden');
    title.textContent = 'バド帖';
  } else {
    back.classList.remove('hidden');
    settings.classList.add('hidden');
    title.textContent = ({
      compose: '投稿',
      detail: '投稿',
      settings: '設定',
    })[state.view] || 'バド帖';
  }

  if (state.view === 'home') renderHome(main);
  else if (state.view === 'compose') renderCompose(main);
  else if (state.view === 'detail') renderDetail(main);
  else if (state.view === 'settings') renderSettings(main);
}

function renderHome(root) {
  if (state.students.length === 0) {
    root.innerHTML = `
      <div class="empty">
        まだ教え子が登録されていません。<br>
        右上の <strong>⚙</strong> から追加してください。
        <div class="small" style="margin-top:18px">蘆原より：「最初の一人を入れたら、まず断片を一つ。」</div>
      </div>
    `;
    return;
  }

  if (!state.currentStudentId || !state.students.find(s => s.id === state.currentStudentId)) {
    state.currentStudentId = state.students[0].id;
    persist();
  }

  const studentBar = state.students
    .map(s => `<button class="student-pill ${s.id === state.currentStudentId ? 'active' : ''}" data-student-id="${s.id}">${escapeHtml(s.name)}</button>`)
    .join('');

  const posts = postsForCurrentStudent();
  const timeline = posts.length === 0
    ? `<div class="empty">この教え子の記録はまだありません。<br><span class="small">「投稿する」から、断片のままで構いません。</span></div>`
    : `<ul class="timeline">${posts.map(renderPostCard).join('')}</ul>`;

  root.innerHTML = `
    <div class="student-bar">${studentBar}</div>
    <button class="compose-btn" id="composeBtn">＋ 投稿する</button>
    ${timeline}
  `;

  root.querySelectorAll('.student-pill').forEach(el => {
    el.addEventListener('click', () => {
      state.currentStudentId = el.dataset.studentId;
      persist();
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
  const student = getCurrentStudent();
  if (!student) {
    navigate('home');
    return;
  }

  let selectedCats = new Set();
  let dateValue = todayISO();
  let bodyValue = '';
  let photoValue = '';

  root.innerHTML = `
    <div class="form-group">
      <label class="form-label">教え子</label>
      <div style="font-size:15px;">${escapeHtml(student.name)}</div>
    </div>
    <div class="form-group">
      <label class="form-label" for="dateInput">日付</label>
      <input class="form-input" type="date" id="dateInput" value="${dateValue}">
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

  document.getElementById('saveBtn').addEventListener('click', () => {
    const date = document.getElementById('dateInput').value || todayISO();
    const body = document.getElementById('bodyInput').value.trim();
    const photoUrl = document.getElementById('photoInput').value.trim();
    if (!body && !photoUrl) {
      alert('本文か写真URLのいずれかを入力してください。');
      return;
    }
    const post = {
      id: uid(),
      studentId: student.id,
      date,
      createdAt: new Date().toISOString(),
      categories: Array.from(selectedCats),
      body,
      photoUrl,
      responses: [],
    };
    state.posts.push(post);
    persist();
    navigate('detail', { postId: post.id });
  });
}

function renderDetail(root) {
  const post = state.posts.find(p => p.id === state.activePostId);
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
      <div class="response-form">
        <p class="hint">採点や指示ではなく、情景・観察・例えで。</p>
        <textarea class="form-textarea short" id="responseInput" placeholder="その日のコートに見えた風景を、地の文で。"></textarea>
        <button class="btn btn-primary" id="addResponseBtn" style="margin-top:8px">返しを記す</button>
      </div>
    </section>

    <div class="row-actions">
      <button class="btn btn-danger" id="deletePostBtn">この投稿を削除</button>
    </div>
  `;

  document.getElementById('addResponseBtn').addEventListener('click', () => {
    const ta = document.getElementById('responseInput');
    const body = ta.value.trim();
    if (!body) return;
    if (!post.responses) post.responses = [];
    post.responses.push({
      id: uid(),
      createdAt: new Date().toISOString(),
      body,
    });
    persist();
    render();
  });

  document.getElementById('deletePostBtn').addEventListener('click', () => {
    if (!confirm('この投稿を削除しますか？（取り消せません）')) return;
    state.posts = state.posts.filter(p => p.id !== post.id);
    persist();
    navigate('home');
  });
}

function renderSettings(root) {
  const studentRows = state.students.length === 0
    ? `<div class="empty" style="padding:12px 0">まだ登録されていません。</div>`
    : state.students.map(s => `
        <div class="student-row" data-student-id="${s.id}">
          <span class="name">${escapeHtml(s.name)}</span>
          <button class="icon-btn" data-action="rename" aria-label="名前変更">✎</button>
          <button class="icon-btn" data-action="delete" aria-label="削除">×</button>
        </div>
      `).join('');

  root.innerHTML = `
    <section class="settings-section">
      <h2>教え子</h2>
      <div id="studentList">${studentRows}</div>
      <div class="add-student-form">
        <input type="text" id="newStudentName" placeholder="名前を追加" maxlength="40">
        <button id="addStudentBtn">追加</button>
      </div>
    </section>

    <section class="settings-section">
      <h2>データ</h2>
      <div class="io-row">
        <button class="btn btn-secondary" id="exportBtn">エクスポート</button>
        <button class="btn btn-secondary" id="importBtn">インポート</button>
      </div>
      <input type="file" id="importFile" class="hidden-input" accept="application/json,.json">
      <p style="font-size:12px;color:var(--ink-soft);margin:12px 0 0;line-height:1.7">
        記録はこの端末のブラウザにのみ保存されます。<br>
        端末をまたぐ場合や万一に備えて、ときどきエクスポートを。
      </p>
    </section>

    <section class="settings-section">
      <h2>このツールについて</h2>
      <p style="font-size:13px;color:var(--ink-soft);margin:0;line-height:1.85">
        バド帖は、教え子の断片メモを蓄積し、渡部さんが地の文で返すための記録器です。<br>
        整える前の言葉を、そのまま投げ込んでください。
      </p>
    </section>
  `;

  document.getElementById('addStudentBtn').addEventListener('click', addStudent);
  document.getElementById('newStudentName').addEventListener('keydown', e => {
    if (e.key === 'Enter') addStudent();
  });

  root.querySelectorAll('.student-row').forEach(row => {
    const id = row.dataset.studentId;
    row.querySelector('[data-action="rename"]').addEventListener('click', () => {
      const cur = state.students.find(s => s.id === id);
      const name = prompt('新しい名前', cur.name);
      if (name && name.trim()) {
        cur.name = name.trim();
        persist();
        render();
      }
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', () => {
      const cur = state.students.find(s => s.id === id);
      const postCount = state.posts.filter(p => p.studentId === id).length;
      const msg = postCount > 0
        ? `${cur.name} さんと、その記録 ${postCount} 件を削除しますか？（取り消せません）`
        : `${cur.name} さんを削除しますか？`;
      if (!confirm(msg)) return;
      state.posts = state.posts.filter(p => p.studentId !== id);
      state.students = state.students.filter(s => s.id !== id);
      if (state.currentStudentId === id) {
        state.currentStudentId = state.students[0]?.id || null;
      }
      persist();
      render();
    });
  });

  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });
  document.getElementById('importFile').addEventListener('change', importData);
}

function addStudent() {
  const input = document.getElementById('newStudentName');
  const name = input.value.trim();
  if (!name) return;
  const s = { id: uid(), name };
  state.students.push(s);
  if (!state.currentStudentId) state.currentStudentId = s.id;
  persist();
  render();
}

function exportData() {
  const data = {
    students: state.students,
    currentStudentId: state.currentStudentId,
    posts: state.posts,
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const today = todayISO();
  a.href = url;
  a.download = `badcho-${today}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!Array.isArray(data.students) || !Array.isArray(data.posts)) {
        throw new Error('形式が違います');
      }
      if (!confirm('現在のデータを上書きしてインポートしますか？')) return;
      state.students = data.students;
      state.posts = data.posts;
      state.currentStudentId = data.currentStudentId || (data.students[0]?.id ?? null);
      persist();
      render();
      alert('インポートしました。');
    } catch (err) {
      alert('インポートに失敗しました：' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

/* ====== Init ====== */

document.getElementById('backBtn').addEventListener('click', () => navigate('home'));
document.getElementById('settingsBtn').addEventListener('click', () => navigate('settings'));

render();
