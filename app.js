(function(){
  const STORAGE_KEY = 'snippets:v1';
  const TAG_LABELS = { terminal:'Terminal', ai:'AI Agent', other:'Other' };

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

  async function load(){
    statusEl.textContent = '読み込み中…';
    try{
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

  load();
})();
