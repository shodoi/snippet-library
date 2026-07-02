(function(){
  const STORAGE_KEY = 'snippets:v1';
  const CATEGORIES_STORAGE_KEY = 'snippets:categories:v1';
  const GIST_SETTINGS_KEY = 'snippets:gist:settings:v1';
  const GIST_TOKEN_KEY = 'snippets:gist:token:v1';
  const THEME_STORAGE_KEY = 'snippets:theme:v1';

  const CATEGORY_COLOR_PALETTE = [
    '#5fb3a3', // teal(既存 terminal 色)
    '#d9a441', // amber(既存 ai 色)
    '#c96a5a', // coral
    '#6a8fd9', // blue
    '#9a7fd4', // purple
    '#d47fa8', // pink
    '#7fc47a', // green
  ];
  const UNCATEGORIZED_COLOR = '#8b8f98'; // 既定カテゴリ専用、選択肢には出さない

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

  // カテゴリデータの構造・内容バリデーション
  function validateCategories(data) {
    if (!Array.isArray(data)) return false;
    
    const ids = new Set();
    let hasUncategorized = false;

    for (const item of data) {
      if (!item || typeof item !== 'object') return false;
      const { id, label, color, protected: isProtected } = item;

      if (typeof id !== 'string' || !id.trim()) return false;
      if (typeof label !== 'string' || !label.trim() || label.length > 30) return false;
      if (typeof isProtected !== 'boolean') return false;

      // 色の検証: パレットまたは未分類専用色のいずれか
      if (typeof color !== 'string') return false;
      const isValidColor = CATEGORY_COLOR_PALETTE.includes(color) || color === UNCATEGORIZED_COLOR;
      if (!isValidColor) return false;

      if (ids.has(id)) return false;
      ids.add(id);

      if (id === 'uncategorized') {
        hasUncategorized = true;
      }
    }

    return hasUncategorized;
  }

  // 読み込みデータの構造・内容バリデーション
  function validateSnippets(data) {
    if (!Array.isArray(data)) return false;
    if (data.length > 1000) return false; // 最大1000件までに制限

    const ids = new Set();

    for (const item of data) {
      if (!item || typeof item !== 'object') return false;
      const { id, title, desc, tag, code } = item;

      // 型と必須項目チェック (id, title, code は空文字不可)
      if (typeof id !== 'string' || !id.trim()) return false;
      if (typeof title !== 'string' || !title.trim()) return false;
      if (typeof desc !== 'string') return false;
      if (typeof tag !== 'string' || !tag.trim()) return false;
      if (typeof code !== 'string' || !code.trim()) return false;

      // IDの一意性チェック
      if (ids.has(id)) return false;
      ids.add(id);

      // 文字数上限チェック (安全のため)
      if (id.length > 100) return false;
      if (title.length > 100) return false;
      if (desc.length > 500) return false;
      if (code.length > 10000) return false;
    }

    return true;
  }

  // カテゴリの読み込み
  async function loadCategories() {
    try {
      const res = await storage.get(CATEGORIES_STORAGE_KEY);
      if (res && res.value) {
        const parsed = JSON.parse(res.value);
        if (validateCategories(parsed)) {
          categories = parsed;
          // uncategorizedの欠落チェック
          if (!categories.find(c => c.id === 'uncategorized')) {
            categories.unshift({ id: 'uncategorized', label: '未分類', color: UNCATEGORIZED_COLOR, protected: true });
            await persistCategories();
          }
          return;
        }
      }
      // 存在しない、またはバリデーションエラーの場合は、空にする（load() 内の移行処理に任せる）
      categories = [];
    } catch (e) {
      console.error('Failed to load categories:', e);
      categories = [];
    }
  }

  // カテゴリの保存
  async function persistCategories() {
    try {
      const result = await storage.set(CATEGORIES_STORAGE_KEY, JSON.stringify(categories));
      if (!result) {
        throw new Error('Storage write failed for categories');
      }
    } catch (e) {
      console.error('Failed to persist categories:', e);
      throw e;
    }
  }

  // IDからカテゴリを取得 (見つからなければ「未分類」を返す)
  function getCategoryById(id) {
    const found = categories.find(c => c.id === id);
    if (found) return found;
    return categories.find(c => c.id === 'uncategorized') || { id: 'uncategorized', label: '未分類', color: UNCATEGORIZED_COLOR, protected: true };
  }

  // カテゴリの追加
  async function addCategory(label, color) {
    const trimmedLabel = label.trim();
    if (!trimmedLabel || trimmedLabel.length > 30) {
      throw new Error('カテゴリ名は1〜30文字で入力してください。');
    }
    if (!CATEGORY_COLOR_PALETTE.includes(color)) {
      throw new Error('無効な色が選択されました。');
    }

    // 重複チェック (大文字小文字区別なし、前後空白なし)
    const isDuplicate = categories.some(c => c.label.toLowerCase() === trimmedLabel.toLowerCase());
    if (isDuplicate) {
      throw new Error('既に同名のカテゴリが存在します。');
    }

    const newCategory = {
      id: generateUUID(),
      label: trimmedLabel,
      color: color,
      protected: false
    };

    categories.push(newCategory);
    try {
      await persistCategories();
    } catch (e) {
      categories.pop(); // ロールバック
      throw e;
    }
  }

  // カテゴリの編集
  async function updateCategory(id, { label, color }) {
    const trimmedLabel = label.trim();
    if (!trimmedLabel || trimmedLabel.length > 30) {
      throw new Error('カテゴリ名は1〜30文字で入力してください。');
    }

    const catIndex = categories.findIndex(c => c.id === id);
    if (catIndex === -1) {
      throw new Error('カテゴリが見つかりません。');
    }

    const category = categories[catIndex];
    if (category.protected) {
      throw new Error('このカテゴリは編集できません。');
    }

    if (!CATEGORY_COLOR_PALETTE.includes(color)) {
      throw new Error('無効な色が選択されました。');
    }

    // 重複チェック (自分自身は除外)
    const isDuplicate = categories.some(c => c.id !== id && c.label.toLowerCase() === trimmedLabel.toLowerCase());
    if (isDuplicate) {
      throw new Error('既に同名のカテゴリが存在します。');
    }

    const originalCategory = { ...category };
    category.label = trimmedLabel;
    category.color = color;

    try {
      await persistCategories();
    } catch (e) {
      categories[catIndex] = originalCategory; // ロールバック
      throw e;
    }
  }

  // カテゴリの削除
  async function deleteCategory(id) {
    const catIndex = categories.findIndex(c => c.id === id);
    if (catIndex === -1) {
      throw new Error('カテゴリが見つかりません。');
    }

    const category = categories[catIndex];
    if (category.protected) {
      throw new Error('このカテゴリは削除できません。');
    }

    const originalCategories = [...categories];
    const originalSnippets = snippets.map(s => ({ ...s }));

    // スニペットのタグを uncategorized に付け替え
    snippets = snippets.map(s => s.tag === id ? { ...s, tag: 'uncategorized' } : s);
    // カテゴリ削除
    categories.splice(catIndex, 1);

    try {
      // 双方を永続化
      await persist();
      await persistCategories();
    } catch (e) {
      // ロールバック
      snippets = originalSnippets;
      categories = originalCategories;
      throw e;
    }
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
  let categories = [];
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

  // テーマ切り替え DOM 要素
  const themeBtn = document.getElementById('themeBtn');
  const themeBtnIcon = document.getElementById('themeBtnIcon');
  const themeMenuContainer = document.getElementById('themeMenuContainer');
  const themeMenu = document.getElementById('themeMenu');
  const themeMenuItems = themeMenu ? themeMenu.querySelectorAll('.theme-menu-item') : [];

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

  // テーマ管理ロジック
  let currentTheme = 'system';
  const themeIcons = {
    light: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path></svg>`,
    dark: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path></svg>`,
    system: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`
  };

  function applyTheme(theme) {
    currentTheme = theme;
    let isDark = false;
    if (theme === 'dark') {
      isDark = true;
    } else if (theme === 'light') {
      isDark = false;
    } else {
      isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    
    // UIの更新
    if (themeBtnIcon) {
      themeBtnIcon.innerHTML = themeIcons[theme] || themeIcons.system;
    }

    if (themeMenuItems) {
      themeMenuItems.forEach(item => {
        const val = item.getAttribute('data-theme-val');
        if (val === theme) {
          item.classList.add('active');
          item.setAttribute('aria-selected', 'true');
        } else {
          item.classList.remove('active');
          item.setAttribute('aria-selected', 'false');
        }
      });
    }

    // スクリーンリーダー向けにラベル変更
    if (themeBtn) {
      const themeLabels = { light: 'ライトテーマ', dark: 'ダークテーマ', system: 'デバイス設定連動テーマ' };
      themeBtn.setAttribute('aria-label', `テーマ切り替え。現在の設定: ${themeLabels[theme]}`);
    }
  }

  // システムの配色変更リスナー
  const systemThemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  function handleSystemThemeChange(e) {
    if (currentTheme === 'system') {
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    }
  }
  systemThemeMediaQuery.addEventListener('change', handleSystemThemeChange);

  // テーマ切り替えUI制御
  function toggleThemeMenu(show) {
    if (!themeMenuContainer || !themeBtn) return;
    const isCurrentlyOpen = themeMenuContainer.classList.contains('open');
    const shouldOpen = show !== undefined ? show : !isCurrentlyOpen;
    
    if (shouldOpen) {
      themeMenuContainer.classList.add('open');
      themeBtn.setAttribute('aria-expanded', 'true');
      // 最初のアクティブな項目にフォーカス
      const activeItem = themeMenu ? themeMenu.querySelector('.theme-menu-item.active') : null;
      if (activeItem) {
        activeItem.focus();
      } else if (themeMenuItems.length > 0) {
        themeMenuItems[0].focus();
      }
    } else {
      themeMenuContainer.classList.remove('open');
      themeBtn.setAttribute('aria-expanded', 'false');
      themeBtn.focus();
    }
  }

  function initThemeEvents() {
    if (!themeBtn || !themeMenuContainer) return;

    themeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleThemeMenu();
    });

    // 項目選択
    if (themeMenuItems) {
      themeMenuItems.forEach(item => {
        item.addEventListener('click', async (e) => {
          const val = item.getAttribute('data-theme-val');
          applyTheme(val);
          await storage.set(THEME_STORAGE_KEY, val);
          toggleThemeMenu(false);
          announce(`テーマを「${item.querySelector('.theme-menu-text').textContent}」に変更しました。`);
        });
      });
    }

    // 外部クリックで閉じる
    document.addEventListener('click', (e) => {
      if (themeMenuContainer.classList.contains('open') && !themeMenuContainer.contains(e.target) && e.target !== themeBtn) {
        toggleThemeMenu(false);
      }
    });

    // キーボードナビゲーション
    themeMenuContainer.addEventListener('keydown', (e) => {
      if (!themeMenuContainer.classList.contains('open')) return;

      const items = Array.from(themeMenuItems);
      const currentIndex = items.indexOf(document.activeElement);

      if (e.key === 'Escape') {
        e.preventDefault();
        toggleThemeMenu(false);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIndex = (currentIndex + 1) % items.length;
        items[nextIndex].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIndex = (currentIndex - 1 + items.length) % items.length;
        items[prevIndex].focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (currentIndex !== -1) {
          items[currentIndex].click();
        }
      }
    });
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
    if (payload.app !== 'snippet-library') return false;
    
    if (payload.schemaVersion === 2) {
      return validateCategories(payload.categories) && validateSnippets(payload.snippets);
    } else if (payload.schemaVersion === 1) {
      return validateSnippets(payload.snippets);
    }
    
    return false;
  }
 
  async function pushToGist() {
    if (!gistToken.trim()) {
      throw new Error('GitHub Tokenが設定されていません');
    }
 
    const payload = {
      schemaVersion: 2,
      app: 'snippet-library',
      updatedAt: new Date().toISOString(),
      categories: categories,
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

        let importSnippets = payload.snippets;
        let importCategories = payload.categories || [];
        const needsMigration = payload.schemaVersion === 1;

        if (needsMigration) {
          const terminalId = generateUUID();
          const aiId = generateUUID();
          importCategories = [
            { id: 'uncategorized', label: '未分類', color: UNCATEGORIZED_COLOR, protected: true },
            { id: terminalId, label: 'Terminal', color: '#5fb3a3', protected: false },
            { id: aiId, label: 'AI Agent', color: '#d9a441', protected: false }
          ];
          importSnippets = importSnippets.map(s => {
            let newTag = 'uncategorized';
            if (s.tag === 'terminal') newTag = terminalId;
            else if (s.tag === 'ai') newTag = aiId;
            return { ...s, tag: newTag };
          });
        } else {
          // 存在しないカテゴリを参照しているスニペットは「未分類」に付け替え
          const catIds = new Set(importCategories.map(c => c.id));
          importSnippets = importSnippets.map(s => {
            if (!catIds.has(s.tag)) {
              return { ...s, tag: 'uncategorized' };
            }
            return s;
          });
        }

        const confirmMsg = needsMigration
          ? `Gistから ${importSnippets.length} 件のスニペットを取得しました。旧形式のデータであるため、新形式に変換して取り込みます。現在のローカルデータを全て上書きしますが、よろしいですか？`
          : `Gistから ${importSnippets.length} 件のスニペットを取得しました。現在のローカルデータを全て上書きしますが、よろしいですか？`;

        if (confirm(confirmMsg)) {
          setSyncState(true);
          const originalSnippets = snippets;
          const originalCategories = categories;
          snippets = importSnippets;
          categories = importCategories;
          try {
            await persist();
            await persistCategories();
            gistSettings.lastPulledAt = payload.updatedAt || new Date().toISOString();
            await saveGistSettings();
            
            if (activeTag !== 'all' && !categories.some(c => c.id === activeTag)) {
              activeTag = 'all';
            }
            renderCategorySelect();
            renderTagFilters();
            render();
            if (optionsDialog) {
              optionsDialog.close();
            }
            updateGistUI();
            announce('Gistからの読み込みとローカルへの反映が完了しました。');
            alert('Gistからの読み込みが完了しました。');
          } catch (e) {
            snippets = originalSnippets;
            categories = originalCategories;
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
      // テーマの復元
      const savedThemeRes = await storage.get(THEME_STORAGE_KEY);
      const savedTheme = (savedThemeRes && savedThemeRes.value) ? savedThemeRes.value : 'system';
      applyTheme(savedTheme);

      await loadGistSettings();

      // カテゴリのロード
      const catRes = await storage.get(CATEGORIES_STORAGE_KEY);
      let needsMigration = !catRes || !catRes.value;

      let terminalId = '';
      let aiId = '';

      if (needsMigration) {
        // 新規カテゴリの初期設定
        terminalId = generateUUID();
        aiId = generateUUID();
        categories = [
          { id: 'uncategorized', label: '未分類', color: UNCATEGORIZED_COLOR, protected: true },
          { id: terminalId, label: 'Terminal', color: '#5fb3a3', protected: false },
          { id: aiId, label: 'AI Agent', color: '#d9a441', protected: false }
        ];
      } else {
        await loadCategories();
      }

      const res = await storage.get(STORAGE_KEY);
      if (!res || !res.value) {
        // 保存データが存在しない
        snippets = seed;
        if (needsMigration) {
          // 初期データも新カテゴリIDに移行する
          snippets = snippets.map(s => {
            let newTag = 'uncategorized';
            if (s.tag === 'terminal') newTag = terminalId;
            else if (s.tag === 'ai') newTag = aiId;
            return { ...s, tag: newTag };
          });
          await persist();
          await persistCategories();
        } else {
          await persist();
        }
        statusEl.textContent = '';
        renderCategorySelect();
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
        if (needsMigration) {
          // 既存スニペットのタグをUUIDにマッピングする
          snippets = snippets.map(s => {
            let newTag = 'uncategorized';
            if (s.tag === 'terminal') newTag = terminalId;
            else if (s.tag === 'ai') newTag = aiId;
            return { ...s, tag: newTag };
          });
          await persist();
          await persistCategories();
        }
        statusEl.textContent = '';
        renderCategorySelect();
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

  function renderCategorySelect(){
    const fTag = document.getElementById('f-tag');
    if (!fTag) return;
    fTag.innerHTML = '';
    const sortedCats = [...categories].sort((a, b) => (a.id === 'uncategorized' ? 1 : b.id === 'uncategorized' ? -1 : 0));
    sortedCats.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.label;
      fTag.appendChild(opt);
    });
  }

  let editingCategoryId = null;

  function renderCategoryManager() {
    const listEl = document.getElementById('categoryManagerList');
    if (!listEl) return;
    listEl.innerHTML = '';

    const sortedCats = [...categories].sort((a, b) => (a.id === 'uncategorized' ? 1 : b.id === 'uncategorized' ? -1 : 0));
    sortedCats.forEach(c => {
      const item = document.createElement('div');
      item.className = 'category-item';
      item.id = `cat-item-${c.id}`;

      if (editingCategoryId === c.id) {
        // 編集モード
        item.innerHTML = `
          <div class="category-edit-form" style="width: 100%; border: none; padding: 0; background: transparent; margin: 0;">
            <div class="category-form-row">
              <input type="text" id="catEditName-${c.id}" value="${c.label}" required maxlength="30" aria-label="カテゴリ名編集">
              <button type="button" class="btn btn-primary" id="catSaveBtn-${c.id}">保存</button>
              <button type="button" class="btn btn-ghost" id="catCancelBtn-${c.id}">キャンセル</button>
            </div>
            <div class="category-color-selector">
              <span class="color-selector-label">色:</span>
              <div id="catEditColors-${c.id}" class="color-palette-radios"></div>
            </div>
            <div id="catEditError-${c.id}" class="field-hint danger-text" style="display:none;" role="alert"></div>
          </div>
        `;
        
        // カラーパレットの生成
        const colorsContainer = item.querySelector(`#catEditColors-${c.id}`);
        let selectedColor = c.color;
        CATEGORY_COLOR_PALETTE.forEach(color => {
          const radio = document.createElement('label');
          radio.className = 'color-radio' + (color === selectedColor ? ' selected' : '');
          radio.style.backgroundColor = color;
          radio.innerHTML = `<input type="radio" name="editColor-${c.id}" value="${color}" ${color === selectedColor ? 'checked' : ''}>`;
          radio.addEventListener('change', (e) => {
            if (e.target.checked) {
              selectedColor = color;
              item.querySelectorAll('.color-radio').forEach(r => r.classList.remove('selected'));
              radio.classList.add('selected');
            }
          });
          colorsContainer.appendChild(radio);
        });

        // 保存ボタンイベント
        item.querySelector(`#catSaveBtn-${c.id}`).addEventListener('click', async () => {
          const newName = item.querySelector(`#catEditName-${c.id}`).value.trim();
          const errorEl = item.querySelector(`#catEditError-${c.id}`);
          errorEl.style.display = 'none';

          if (!newName || newName.length > 30) {
            errorEl.textContent = 'カテゴリ名は1〜30文字で入力してください。';
            errorEl.style.display = 'block';
            return;
          }

          try {
            await updateCategory(c.id, { label: newName, color: selectedColor });
            editingCategoryId = null;
            renderCategoryManager();
            renderCategorySelect();
            renderTagFilters();
            render();
            announce(`カテゴリ「${newName}」を更新しました。`);
          } catch (err) {
            errorEl.textContent = err.message;
            errorEl.style.display = 'block';
          }
        });

        // キャンセルボタンイベント
        item.querySelector(`#catCancelBtn-${c.id}`).addEventListener('click', () => {
          editingCategoryId = null;
          renderCategoryManager();
        });

      } else {
        // 通常表示モード
        item.innerHTML = `
          <div class="swatch" style="background-color: ${c.color}"></div>
          <span class="label">${c.label}</span>
          <div class="actions">
            ${c.protected ? '' : `
              <button type="button" class="btn-cat edit-btn" aria-label="${c.label}を編集">編集</button>
              <button type="button" class="btn-cat danger delete-btn" aria-label="${c.label}を削除">削除</button>
            `}
          </div>
        `;

        if (!c.protected) {
          item.querySelector('.edit-btn').addEventListener('click', () => {
            editingCategoryId = c.id;
            renderCategoryManager();
          });

          item.querySelector('.delete-btn').addEventListener('click', async () => {
            const count = snippets.filter(s => s.tag === c.id).length;
            const confirmMsg = count > 0 
              ? `このカテゴリに属する ${count} 件のスニペットは「未分類」に移動されます。このカテゴリ「${c.label}」を削除してもよろしいですか？`
              : `カテゴリ「${c.label}」を削除してもよろしいですか？`;
            
            if (confirm(confirmMsg)) {
              try {
                await deleteCategory(c.id);
                renderCategoryManager();
                renderCategorySelect();
                if (activeTag === c.id) {
                  activeTag = 'all';
                }
                renderTagFilters();
                render();
                announce(`カテゴリ「${c.label}」を削除しました。`);
              } catch (err) {
                alert(`カテゴリの削除に失敗しました: ${err.message}`);
              }
            }
          });
        }
      }
      listEl.appendChild(item);
    });

    // 新規追加フォームのカラーパレット生成
    const addColorsContainer = document.getElementById('catAddColors');
    if (addColorsContainer) {
      addColorsContainer.innerHTML = '';
      let selectedColor = CATEGORY_COLOR_PALETTE[0];
      CATEGORY_COLOR_PALETTE.forEach((color, idx) => {
        const radio = document.createElement('label');
        radio.className = 'color-radio' + (idx === 0 ? ' selected' : '');
        radio.style.backgroundColor = color;
        radio.innerHTML = `<input type="radio" name="addColor" value="${color}" ${idx === 0 ? 'checked' : ''}>`;
        radio.addEventListener('change', (e) => {
          if (e.target.checked) {
            selectedColor = color;
            addColorsContainer.querySelectorAll('.color-radio').forEach(r => r.classList.remove('selected'));
            radio.classList.add('selected');
          }
        });
        addColorsContainer.appendChild(radio);
      });

      // 新規追加のフォーム送信イベントリスナ登録
      const addForm = document.getElementById('categoryAddForm');
      if (addForm && !addForm.dataset.listenerRegistered) {
        addForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const nameInput = document.getElementById('catAddName');
          const errorEl = document.getElementById('catAddError');
          const name = nameInput.value.trim();
          errorEl.style.display = 'none';

          if (!name || name.length > 30) {
            errorEl.textContent = 'カテゴリ名は1〜30文字で入力してください。';
            errorEl.style.display = 'block';
            return;
          }

          const checkedRadio = addColorsContainer.querySelector('input[name="addColor"]:checked');
          const color = checkedRadio ? checkedRadio.value : CATEGORY_COLOR_PALETTE[0];

          try {
            await addCategory(name, color);
            nameInput.value = '';
            const firstRadio = addColorsContainer.querySelector('input[name="addColor"]');
            if (firstRadio) {
              firstRadio.checked = true;
              addColorsContainer.querySelectorAll('.color-radio').forEach(r => r.classList.remove('selected'));
              firstRadio.parentElement.classList.add('selected');
            }
            renderCategoryManager();
            renderCategorySelect();
            renderTagFilters();
            render();
            announce(`カテゴリ「${name}」を追加しました。`);
          } catch (err) {
            errorEl.textContent = err.message;
            errorEl.style.display = 'block';
          }
        });
        addForm.dataset.listenerRegistered = 'true';
      }
    }
  }

  function renderTagFilters(){
    const sortedCats = [...categories].sort((a, b) => (a.id === 'uncategorized' ? 1 : b.id === 'uncategorized' ? -1 : 0));
    const tags = ['all', ...sortedCats.map(c => c.id)];
    tagFiltersEl.innerHTML = '';
    tags.forEach(t=>{
      const btn = document.createElement('button');
      btn.className = 'tag-btn' + (activeTag===t ? ' active':'');
      
      let label = 'すべて';
      let catColor = 'var(--teal)';
      if (t !== 'all') {
        const cat = getCategoryById(t);
        label = cat.label;
        catColor = cat.color;
      }
      btn.textContent = label;
      btn.style.setProperty('--cat-color', catColor);
      
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

      const category = getCategoryById(s.tag);
      card.style.setProperty('--cat-color', category.color);

      // AI Agentタグの場合は '#'、それ以外は '$'
      const isAI = category.label.toLowerCase() === 'ai agent';
      const promptMark = isAI ? '#' : '$';

      card.innerHTML = `
        <div class="card-head">
          <div>
            <div class="card-title"></div>
            <div class="card-desc"></div>
          </div>
          <div class="card-tag"></div>
        </div>
        <div class="code-row">
          <span class="prompt-mark" aria-hidden="true">${promptMark}</span>
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
      card.querySelector('.card-tag').textContent = category.label;
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

    // タグ選択肢の動的更新
    renderCategorySelect();

    const defaultTag = categories.find(c => !c.protected)?.id || categories[0]?.id || 'uncategorized';

    document.getElementById('f-title').value = existing ? existing.title : '';
    document.getElementById('f-desc').value = existing ? existing.desc : '';
    document.getElementById('f-tag').value = existing ? existing.tag : defaultTag;
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
      const payload = {
        schemaVersion: 2,
        app: 'snippet-library',
        exportedAt: new Date().toISOString(),
        categories: categories,
        snippets: snippets
      };
      const dataStr = JSON.stringify(payload, null, 2);
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
        let importCategories = [];
        let importSnippets = [];
        let needsMigration = false;

        // ペイロード形式の検証
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const { schemaVersion, app, categories: parsedCats, snippets: parsedSnips } = parsed;
          if (app !== 'snippet-library') {
            throw new Error('無効なアプリケーションデータです。');
          }
          if (schemaVersion === 2) {
            if (!validateCategories(parsedCats) || !validateSnippets(parsedSnips)) {
              throw new Error('データ構造が無効か、破損しています。');
            }
            importCategories = parsedCats;
            importSnippets = parsedSnips;
          } else if (schemaVersion === 1) {
            if (!validateSnippets(parsedSnips)) {
              throw new Error('データ構造が無効か、破損しています。');
            }
            importSnippets = parsedSnips;
            needsMigration = true;
          } else {
            throw new Error(`サポートされていないデータバージョンです（バージョン: ${schemaVersion}）。`);
          }
        } else if (Array.isArray(parsed)) {
          if (!validateSnippets(parsed)) {
            throw new Error('データ構造が無効か、破損しています。');
          }
          importSnippets = parsed;
          needsMigration = true;
        } else {
          throw new Error('無効なデータ形式です。');
        }

        if (needsMigration) {
          const terminalId = generateUUID();
          const aiId = generateUUID();
          importCategories = [
            { id: 'uncategorized', label: '未分類', color: UNCATEGORIZED_COLOR, protected: true },
            { id: terminalId, label: 'Terminal', color: '#5fb3a3', protected: false },
            { id: aiId, label: 'AI Agent', color: '#d9a441', protected: false }
          ];

          importSnippets = importSnippets.map(s => {
            let newTag = 'uncategorized';
            if (s.tag === 'terminal') newTag = terminalId;
            else if (s.tag === 'ai') newTag = aiId;
            return { ...s, tag: newTag };
          });
        } else {
          // 存在しないカテゴリを参照しているスニペットは「未分類」に付け替え
          const catIds = new Set(importCategories.map(c => c.id));
          importSnippets = importSnippets.map(s => {
            if (!catIds.has(s.tag)) {
              return { ...s, tag: 'uncategorized' };
            }
            return s;
          });
        }

        const confirmMsg = needsMigration 
          ? `旧形式のデータを新形式に変換して取り込みます。インポートを実行すると、現在のデータが全て上書きされます。よろしいですか？（インポート件数: ${importSnippets.length}件）`
          : `インポートを実行すると、現在のデータが全て上書きされます。よろしいですか？（インポート件数: ${importSnippets.length}件）`;

        if (!confirm(confirmMsg)) {
          importFile.value = '';
          return;
        }

        const originalSnippets = snippets;
        const originalCategories = categories;

        snippets = importSnippets;
        categories = importCategories;

        try {
          await persist();
          await persistCategories();
          
          if (activeTag !== 'all' && !categories.some(c => c.id === activeTag)) {
            activeTag = 'all';
          }
          renderCategorySelect();
          renderTagFilters();
          render();
          
          if (optionsDialog) {
            optionsDialog.close();
          }
          announce(`スニペットデータをインポートしました。計 ${snippets.length} 件を取り込みました。`);
          statusEl.textContent = 'インポート完了';
          setTimeout(() => { statusEl.textContent = ''; }, 2000);
        } catch (e) {
          snippets = originalSnippets;
          categories = originalCategories;
          announce('インポートに失敗しました。保存できませんでした。');
          statusEl.textContent = 'インポート失敗: 保存エラー';
          setTimeout(() => { statusEl.textContent = ''; }, 3000);
        }
      } catch (err) {
        console.error('Import failed:', err);
        announce(`インポートに失敗しました。${err.message}`);
        statusEl.textContent = 'インポート失敗: エラー';
        alert(`インポートに失敗しました。\n理由: ${err.message}`);
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
      renderCategoryManager();
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
  initThemeEvents();

  load();
})();
