(function(){
  const STORAGE_KEY = 'snippets:v1';
  const CATEGORIES_STORAGE_KEY = 'snippets:categories:v1';
  const GIST_SETTINGS_KEY = 'snippets:gist:settings:v1';
  const GIST_TOKEN_KEY = 'snippets:gist:token:v1';
  const THEME_STORAGE_KEY = 'snippets:theme:v1';
  const LAST_UPDATED_KEY = 'snippets:last_updated:v1';

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

  // 最終更新日時の読み込み
  async function loadLastUpdatedAt() {
    try {
      const res = await storage.get(LAST_UPDATED_KEY);
      lastUpdatedAt = (res && res.value) ? res.value : null;
    } catch (e) {
      console.warn('Failed to load last updated time:', e);
    }
  }

  // 最終更新日時の更新
  async function updateLastLocalChange() {
    lastUpdatedAt = new Date().toISOString();
    try {
      await storage.set(LAST_UPDATED_KEY, lastUpdatedAt);
    } catch (e) {
      console.error('Failed to save last updated time:', e);
    }
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
      const isGistConnected = !!(gistToken.trim() && gistSettings.gistId.trim());
      if (isGistConnected) {
        await autoPushToGist();
      } else {
        showToast('カテゴリを追加しました', 'success');
      }
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
      const isGistConnected = !!(gistToken.trim() && gistSettings.gistId.trim());
      if (isGistConnected) {
        await autoPushToGist();
      } else {
        showToast('カテゴリを更新しました', 'success');
      }
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
      
      const isGistConnected = !!(gistToken.trim() && gistSettings.gistId.trim());
      if (isGistConnected) {
        await autoPushToGist();
      } else {
        showToast('カテゴリを削除しました', 'success');
      }
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
  let lastUpdatedAt = null;

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
  const gistConnectBtn = document.getElementById('gistConnectBtn');
  const gistSetupView = document.getElementById('gistSetupView');
  const gistConnectedView = document.getElementById('gistConnectedView');
  const connectedGistIdText = document.getElementById('connectedGistIdText');
  const gistSyncBtn = document.getElementById('gistSyncBtn');
  const tokenStorageRadios = document.getElementsByName('tokenStorage');
  const toastContainer = document.getElementById('toast-container');

  // スクリーンリーダー向け動的通知
  function announce(message) {
    if (!srAnnouncer) return;
    srAnnouncer.textContent = '';
    setTimeout(() => {
      srAnnouncer.textContent = message;
    }, 100);
  }

  // トースト表示ヘルパー
  function showToast(message, type = 'success') {
    if (!toastContainer) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    // アイコンの定義
    let iconSvg = '';
    if (type === 'success') {
      iconSvg = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      `;
    } else if (type === 'error') {
      iconSvg = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="15" y1="9" x2="9" y2="15"></line>
          <line x1="9" y1="9" x2="15" y2="15"></line>
        </svg>
      `;
    } else if (type === 'warning') {
      iconSvg = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
      `;
    }

    toast.innerHTML = `
      <span class="toast-icon">${iconSvg}</span>
      <span class="toast-message">${escapeHtml(message)}</span>
    `;

    toastContainer.appendChild(toast);

    // 4秒後にDOMから自動削除 (フェードアウトアニメーション待ち)
    setTimeout(() => {
      if (toast.parentNode === toastContainer) {
        toastContainer.removeChild(toast);
      }
    }, 4000);
  }

  // HTMLエスケープヘルパー
  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
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
      // aria-activedescendant で現在選択中の項目をスクリーンリーダーに通知
      if (themeMenu) {
        const activeItem = themeMenu.querySelector('.theme-menu-item.active');
        themeMenu.setAttribute('aria-activedescendant', activeItem ? activeItem.id : '');
      }
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
    listEl.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'error-panel';
    const h3 = document.createElement('h3');
    h3.textContent = 'データの読み込みに失敗しました';
    const p1 = document.createElement('p');
    p1.textContent = '保存されているデータが破損しているか、無効な形式です。データを保護するため、初期データでの自動上書きは行いませんでした。';
    const p2 = document.createElement('p');
    p2.textContent = '以下のいずれかの操作を行ってください：';
    const actions = document.createElement('div');
    actions.className = 'error-actions';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.id = 'btn-export-corrupted';
    exportBtn.className = 'btn';
    exportBtn.textContent = '破損データをダウンロード';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.id = 'btn-reset-corrupted';
    resetBtn.className = 'btn danger';
    resetBtn.textContent = 'データをリセット（初期化）';
    actions.append(exportBtn, resetBtn);
    panel.append(h3, p1, p2, actions);
    listEl.appendChild(panel);
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
          await autoPushToGist();
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

  // 編集中の未確定データ
  let tempGistToken = '';
  let tempGistId = '';
  let tempTokenStorage = 'session';

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

  // Gist ID の形式バリデーション
  function isValidGistId(id) {
    return typeof id === 'string' && /^[a-f0-9]+$/.test(id);
  }

  // 既存 Gist 更新
  async function updateGist(token, gistId, payload) {
    if (!isValidGistId(gistId)) {
      throw new Error('Gist IDの形式が無効です（16進英数字のみ使用できます）');
    }
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
    if (!isValidGistId(gistId)) {
      throw new Error('Gist IDの形式が無効です（16進英数字のみ使用できます）');
    }
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
 
    // ローカルの最終更新日時を更新し、それを使用する
    await updateLastLocalChange();

    const payload = {
      schemaVersion: 2,
      app: 'snippet-library',
      updatedAt: lastUpdatedAt,
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

  async function autoPushToGist() {
    // まずローカルの変更日時を更新
    await updateLastLocalChange();

    // Gist連携が未設定なら何もしない
    if (!gistToken.trim() || !gistSettings.gistId) {
      return;
    }

    if (statusEl) {
      statusEl.textContent = 'Gistに自動保存中…';
    }

    try {
      await pushToGist();
      updateGistUI();
      showToast('Gistに自動保存しました', 'success');
      if (statusEl) {
        statusEl.textContent = 'Gist自動保存完了';
        setTimeout(() => {
          if (statusEl.textContent === 'Gist自動保存完了') {
            statusEl.textContent = '';
          }
        }, 3000);
      }
    } catch (err) {
      console.warn('Auto backup to Gist failed:', err);
      showToast('Gist自動保存に失敗しました（オフラインなど）', 'error');
      if (statusEl) {
        statusEl.textContent = 'Gist自動保存失敗（オフラインなど）';
        setTimeout(() => {
          if (statusEl.textContent === 'Gist自動保存失敗（オフラインなど）') {
            statusEl.textContent = '';
          }
        }, 3000);
      }
    }
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

  async function autoSyncGistOnLoad() {
    if (!gistToken.trim() || !gistSettings.gistId) {
      return; // Gist連携が未設定の場合は何もしない
    }

    if (statusEl) {
      statusEl.textContent = 'Gistと同期中…';
    }

    try {
      // 1. Gistからデータを取得
      const payload = await fetchGist(gistToken, gistSettings.gistId);
      if (!validateGistPayload(payload)) {
        throw new Error('Gistデータが無効か破損しています');
      }

      const gistUpdatedAt = payload.updatedAt;

      // 2. 更新日時を比較
      const localTime = lastUpdatedAt ? new Date(lastUpdatedAt).getTime() : 0;
      const gistTime = gistUpdatedAt ? new Date(gistUpdatedAt).getTime() : 0;

      // 許容誤差として1秒(1000ms)未満のズレは同一とみなす
      const diff = Math.abs(localTime - gistTime);

      if (gistTime > localTime && diff > 1000) {
        // Gistの方が新しい場合：自動で取り込み
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
          const catIds = new Set(importCategories.map(c => c.id));
          importSnippets = importSnippets.map(s => {
            if (!catIds.has(s.tag)) {
              return { ...s, tag: 'uncategorized' };
            }
            return s;
          });
        }

        snippets = importSnippets;
        categories = importCategories;

        await persist();
        await persistCategories();

        gistSettings.lastPulledAt = gistUpdatedAt;
        await saveGistSettings();

        // ローカルの更新時間も合わせる
        lastUpdatedAt = gistUpdatedAt;
        try {
          await storage.set(LAST_UPDATED_KEY, lastUpdatedAt);
        } catch (e) {}

        if (activeTag !== 'all' && !categories.some(c => c.id === activeTag)) {
          activeTag = 'all';
        }
        renderCategorySelect();
        renderTagFilters();
        render();
        updateGistUI();
        showToast('Gistから自動同期しました', 'success');

        if (statusEl) {
          statusEl.textContent = 'Gistから自動同期しました';
          setTimeout(() => {
            if (statusEl.textContent === 'Gistから自動同期しました') {
              statusEl.textContent = '';
            }
          }, 3000);
        }
      } else if (localTime > gistTime && diff > 1000) {
        // ローカルの方が新しい場合：自動でGistにプッシュ
        const pushPayload = {
          schemaVersion: 2,
          app: 'snippet-library',
          updatedAt: lastUpdatedAt || new Date().toISOString(),
          categories: categories,
          snippets: snippets
        };
        const result = await updateGist(gistToken, gistSettings.gistId, pushPayload);
        gistSettings.lastPushedAt = pushPayload.updatedAt;
        await saveGistSettings();
        updateGistUI();
        showToast('Gistに自動保存しました', 'success');

        if (statusEl) {
          statusEl.textContent = 'Gistに自動同期保存しました';
          setTimeout(() => {
            if (statusEl.textContent === 'Gistに自動同期保存しました') {
              statusEl.textContent = '';
            }
          }, 3000);
        }
      } else {
        // 時刻がほぼ同じ（または同一）なら同期不要
        if (statusEl) {
          statusEl.textContent = 'Gist同期済み';
          setTimeout(() => {
            if (statusEl.textContent === 'Gist同期済み') {
              statusEl.textContent = '';
            }
          }, 2000);
        }
      }
    } catch (err) {
      console.warn('Auto sync on load failed:', err);
      showToast('Gist自動同期に失敗しました（オフラインなど）', 'error');
      if (statusEl) {
        statusEl.textContent = 'Gist同期失敗（オフラインなど）';
        setTimeout(() => {
          if (statusEl.textContent === 'Gist同期失敗（オフラインなど）') {
            statusEl.textContent = '';
          }
        }, 3000);
      }
    }
  }

  function updateGistUI() {
    if (!gistTokenEl) return;
    
    // UIを開いた時点の決定値で一時変数を初期化
    tempGistToken = gistToken;
    tempGistId = gistSettings.gistId;
    tempTokenStorage = gistSettings.tokenStorage;

    gistTokenEl.value = tempGistToken;
    gistIdEl.value = tempGistId;

    for (const radio of tokenStorageRadios) {
      radio.checked = (radio.value === tempTokenStorage);
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

    // 接続状態に応じてビューの表示/非表示を切り替える
    const isConnected = !!(gistToken.trim() && gistSettings.gistId.trim());
    if (isConnected) {
      if (gistSetupView) gistSetupView.style.display = 'none';
      if (gistConnectedView) gistConnectedView.style.display = 'block';
      if (connectedGistIdText) connectedGistIdText.textContent = gistSettings.gistId;
    } else {
      if (gistSetupView) gistSetupView.style.display = 'block';
      if (gistConnectedView) gistConnectedView.style.display = 'none';
    }

    updateGistControlsState();
  }

  function updateGistControlsState() {
    const isConnected = !!(gistToken.trim() && gistSettings.gistId.trim());
    const hasTokenInput = !!tempGistToken.trim();

    if (gistPullBtn) {
      gistPullBtn.disabled = !isConnected;
    }
    if (gistPushBtn) {
      gistPushBtn.disabled = !isConnected;
    }
    if (gistDeleteBtn) {
      gistDeleteBtn.disabled = !gistToken.trim();
    }
    if (gistConnectBtn) {
      gistConnectBtn.disabled = !hasTokenInput;
    }
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
      tempGistToken = e.target.value.trim();
      updateGistControlsState();
    });

    gistIdEl.addEventListener('input', (e) => {
      tempGistId = e.target.value.trim();
    });

    for (const radio of tokenStorageRadios) {
      radio.addEventListener('change', (e) => {
        if (e.target.checked) {
          tempTokenStorage = e.target.value;
        }
      });
    }

    if (gistConnectBtn) {
      gistConnectBtn.addEventListener('click', async () => {
        if (!tempGistToken.trim()) {
          alert('GitHub Token を入力してください。');
          gistTokenEl.focus();
          return;
        }

        const originalBtnText = gistConnectBtn.textContent;
        gistConnectBtn.textContent = '接続検証中…';
        gistConnectBtn.disabled = true;
        setSyncState(true);

        try {
          let testGistId = tempGistId.trim();
          let payload = null;

          if (testGistId) {
            announce('Gistの接続検証中…');
            payload = await fetchGist(tempGistToken, testGistId);
            if (!validateGistPayload(payload)) {
              throw new Error('Gistデータが無効か破損しています');
            }
          } else {
            announce('新規Gist作成テスト中…');
            const initialPayload = {
              schemaVersion: 2,
              app: 'snippet-library',
              updatedAt: new Date().toISOString(),
              categories: categories,
              snippets: snippets
            };
            const result = await createGist(tempGistToken, initialPayload);
            testGistId = result.id;
            payload = initialPayload;
          }

          // 接続成功したら設定を確定・保存
          gistToken = tempGistToken;
          gistSettings.gistId = testGistId;
          gistSettings.tokenStorage = tempTokenStorage;
          
          if (payload && payload.updatedAt) {
            gistSettings.lastPushedAt = payload.updatedAt;
            gistSettings.lastPulledAt = payload.updatedAt;
          }

          saveGistToken();
          await saveGistSettings();

          // その場で自動同期処理を実行
          announce('接続成功。データを同期しています…');
          
          const gistUpdatedAt = payload.updatedAt;
          const localTime = lastUpdatedAt ? new Date(lastUpdatedAt).getTime() : 0;
          const gistTime = gistUpdatedAt ? new Date(gistUpdatedAt).getTime() : 0;
          const diff = Math.abs(localTime - gistTime);

          if (gistTime > localTime && diff > 1000) {
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
              const catIds = new Set(importCategories.map(c => c.id));
              importSnippets = importSnippets.map(s => {
                if (!catIds.has(s.tag)) {
                  return { ...s, tag: 'uncategorized' };
                }
                return s;
              });
            }

            snippets = importSnippets;
            categories = importCategories;

            await persist();
            await persistCategories();

            lastUpdatedAt = gistUpdatedAt;
            try {
              await storage.set(LAST_UPDATED_KEY, lastUpdatedAt);
            } catch (e) {}

            if (activeTag !== 'all' && !categories.some(c => c.id === activeTag)) {
              activeTag = 'all';
            }
            renderCategorySelect();
            renderTagFilters();
            render();
          } else if (localTime > gistTime && diff > 1000) {
            const pushPayload = {
              schemaVersion: 2,
              app: 'snippet-library',
              updatedAt: lastUpdatedAt || new Date().toISOString(),
              categories: categories,
              snippets: snippets
            };
            await updateGist(gistToken, gistSettings.gistId, pushPayload);
            gistSettings.lastPushedAt = pushPayload.updatedAt;
            await saveGistSettings();
          }

          updateGistUI();
          announce('Gistの接続と同期が完了しました。');
          showToast('Gistの接続と同期が完了しました。', 'success');
          alert('Gistの接続と同期が完了しました。');
        } catch (err) {
          console.error('Gist connection or sync failed:', err);
          let friendlyMsg = '接続または同期に失敗しました。\n';
          if (err.status === 401 || err.status === 403) {
            friendlyMsg += 'GitHub Token の権限または有効期限を確認してください。';
          } else if (err.status === 404) {
            friendlyMsg += 'Gist ID が存在しないか、Tokenの権限が不足しています。';
          } else {
            friendlyMsg += err.message;
          }
          showToast(friendlyMsg, 'error');
          announce(friendlyMsg);
          alert(friendlyMsg);
        } finally {
          gistConnectBtn.textContent = originalBtnText;
          setSyncState(false);
          updateGistControlsState();
        }
      });
    }

    gistDeleteBtn.addEventListener('click', async () => {
      if (confirm('GitHub Token および Gist ID などの連携設定を削除します。よろしいですか？')) {
        await deleteGistSettings();
        updateGistUI();
        showToast('Gist連携設定を削除しました。', 'success');
        announce('Gist連携設定を削除しました。');
      }
    });

    let isSyncing = false;
    function setSyncState(syncing) {
      isSyncing = syncing;
      if (gistPullBtn) gistPullBtn.disabled = syncing;
      if (gistPushBtn) gistPushBtn.disabled = syncing;
      if (gistDeleteBtn) gistDeleteBtn.disabled = syncing;
      if (gistConnectBtn) gistConnectBtn.disabled = syncing;
      if (gistSyncBtn) gistSyncBtn.disabled = syncing;
      if (gistTokenEl) gistTokenEl.disabled = syncing;
      if (gistIdEl) gistIdEl.disabled = syncing;
      for (const radio of tokenStorageRadios) {
        radio.disabled = syncing;
      }
      if (!syncing) {
        updateGistControlsState();
      }
    }

    gistSyncBtn.addEventListener('click', async () => {
      if (isSyncing) return;
      if (!gistToken.trim() || !gistSettings.gistId) {
        return;
      }

      setSyncState(true);
      announce('Gistとの手動同期を開始します…');

      try {
        // 1. Gistからデータを取得
        const payload = await fetchGist(gistToken, gistSettings.gistId);
        if (!validateGistPayload(payload)) {
          throw new Error('Gistデータが無効か破損しています');
        }

        const gistUpdatedAt = payload.updatedAt;

        // 2. 更新日時を比較
        const localTime = lastUpdatedAt ? new Date(lastUpdatedAt).getTime() : 0;
        const gistTime = gistUpdatedAt ? new Date(gistUpdatedAt).getTime() : 0;

        // 許容誤差として1秒(1000ms)未満のズレは同一とみなす
        const diff = Math.abs(localTime - gistTime);

        if (gistTime > localTime && diff > 1000) {
          // Gistの方が新しい場合：自動で取り込み
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
            const catIds = new Set(importCategories.map(c => c.id));
            importSnippets = importSnippets.map(s => {
              if (!catIds.has(s.tag)) {
                return { ...s, tag: 'uncategorized' };
              }
              return s;
            });
          }

          snippets = importSnippets;
          categories = importCategories;

          await persist();
          await persistCategories();

          gistSettings.lastPulledAt = gistUpdatedAt;
          await saveGistSettings();

          // ローカルの更新時間も合わせる
          lastUpdatedAt = gistUpdatedAt;
          try {
            await storage.set(LAST_UPDATED_KEY, lastUpdatedAt);
          } catch (e) {}

          if (activeTag !== 'all' && !categories.some(c => c.id === activeTag)) {
            activeTag = 'all';
          }
          renderCategorySelect();
          renderTagFilters();
          render();
          updateGistUI();

          showToast('Gistの最新データを反映しました。', 'success');
          announce('Gistの最新データを反映しました。');
        } else if (localTime > gistTime && diff > 1000) {
          // ローカルの方が新しい場合：自動でGistにプッシュ
          const pushPayload = {
            schemaVersion: 2,
            app: 'snippet-library',
            updatedAt: lastUpdatedAt || new Date().toISOString(),
            categories: categories,
            snippets: snippets
          };
          const result = await updateGist(gistToken, gistSettings.gistId, pushPayload);
          gistSettings.lastPushedAt = pushPayload.updatedAt;
          await saveGistSettings();
          updateGistUI();

          showToast('ローカルの最新データをGistへ保存しました。', 'success');
          announce('ローカルの最新データをGistへ保存しました。');
        } else {
          // 時刻がほぼ同じ（または同一）なら同期不要
          showToast('すでに最新の状態です。', 'success');
          announce('同期は不要です。すでに最新の状態です。');
        }
      } catch (err) {
        console.warn('Manual sync failed:', err);
        showToast('同期に失敗しました（オフラインや権限不足）', 'error');
        announce('同期に失敗しました。');
      } finally {
        setSyncState(false);
      }
    });

    gistPushBtn.addEventListener('click', async () => {
      if (isSyncing) return;
      if (!gistToken.trim()) {
        alert('GitHub Token を入力してください。');
        gistTokenEl.focus();
        return;
      }

      setSyncState(true);

      // 上書き警告のチェック
      try {
        if (gistSettings.gistId) {
          announce('Gist上の最新データを確認中…');
          const payload = await fetchGist(gistToken, gistSettings.gistId);
          if (payload && validateGistPayload(payload)) {
            const gistUpdatedAt = payload.updatedAt;
            const gistSnippets = payload.snippets || [];

            const localTime = lastUpdatedAt ? new Date(lastUpdatedAt).getTime() : 0;
            const gistTime = gistUpdatedAt ? new Date(gistUpdatedAt).getTime() : 0;

            const isGistNewer = (gistTime > localTime && Math.abs(localTime - gistTime) > 1000);
            const isLocalSignificantlySmaller = (snippets.length <= 2 && gistSnippets.length > snippets.length);

            if (isGistNewer || isLocalSignificantlySmaller) {
              const confirmMsg = isLocalSignificantlySmaller
                ? `【警告】Gist上のスニペット数（${gistSnippets.length}件）に比べ、ローカルのスニペット数（${snippets.length}件）が極端に少ないです。\nこのまま保存すると、Gistに保存されている既存データが上書きされ、失われてしまいます。\n\n本当にGistへ上書き保存しますか？`
                : `【警告】Gist上のデータの方が新しいです（Gist側更新: ${new Date(gistUpdatedAt).toLocaleString('ja-JP')}）。\nこのまま保存すると、Gistの最新の変更内容がローカルのデータで上書きされ、失われます。\n\n本当にGistへ上書き保存しますか？`;

              if (!confirm(confirmMsg)) {
                announce('保存をキャンセルしました。');
                setSyncState(false);
                return;
              }
            }
          }
        }
      } catch (e) {
        console.warn('Failed to verify Gist state for overwrite check:', e);
        if (!confirm('Gist上の最新データの確認に失敗しました（オフラインや権限不足の可能性があります）。\nこのままGistに上書き保存しますか？')) {
          announce('保存をキャンセルしました。');
          setSyncState(false);
          return;
        }
      }

      announce('Gistへの保存を開始します…');
      try {
        await pushToGist();
        updateGistUI();
        announce('Gistへの保存が完了しました。');
        showToast('Gistへの保存が完了しました。', 'success');
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
        showToast(friendlyMsg, 'error');
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
            
            // ローカルの最終更新時間も合わせる
            lastUpdatedAt = gistSettings.lastPulledAt;
            try {
              await storage.set(LAST_UPDATED_KEY, lastUpdatedAt);
            } catch (e) {}
            
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
            showToast('Gistからスニペットを同期しました。', 'success');
            alert('Gistからの読み込みが完了しました。');
          } catch (e) {
            snippets = originalSnippets;
            categories = originalCategories;
            showToast('同期に失敗しました（ローカル保存エラー）', 'error');
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
        showToast(friendlyMsg, 'error');
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
      await loadLastUpdatedAt();

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
        autoSyncGistOnLoad();
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
        autoSyncGistOnLoad();
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
        // 編集モード — DOM API でユーザーデータを安全に埋め込み
        const editForm = document.createElement('div');
        editForm.className = 'category-edit-form';
        editForm.style.cssText = 'width: 100%; border: none; padding: 0; background: transparent; margin: 0;';

        const formRow = document.createElement('div');
        formRow.className = 'category-form-row';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.id = `catEditName-${c.id}`;
        nameInput.value = c.label;
        nameInput.required = true;
        nameInput.maxLength = 30;
        nameInput.setAttribute('aria-label', 'カテゴリ名編集');
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'btn btn-primary';
        saveBtn.id = `catSaveBtn-${c.id}`;
        saveBtn.textContent = '保存';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-ghost';
        cancelBtn.id = `catCancelBtn-${c.id}`;
        cancelBtn.textContent = 'キャンセル';
        formRow.append(nameInput, saveBtn, cancelBtn);

        const colorSelector = document.createElement('div');
        colorSelector.className = 'category-color-selector';
        const colorLabel = document.createElement('span');
        colorLabel.className = 'color-selector-label';
        colorLabel.textContent = '色:';
        const colorsDiv = document.createElement('div');
        colorsDiv.id = `catEditColors-${c.id}`;
        colorsDiv.className = 'color-palette-radios';
        colorSelector.append(colorLabel, colorsDiv);

        const errorDiv = document.createElement('div');
        errorDiv.id = `catEditError-${c.id}`;
        errorDiv.className = 'field-hint danger-text';
        errorDiv.style.display = 'none';
        errorDiv.setAttribute('role', 'alert');

        editForm.append(formRow, colorSelector, errorDiv);
        item.appendChild(editForm);
        
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
        // 通常表示モード — DOM API でユーザーデータを安全に埋め込み
        const swatch = document.createElement('div');
        swatch.className = 'swatch';
        swatch.style.backgroundColor = c.color;
        swatch.setAttribute('aria-hidden', 'true');
        const labelSpan = document.createElement('span');
        labelSpan.className = 'label';
        labelSpan.textContent = c.label;
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'actions';
        if (!c.protected) {
          const editBtnEl = document.createElement('button');
          editBtnEl.type = 'button';
          editBtnEl.className = 'btn-cat edit-btn';
          editBtnEl.setAttribute('aria-label', `${c.label}を編集`);
          editBtnEl.textContent = '編集';
          const deleteBtnEl = document.createElement('button');
          deleteBtnEl.type = 'button';
          deleteBtnEl.className = 'btn-cat danger delete-btn';
          deleteBtnEl.setAttribute('aria-label', `${c.label}を削除`);
          deleteBtnEl.textContent = '削除';
          actionsDiv.append(editBtnEl, deleteBtnEl);
        }
        item.append(swatch, labelSpan, actionsDiv);

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
          deleteBtn.setAttribute('aria-label', `${s.title}を本当に削除しますか？もう一度押すと削除されます`);
          announce(`${s.title}の削除確認中。もう一度ボタンを押すと削除されます。`);
          deleteTimer = setTimeout(()=>{
            deleteBtn.textContent = '削除';
            deleteBtn.classList.remove('confirming');
            deleteBtn.setAttribute('aria-label', `${s.title}を削除`);
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
          
          const isGistConnected = !!(gistToken.trim() && gistSettings.gistId.trim());
          if (isGistConnected) {
            await autoPushToGist();
          } else {
            showToast('スニペットを削除しました', 'success');
          }
        } catch(e) {
          snippets = originalSnippets;
          statusEl.textContent = '削除に失敗しました';
          setTimeout(()=>{ statusEl.textContent = ''; }, 3000);
          announce('削除に失敗しました。');
          showToast('削除に失敗しました', 'error');
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
      
      const isGistConnected = !!(gistToken.trim() && gistSettings.gistId.trim());
      if (isGistConnected) {
        await autoPushToGist();
      } else {
        showToast('スニペットを保存しました', 'success');
      }
    } catch(e) {
      snippets = originalSnippets;
      statusEl.textContent = '保存に失敗しました';
      setTimeout(()=>{ statusEl.textContent = ''; }, 3000);
      announce('保存に失敗しました。');
      showToast('保存に失敗しました', 'error');
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
          await autoPushToGist();
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
