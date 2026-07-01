(function(){
  const STORAGE_KEY = 'snippets:v1';
  const TAG_LABELS = { terminal:'Terminal', ai:'AI Agent', other:'Other' };
  const GIST_SETTINGS_KEY = 'snippets:gist:settings:v1';
  const GIST_TOKEN_KEY = 'snippets:gist:token:v1';

  // 安全なUUID生成 (crypto.randomUUIDのフォールバック)
  function generateUUID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // 透過的なストレージラッパー (window.storage がない場合は localStorage へフォールバック)
  const storage = {
    async get(key) {
      try {
        if (window.storage && typeof window.storage.get === 'function') {
          return await window.storage.get(key, false);
        }
      } catch (e) {
        console.warn('window.storage.get failed, falling back to localStorage:', e);
      }
      try {
        const val = localStorage.getItem(key);
        return val ? { value: val } : null;
      } catch (e) {
        console.error('localStorage.getItem failed:', e);
        return null;
      }
    },
    async set(key, value) {
      try {
        if (window.storage && typeof window.storage.set === 'function') {
          const result = await window.storage.set(key, value, false);
          if (result) return true;
        }
      } catch (e) {
        console.warn('window.storage.set failed, falling back to localStorage:', e);
      }
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (e) {
        console.error('localStorage.setItem failed:', e);
        return false;
      }
    }
  };

  // 読み込みデータの構造・内容バリデーション
  function validateSnippets(data) {
    if (!Array.isArray(data)) return false;
    if (data.length > 1000) return false; // 最大1000件までに制限

    const ids = new Set();
    const allowedTags = Object.keys(TAG_LABELS);

    for (const item of data) {
      if (!item || typeof item !== 'object') return false;
      const { id, title, desc, tag, code } = item;

      // 型と必須項目チェック (id, title, code は空文字不可)
      if (typeof id !== 'string' || !id.trim()) return false;
      if (typeof title !== 'string' || !title.trim()) return false;
      if (typeof desc !== 'string') return false;
      if (typeof tag !== 'string') return false;
      if (typeof code !== 'string' || !code.trim()) return false;

      // IDの一意性チェック
      if (ids.has(id)) return false;
      ids.add(id);

      // 許可タグチェック
      if (!allowedTags.includes(tag)) return false;

      // 文字数上限チェック (安全のため)
      if (id.length > 100) return false;
      if (title.length > 100) return false;
      if (desc.length > 500) return false;
      if (code.length > 10000) return false;
    }

    return true;
  }

  // コピー処理のフォールバック
  function copyToClipboardFallback(text) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.top = '-9999px';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      const success = document.execCommand('copy');
      document.body.removeChild(textarea);
      return success;
    } catch (e) {
      console.error('Fallback copy failed:', e);
      return false;
    }
  }

  // クリップボードへのコピー共通関数
  async function copyToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        console.warn('Clipboard API writeText failed, trying fallback:', e);
      }
    }
    return copyToClipboardFallback(text);
  }

  const seed = [
    {
      id: generateUUID(),
      title: 'Hello World!',
      desc: '画面にHello World!を出力するコマンドです',
      tag: 'terminal',
      code: 'echo "Hello World!"'
    }
  ];

  let snippets = [];
  let activeTag = 'all';
  let searchTerm = '';
  let editingId = null;
  let lastActiveElement = null; // フォーカス復元用

  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('emptyMsg');
  const tagFiltersEl = document.getElementById('tagFilters');
  const statusEl = document.getElementById('status');
  const searchEl = document.getElementById('search');
  const addToggle = document.getElementById('addToggle');
  const addForm = document.getElementById('addForm');
  const cancelAdd = document.getElementById('cancelAdd');
  const srAnnouncer = document.getElementById('sr-announcer');
  const exportBtn = document.getElementById('exportBtn');
  const importBtn = document.getElementById('importBtn');
  const importFile = document.getElementById('importFile');
  const optionsDialog = document.getElementById('optionsDialog');
  const openOptionsBtn = document.getElementById('openOptionsBtn');
  const closeOptionsBtn = document.getElementById('closeOptionsBtn');

  // Gist 同期用 DOM 要素
  const gistTokenEl = document.getElementById('gistToken');
  const gistIdEl = document.getElementById('gistId');
  const lastPushedAtText = document.getElementById('lastPushedAtText');
  const lastPulledAtText = document.getElementById('lastPulledAtText');
  const gistDeleteBtn = document.getElementById('gistDeleteBtn');
  const gistPullBtn = document.getElementById('gistPullBtn');
  const gistPushBtn = document.getElementById('gistPushBtn');
  const tokenStorageRadios = document.getElementsByName('tokenStorage');

  // スクリーンリーダー向け動的通知
  function announce(message) {
    if (!srAnnouncer) return;
    srAnnouncer.textContent = '';
    setTimeout(() => {
      srAnnouncer.textContent = message;
    }, 100);
  }

  // 破損データ時のエラー表示
  function showCorruptedDataError(rawText) {
    statusEl.textContent = 'データエラー';
    listEl.innerHTML = `
      <div class="error-panel">
        <h3>データの読み込みに失敗しました</h3>
        <p>保存されているデータが破損しているか、無効な形式です。データを保護するため、初期データでの自動上書きは行いませんでした。</p>
        <p>以下のいずれかの操作を行ってください：</p>
        <div class="error-actions">
          <button type="button" id="btn-export-corrupted" class="btn">破損データをダウンロード</button>
          <button type="button" id="btn-reset-corrupted" class="btn danger">データをリセット（初期化）</button>
        </div>
      </div>
    `;
    emptyEl.style.display = 'none';

    document.getElementById('btn-export-corrupted').addEventListener('click', () => {
      try {
        const blob = new Blob([rawText], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const tempLink = document.createElement('a');
        tempLink.href = url;
        tempLink.download = 'snippets-corrupted-backup.json';
        document.body.appendChild(tempLink);
        tempLink.click();
        document.body.removeChild(tempLink);
        URL.revokeObjectURL(url);
        announce('破損データのダウンロードを開始しました。');
      } catch (e) {
        console.error('Failed to export corrupted data:', e);
        announce('ダウンロードに失敗しました。');
      }
    });

    document.getElementById('btn-reset-corrupted').addEventListener('click', async () => {
      if (confirm('現在のデータを消去し、初期状態に戻します。よろしいですか？')) {
        snippets = seed;
        try {
          await persist();
          statusEl.textContent = '';
          renderTagFilters();
          render();
          announce('データをリセットし、初期データで上書きしました。');
        } catch (e) {
          alert('初期化データの保存に失敗しました。');
        }
      }
    });
  }

  // Gist 関連のデータ状態
  let gistSettings = {
    gistId: '',
    tokenStorage: 'session',
    lastPushedAt: null,
    lastPulledAt: null
  };
  let gistToken = '';

  async function loadGistSettings() {
    try {
      const res = await storage.get(GIST_SETTINGS_KEY);
      if (res && res.value) {
        gistSettings = { ...gistSettings, ...JSON.parse(res.value) };
      }
    } catch (e) {
      console.warn('Failed to load Gist settings:', e);
    }

    // Token のロード
    try {
      if (gistSettings.tokenStorage === 'local') {
        gistToken = localStorage.getItem(GIST_TOKEN_KEY) || '';
      } else {
        gistToken = sessionStorage.getItem(GIST_TOKEN_KEY) || '';
      }
    } catch (e) {
      console.warn('Failed to load Gist token:', e);
    }
  }

  async function saveGistSettings() {
    try {
      await storage.set(GIST_SETTINGS_KEY, JSON.stringify(gistSettings));
    } catch (e) {
      console.error('Failed to save Gist settings:', e);
    }
  }

  function saveGistToken() {
    try {
      if (gistSettings.tokenStorage === 'local') {
        localStorage.setItem(GIST_TOKEN_KEY, gistToken);
        sessionStorage.removeItem(GIST_TOKEN_KEY);
      } else {
        sessionStorage.setItem(GIST_TOKEN_KEY, gistToken);
        localStorage.removeItem(GIST_TOKEN_KEY);
      }
    } catch (e) {
      console.error('Failed to save Gist token:', e);
    }
  }

  async function deleteGistSettings() {
    gistSettings = {
      gistId: '',
      tokenStorage: 'session',
      lastPushedAt: null,
      lastPulledAt: null
    };
    gistToken = '';
    try {
      await storage.set(GIST_SETTINGS_KEY, JSON.stringify(gistSettings));
      localStorage.removeItem(GIST_TOKEN_KEY);
      sessionStorage.removeItem(GIST_TOKEN_KEY);
    } catch (e) {
      console.error('Failed to delete Gist settings/token:', e);
    }
  }

  // Gist API リクエストラッパー
  async function gistRequest(method, url, token, body = null) {
    const headers = {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    };
    const options = {
      method,
      headers
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      let errMsg = `HTTP error! status: ${response.status}`;
      try {
        const errJson = await response.json();
        if (errJson && errJson.message) {
          errMsg = errJson.message;
        }
      } catch (e) {}
      
      const error = new Error(errMsg);
      error.status = response.status;
      throw error;
    }

    return await response.json();
  }

  // 新規 Gist 作成
  async function createGist(token, payload) {
    const body = {
      description: 'Snippet Library backup',
      public: false,
      files: {
        'snippets.json': {
          content: JSON.stringify(payload, null, 2)
        }
      }
    };
    return await gistRequest('POST', 'https://api.github.com/gists', token, body);
  }

  // 既存 Gist 更新
  async function updateGist(token, gistId, payload) {
    const body = {
      files: {
        'snippets.json': {
          content: JSON.stringify(payload, null, 2)
        }
      }
    };
    return await gistRequest('PATCH', `https://api.github.com/gists/${gistId}`, token, body);
  }

  // Gist 読み込み
  async function fetchGist(token, gistId) {
    const data = await gistRequest('GET', `https://api.github.com/gists/${gistId}`, token);
    if (!data.files || !data.files['snippets.json']) {
      throw new Error('Gist内に snippets.json が見つかりません');
    }
    return JSON.parse(data.files['snippets.json'].content);
  }

  // Gist用データ検証
  function validateGistPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.schemaVersion !== 1) return false;
    if (payload.app !== 'snippet-library') return false;
    return validateSnippets(payload.snippets);
  }

  async function pushToGist() {
    if (!gistToken.trim()) {
      throw new Error('GitHub Tokenが設定されていません');
    }

    const payload = {
      schemaVersion: 1,
      app: 'snippet-library',
      updatedAt: new Date().toISOString(),
      snippets: snippets
    };

    let result;
    if (gistSettings.gistId) {
      result = await updateGist(gistToken, gistSettings.gistId, payload);
    } else {
      result = await createGist(gistToken, payload);
      gistSettings.gistId = result.id;
    }

    gistSettings.lastPushedAt = payload.updatedAt;
    await saveGistSettings();
    return result;
  }

  async function pullFromGist() {
    if (!gistToken.trim()) {
      throw new Error('GitHub Tokenが設定されていません');
    }
    if (!gistSettings.gistId.trim()) {
      throw new Error('Gist IDが設定されていません');
    }

    const payload = await fetchGist(gistToken, gistSettings.gistId);
    
    if (!validateGistPayload(payload)) {
      throw new Error('Gistのデータ形式が無効か、破損しています');
    }

    return payload;
  }

  function updateGistUI() {
    if (!gistTokenEl) return;
    
    gistTokenEl.value = gistToken;
    gistIdEl.value = gistSettings.gistId;

    for (const radio of tokenStorageRadios) {
      radio.checked = (radio.value === gistSettings.tokenStorage);
    }

    const formatDate = (isoString) => {
      if (!isoString) return '未設定';
      try {
        const d = new Date(isoString);
        return d.toLocaleString('ja-JP');
      } catch (e) {
        return 'エラー';
      }
    };

    lastPushedAtText.textContent = formatDate(gistSettings.lastPushedAt);
    lastPulledAtText.textContent = formatDate(gistSettings.lastPulledAt);
  }

  function registerGistListeners() {
    if (!gistTokenEl) return;

    const toggleTokenVisibility = document.getElementById('toggleTokenVisibility');
    if (toggleTokenVisibility) {
      toggleTokenVisibility.addEventListener('click', () => {
        const isPassword = gistTokenEl.type === 'password';
        gistTokenEl.type = isPassword ? 'text' : 'password';
        toggleTokenVisibility.setAttribute('aria-label', isPassword ? 'トークンを非表示にする' : 'トークンを表示する');
        if (isPassword) {
          toggleTokenVisibility.innerHTML = `
            <svg class="eye-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
              <line x1="1" y1="1" x2="23" y2="23"></line>
            </svg>
          `;
        } else {
          toggleTokenVisibility.innerHTML = `
            <svg class="eye-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
          `;
        }
      });
    }

    gistTokenEl.addEventListener('input', (e) => {
      gistToken = e.target.value.trim();
      saveGistToken();
    });

    gistIdEl.addEventListener('input', (e) => {
      gistSettings.gistId = e.target.value.trim();
      saveGistSettings();
    });

    for (const radio of tokenStorageRadios) {
      radio.addEventListener('change', (e) => {
        if (e.target.checked) {
          gistSettings.tokenStorage = e.target.value;
          saveGistSettings();
          saveGistToken();
        }
      });
    }

    gistDeleteBtn.addEventListener('click', async () => {
      if (confirm('GitHub Token および Gist ID などの連携設定を削除します。よろしいですか？')) {
        await deleteGistSettings();
        updateGistUI();
        announce('Gist連携設定を削除しました。');
      }
    });

    let isSyncing = false;
    function setSyncState(syncing) {
      isSyncing = syncing;
      gistPullBtn.disabled = syncing;
      gistPushBtn.disabled = syncing;
      gistDeleteBtn.disabled = syncing;
      gistTokenEl.disabled = syncing;
      gistIdEl.disabled = syncing;
      for (const radio of tokenStorageRadios) {
        radio.disabled = syncing;
      }
    }

    gistPushBtn.addEventListener('click', async () => {
      if (isSyncing) return;
      if (!gistToken.trim()) {
        alert('GitHub Token を入力してください。');
        gistTokenEl.focus();
        return;
      }

      setSyncState(true);
      announce('Gistへの保存を開始します…');
      try {
        await pushToGist();
        updateGistUI();
        announce('Gistへの保存が完了しました。');
        alert('Gistへの保存が完了しました。');
      } catch (err) {
        console.error('Gist push failed:', err);
        let friendlyMsg = '保存に失敗しました。';
        if (err.status === 401 || err.status === 403) {
          friendlyMsg += 'GitHub Token の権限または有効期限を確認してください。';
        } else if (err.status === 404) {
          friendlyMsg += 'Gist ID が存在しないか、Tokenの権限が不足しています。';
        } else {
          friendlyMsg += err.message;
        }
        announce(friendlyMsg);
        alert(friendlyMsg);
      } finally {
        setSyncState(false);
      }
    });

    gistPullBtn.addEventListener('click', async () => {
      if (isSyncing) return;
      if (!gistToken.trim()) {
        alert('GitHub Token を入力してください。');
        gistTokenEl.focus();
        return;
      }
      if (!gistSettings.gistId.trim()) {
        alert('Gist ID を入力してください。');
        gistIdEl.focus();
        return;
      }

      setSyncState(true);
      announce('Gistからの読み込みを開始します…');
      try {
        const payload = await pullFromGist();
        setSyncState(false);

        if (confirm(`Gistから ${payload.snippets.length} 件のスニペットを取得しました。現在のローカルデータを全て上書きしますが、よろしいですか？`)) {
          setSyncState(true);
          const originalSnippets = snippets;
          snippets = payload.snippets;
          try {
            await persist();
            gistSettings.lastPulledAt = payload.updatedAt || new Date().toISOString();
            await saveGistSettings();
            render();
            if (optionsDialog) {
              optionsDialog.close();
            }
            updateGistUI();
            announce('Gistからの読み込みとローカルへの反映が完了しました。');
            alert('Gistからの読み込みが完了しました。');
          } catch (e) {
            snippets = originalSnippets;
            announce('ローカルデータの保存に失敗したため、読み込みをキャンセルしました。');
            alert('インポートに失敗しました。ローカルストレージへの書き込みエラーです。');
          }
        }
      } catch (err) {
        console.error('Gist pull failed:', err);
        let friendlyMsg = '読み込みに失敗しました。';
        if (err.status === 401 || err.status === 403) {
          friendlyMsg += 'GitHub Token の権限または有効期限を確認してください。';
        } else if (err.status === 404) {
          friendlyMsg += 'Gist ID が存在しないか、Tokenの権限が不足しています。';
        } else {
          friendlyMsg += err.message;
        }
        announce(friendlyMsg);
        alert(friendlyMsg);
      } finally {
        setSyncState(false);
      }
    });
  }

  async function load(){
    statusEl.textContent = '読み込み中…';
    try{
      await loadGistSettings();
      const res = await storage.get(STORAGE_KEY);
      if (!res || !res.value) {
        // 保存データが存在しない
        snippets = seed;
        await persist();
        statusEl.textContent = '';
        renderTagFilters();
        render();
        return;
      }

      let parsed = null;
      let parseFailed = false;
      try {
        parsed = JSON.parse(res.value);
      } catch (e) {
        parseFailed = true;
      }

      if (!parseFailed && validateSnippets(parsed)) {
        snippets = parsed;
        statusEl.textContent = '';
        renderTagFilters();
        render();
      } else {
        showCorruptedDataError(res.value);
      }
    }catch(e){
      console.error('Failed to load snippets:', e);
      statusEl.textContent = 'ストレージの読み込みに失敗しました';
    }
  }

  async function persist(){
    try{
      const result = await storage.set(STORAGE_KEY, JSON.stringify(snippets));
      if(!result){
        statusEl.textContent = '保存に失敗しました';
        throw new Error('Storage write failed');
      }
    }catch(e){
      console.error('Failed to persist snippets:', e);
      statusEl.textContent = '保存に失敗しました';
      throw e;
    }
  }

  function renderTagFilters(){
    const tags = ['all', ...Object.keys(TAG_LABELS)];
    tagFiltersEl.innerHTML = '';
    tags.forEach(t=>{
      const btn = document.createElement('button');
      btn.className = 'tag-btn' + (activeTag===t ? ' active':'');
      btn.textContent = t==='all' ? 'すべて' : TAG_LABELS[t];
      // WAI-ARIA: 現在のアクティブ状態を通知
      btn.setAttribute('aria-pressed', activeTag===t ? 'true' : 'false');
      btn.addEventListener('click', ()=>{
        activeTag = t;
        renderTagFilters();
        render();
        announce(`${btn.textContent}のタグでフィルターしました。`);
      });
      tagFiltersEl.appendChild(btn);
    });
  }

  function matches(s){
    const inTag = activeTag==='all' || s.tag===activeTag;
    const q = searchTerm.trim().toLowerCase();
    const inSearch = !q || s.title.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q) || s.code.toLowerCase().includes(q);
    return inTag && inSearch;
  }

  function render(){
    const filtered = snippets.filter(matches);
    listEl.innerHTML = '';
    emptyEl.style.display = filtered.length ? 'none' : 'block';

    filtered.forEach(s=>{
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.tag = s.tag;

      card.innerHTML = `
        <div class="card-head">
          <div>
            <div class="card-title"></div>
            <div class="card-desc"></div>
          </div>
          <div class="card-tag"></div>
        </div>
        <div class="code-row">
          <span class="prompt-mark" aria-hidden="true">${s.tag==='ai' ? '#' : '$'}</span>
          <pre class="code"></pre>
          <button type="button" class="copy-btn"></button>
        </div>
        <div class="card-footer">
          <button type="button" class="link-btn edit-btn"></button>
          <button type="button" class="link-btn danger delete-btn"></button>
        </div>
      `;
      card.querySelector('.card-title').textContent = s.title;
      card.querySelector('.card-desc').textContent = s.desc;
      card.querySelector('.card-tag').textContent = TAG_LABELS[s.tag] || s.tag;
      card.querySelector('.code').textContent = s.code;

      const copyBtn = card.querySelector('.copy-btn');
      copyBtn.textContent = 'コピー';
      copyBtn.setAttribute('aria-label', `${s.title}のコードをコピー`);
      copyBtn.addEventListener('click', async ()=>{
        const success = await copyToClipboard(s.code);
        if (success) {
          copyBtn.textContent = 'コピーしました';
          copyBtn.classList.add('copied');
          announce(`${s.title}をクリップボードにコピーしました。`);
          setTimeout(()=>{
            copyBtn.textContent = 'コピー';
            copyBtn.classList.remove('copied');
          }, 1400);
        } else {
          copyBtn.textContent = '失敗';
          announce('コピーに失敗しました。');
          setTimeout(()=>{ copyBtn.textContent = 'コピー'; }, 1400);
        }
      });

      const deleteBtn = card.querySelector('.delete-btn');
      deleteBtn.textContent = '削除';
      deleteBtn.setAttribute('aria-label', `${s.title}を削除`);
      let deleteTimer = null;
      deleteBtn.addEventListener('click', async ()=>{
        // 2段階確認: 1回目 → 確認状態に変更、2回目 → 実際に削除
        if(!deleteBtn.classList.contains('confirming')){
          deleteBtn.textContent = '本当に削除？';
          deleteBtn.classList.add('confirming');
          deleteTimer = setTimeout(()=>{
            deleteBtn.textContent = '削除';
            deleteBtn.classList.remove('confirming');
          }, 3000);
          return;
        }
        clearTimeout(deleteTimer);
        const originalSnippets = snippets;
        snippets = snippets.filter(x=>x.id!==s.id);
        try {
          await persist();
          render();
          announce(`${s.title}を削除しました。`);
          searchEl.focus();
        } catch(e) {
          snippets = originalSnippets;
          statusEl.textContent = '削除に失敗しました';
          setTimeout(()=>{ statusEl.textContent = ''; }, 3000);
          announce('削除に失敗しました。');
          deleteBtn.textContent = '削除';
          deleteBtn.classList.remove('confirming');
        }
      });

      const editBtn = card.querySelector('.edit-btn');
      editBtn.textContent = '編集';
      editBtn.setAttribute('aria-label', `${s.title}を編集`);
      editBtn.addEventListener('click', (e)=>{
        openForm(s, e.currentTarget);
      });

      listEl.appendChild(card);
    });
  }

  searchEl.addEventListener('input', (e)=>{
    searchTerm = e.target.value;
    render();
  });

  function openForm(existing, triggerEl = null){
    editingId = existing ? existing.id : null;
    lastActiveElement = triggerEl || document.activeElement;

    document.getElementById('f-title').value = existing ? existing.title : '';
    document.getElementById('f-desc').value = existing ? existing.desc : '';
    document.getElementById('f-tag').value = existing ? existing.tag : 'terminal';
    document.getElementById('f-code').value = existing ? existing.code : '';
    addForm.classList.add('open');
    addToggle.style.display = 'none';
    addToggle.setAttribute('aria-expanded', 'true');
    document.getElementById('f-title').focus();
  }

  function closeForm(){
    addForm.classList.remove('open');
    addToggle.style.display = 'inline-flex';
    addToggle.setAttribute('aria-expanded', 'false');
    editingId = null;
    // フォーカスをフォームを開いたときのトリガー要素に戻す
    if(lastActiveElement && typeof lastActiveElement.focus === 'function'){
      lastActiveElement.focus();
    }else{
      addToggle.focus();
    }
  }

  addToggle.addEventListener('click', (e)=> openForm(null, e.currentTarget));
  cancelAdd.addEventListener('click', closeForm);

  // キーボードショートカット (Escキーでキャンセル)
  addForm.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeForm();
      e.preventDefault();
    }
  });

  // セマンティックな保存処理 (submit イベントで制御)
  addForm.addEventListener('submit', async (e)=>{
    e.preventDefault();

    const title = document.getElementById('f-title').value.trim();
    const desc = document.getElementById('f-desc').value.trim();
    const tag = document.getElementById('f-tag').value;
    const code = document.getElementById('f-code').value;

    if(!title || !code.trim()){
      statusEl.textContent = 'タイトルとコマンド本文は必須です';
      setTimeout(()=>{ statusEl.textContent=''; }, 2000);
      return;
    }

    const originalSnippets = snippets;
    const isEdit = !!editingId;

    if(editingId){
      snippets = snippets.map(x => x.id === editingId ? { ...x, title, desc, tag, code } : x);
    }else{
      snippets = [{ id: generateUUID(), title, desc, tag, code }, ...snippets];
    }

    try {
      await persist();
      closeForm();
      render();
      announce(isEdit ? `スニペット「${title}」を更新しました。` : `スニペット「${title}」を追加しました。`);
    } catch(e) {
      snippets = originalSnippets;
      statusEl.textContent = '保存に失敗しました';
      setTimeout(()=>{ statusEl.textContent = ''; }, 3000);
      announce('保存に失敗しました。');
    }
  });

  // エクスポート機能
  function exportSnippets() {
    try {
      const dataStr = JSON.stringify(snippets, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const tempLink = document.createElement('a');
      tempLink.href = url;
      tempLink.download = `snippets-backup-${date}.json`;
      
      document.body.appendChild(tempLink);
      tempLink.click();
      document.body.removeChild(tempLink);
      URL.revokeObjectURL(url);
      
      announce('スニペットデータのエクスポートが完了しました。');
      statusEl.textContent = 'エクスポート完了';
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
    } catch (e) {
      console.error('Export failed:', e);
      announce('エクスポートに失敗しました。');
      statusEl.textContent = 'エクスポート失敗';
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
    }
  }

  // インポート機能
  function triggerImport() {
    importFile.click();
  }

  async function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const parsed = JSON.parse(evt.target.result);
        if (!validateSnippets(parsed)) {
          throw new Error('Invalid data structure');
        }

        if (!confirm(`インポートを実行すると、現在のデータが全て上書きされます。よろしいですか？（インポート件数: ${parsed.length}件）`)) {
          importFile.value = '';
          return;
        }

        const originalSnippets = snippets;
        snippets = parsed;
        try {
          await persist();
          render();
          if (optionsDialog) {
            optionsDialog.close();
          }
          announce(`スニペットデータをインポートしました。計 ${parsed.length} 件を取り込みました。`);
          statusEl.textContent = 'インポート完了';
          setTimeout(() => { statusEl.textContent = ''; }, 2000);
        } catch (e) {
          snippets = originalSnippets;
          announce('インポートに失敗しました。保存できませんでした。');
          statusEl.textContent = 'インポート失敗: 保存エラー';
          setTimeout(() => { statusEl.textContent = ''; }, 3000);
        }
      } catch (err) {
        console.error('Import failed:', err);
        announce('インポートに失敗しました。無効なファイル形式です。');
        statusEl.textContent = 'インポート失敗: 無効なデータ形式';
        setTimeout(() => { statusEl.textContent = ''; }, 3000);
      }
      importFile.value = '';
    };
    reader.onerror = () => {
      console.error('File reading failed');
      announce('ファイルの読み込みに失敗しました。');
      statusEl.textContent = 'ファイル読込失敗';
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
      importFile.value = '';
    };
    reader.readAsText(file);
  }

  // 設定ダイアログの開閉制御
  if (openOptionsBtn && optionsDialog) {
    openOptionsBtn.addEventListener('click', () => {
      updateGistUI();
      optionsDialog.showModal();
    });
  }
  if (closeOptionsBtn && optionsDialog) {
    closeOptionsBtn.addEventListener('click', () => {
      optionsDialog.close();
    });
  }
  if (optionsDialog) {
    optionsDialog.addEventListener('click', (e) => {
      if (e.target === optionsDialog) {
        optionsDialog.close();
      }
    });
  }

  exportBtn.addEventListener('click', exportSnippets);
  importBtn.addEventListener('click', triggerImport);
  importFile.addEventListener('change', handleImport);

  registerGistListeners();

  load();
})();
