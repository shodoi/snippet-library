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

  // 読み込みデータの構造バリデーション
  function validateSnippets(data) {
    if (!Array.isArray(data)) return false;
    return data.every(item => 
      item &&
      typeof item.id === 'string' &&
      typeof item.title === 'string' &&
      typeof item.desc === 'string' &&
      typeof item.tag === 'string' &&
      typeof item.code === 'string'
    );
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

  // スクリーンリーダー向け動的通知
  function announce(message) {
    if (!srAnnouncer) return;
    srAnnouncer.textContent = '';
    setTimeout(() => {
      srAnnouncer.textContent = message;
    }, 100);
  }

  async function load(){
    statusEl.textContent = '読み込み中…';
    try{
      const res = await storage.get(STORAGE_KEY);
      const parsed = res && res.value ? JSON.parse(res.value) : null;
      if(parsed && validateSnippets(parsed)){
        snippets = parsed;
      }else{
        snippets = seed;
        await persist();
      }
    }catch(e){
      console.error('Failed to load snippets, falling back to seed:', e);
      snippets = seed;
      try{ await persist(); }catch(e2){ /* ignore */ }
    }
    statusEl.textContent = '';
    renderTagFilters();
    render();
  }

  async function persist(){
    try{
      const result = await storage.set(STORAGE_KEY, JSON.stringify(snippets));
      if(!result){ statusEl.textContent = '保存に失敗しました'; }
    }catch(e){
      console.error('Failed to persist snippets:', e);
      statusEl.textContent = '保存に失敗しました';
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
        try{
          await navigator.clipboard.writeText(s.code);
          copyBtn.textContent = 'コピーしました';
          copyBtn.classList.add('copied');
          announce(`${s.title}をクリップボードにコピーしました。`);
          setTimeout(()=>{
            copyBtn.textContent = 'コピー';
            copyBtn.classList.remove('copied');
          }, 1400);
        }catch(e){
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
        snippets = snippets.filter(x=>x.id!==s.id);
        await persist();
        render();
        announce(`${s.title}を削除しました。`);
        searchEl.focus();
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

    if(editingId){
      const idx = snippets.findIndex(x=>x.id===editingId);
      if(idx>-1) snippets[idx] = { ...snippets[idx], title, desc, tag, code };
      announce(`スニペット「${title}」を更新しました。`);
    }else{
      snippets.unshift({ id: generateUUID(), title, desc, tag, code });
      announce(`スニペット「${title}」を追加しました。`);
    }
    await persist();
    closeForm();
    render();
  });

  load();
})();
