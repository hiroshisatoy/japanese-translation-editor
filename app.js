'use strict';

(function startApp() {
  const SAMPLE_PO = [
    'msgid ""',
    'msgstr ""',
    '"Project-Id-Version: 見本カタログ\\n"',
    '"Language: ja\\n"',
    '"Plural-Forms: nplurals=1; plural=0;\\n"',
    '',
    '#. ボタンのラベル',
    '#: wp-admin/edit.php:120 wp-admin/post.php:40',
    'msgid "Save changes"',
    'msgstr "変更を保存"',
    '',
    '#: wp-admin/options.php:18',
    'msgctxt "settings screen"',
    'msgid "Settings"',
    'msgstr "設定"',
    '',
    '#, fuzzy',
    '#| msgid "Older title"',
    '#: wp-admin/about.php:12',
    'msgid "What\'s new"',
    'msgstr "新着情報"',
    '',
    '#. %s はサイト名',
    '#, php-format',
    '#: wp-login.php:88',
    'msgid "Log in to %s"',
    'msgstr ""',
    '',
    '#: wp-includes/comment.php:30',
    'msgid "One comment"',
    'msgid_plural "%s comments"',
    'msgstr[0] "%s 件のコメント"',
    '',
    '#. 複数行の説明',
    '#: wp-admin/setup.php:4',
    'msgid ""',
    '"Welcome to the editor.\\n"',
    '"Keep the placeholders."',
    'msgstr ""',
    '"エディタへようこそ。\\n"',
    '"プレースホルダはそのまま残します。"',
    '',
  ].join('\n');

  const STATUS_LABEL = {
    translated: '翻訳済み',
    fuzzy: '要確認',
    untranslated: '未翻訳',
    partial: '一部未訳',
  };
  const SCOPES = {
    original: 'original',
    msgid: 'original',
    '原文': 'original',
    translation: 'translation',
    msgstr: 'translation',
    '訳文': 'translation',
    context: 'context',
    '文脈': 'context',
    '変更': 'revised',
    revised: 'revised',
    ref: 'ref',
    file: 'ref',
    '参照': 'ref',
  };
  const OVERSCAN = 8;
  const MAX_FILE_BYTES = 120 * 1024 * 1024;

  const fileInput = document.getElementById('file');
  const finder = document.getElementById('finder');
  const queryInput = document.getElementById('q');
  const result = document.getElementById('result');
  const catalog = document.getElementById('catalog');
  const progress = document.getElementById('load-progress');
  const list = document.getElementById('list');
  const spacer = document.getElementById('spacer');
  const windowEl = document.getElementById('window');
  const empty = document.getElementById('empty');
  const nomatch = document.getElementById('nomatch');
  const colhead = document.getElementById('colhead');
  const veil = document.getElementById('veil');
  const sampleButton = document.getElementById('sample');
  const exportButton = document.getElementById('export');
  const openButton = document.getElementById('open-file');
  const closeButton = document.getElementById('close-file');
  const settingsButton = document.getElementById('settings');
  const countNodes = {
    all: document.getElementById('count-all'),
    untranslated: document.getElementById('count-untranslated'),
    fuzzy: document.getElementById('count-fuzzy'),
    translated: document.getElementById('count-translated'),
    changed: document.getElementById('count-changed'),
  };

  let entries = [];
  let loadedCatalogs = [];
  let buckets = {untranslated: [], fuzzy: [], translated: []};
  const edits = new Map();
  let catalogLoaded = false;
  let loadWarning = '';
  let obsoleteCount = 0;
  let showFile = false;
  let hits = [];
  let heights = new Float64Array(0);
  let prefix = new Float64Array(1);
  let drawnStart = -1;
  let drawnEnd = -1;
  let loadGeneration = 0;
  let searchGeneration = 0;
  let searchQueued = false;
  let previousQuery = '';
  let previousStatus = 'all';
  let previousHits = null;
  let previousDone = false;
  let activeTokens = [];
  let composing = false;
  let renderScheduled = false;
  let renderForce = false;
  const pool = [];
  let entryLocations = new WeakMap();
  let draftBaseline = null;
  let draftSaveFailed = false;
  let draftVersion = 0;
  let pendingDraftSaves = 0;
  let closingFile = false;
  let deletingDrafts = false;
  let currentStorageDeleted = false;
  let summaryGeneration = 0;
  let savedFilesGeneration = 0;
  let exportChangedOnly = false;
  let settingsReady = false;
  let settingsVersion = 0;

  function publishExportSettings(state = 'ready') {
    document.dispatchEvent(new CustomEvent('translation-export-settings', {
      detail: {exportChangedOnly, state},
    }));
    updateExportButton();
  }

  async function restoreExportSettings() {
    let state = 'ready';
    try {
      exportChangedOnly = (await DraftStore.readSettings()).exportChangedOnly;
    } catch {
      state = 'read-error';
    }
    settingsReady = true;
    publishExportSettings(state);
  }

  document.addEventListener('translation-change-export-settings', async (event) => {
    if (!settingsReady || deletingDrafts) return;
    exportChangedOnly = event.detail.exportChangedOnly === true;
    const version = ++settingsVersion;
    pendingDraftSaves++;
    publishExportSettings('saving');
    try {
      await DraftStore.saveSettings(exportChangedOnly);
      if (version === settingsVersion) publishExportSettings('saved');
    } catch {
      // The selected mode still applies to this page when persistence fails.
      if (version === settingsVersion) publishExportSettings('save-error');
    } finally {
      pendingDraftSaves--;
      document.dispatchEvent(new Event('translation-request-draft-info'));
    }
  });

  async function refreshSavedFiles() {
    if (catalogLoaded) return;
    const generation = ++savedFilesGeneration;
    const publish = (detail) => {
      if (generation === savedFilesGeneration) {
        document.dispatchEvent(new CustomEvent('translation-saved-files', {detail}));
      }
    };
    publish({state: 'loading', files: []});
    try {
      const files = await DraftStore.listSaved();
      files.sort((a, b) => a.filename.localeCompare(b.filename, 'ja') ||
        a.project.localeCompare(b.project, 'ja') || a.id.localeCompare(b.id));
      publish({state: 'ready', files});
    } catch {
      publish({state: 'error', files: []});
    }
  }

  document.addEventListener('translation-request-saved-files', refreshSavedFiles);
  document.addEventListener('translation-open-saved-file', async (event) => {
    const {id, complete} = event.detail;
    if (catalogLoaded || closingFile || deletingDrafts) {
      complete();
      return;
    }
    const generation = ++loadGeneration;
    searchGeneration++;
    let message = '';
    try {
      const {catalog, edits: revisions} = await DraftStore.readSaved(id);
      if (generation !== loadGeneration) return;
      if (!catalog || catalog.draftId !== id || !Array.isArray(catalog.entries) ||
          !catalog.headers || typeof catalog.filename !== 'string') {
        throw new Error('Saved file is missing or invalid');
      }
      document.dispatchEvent(new Event('translation-reset-controls'));
      progress.hidden = true;
      list.removeAttribute('aria-busy');
      list.scrollTop = 0;
      adoptCatalogs([catalog], [], [revisions]);
      draftBaseline = null;
      trackDraftSave(ensureDraftBaseline(), `下書き ${edits.size.toLocaleString('ja-JP')} 件を復元しました。`);
      queryInput.focus();
    } catch {
      if (generation === loadGeneration) {
        await refreshSavedFiles();
        message = '保存済みのファイルを開けませんでした。削除されていないか確認し、もう一度お試しください。';
      }
    } finally {
      complete(message);
    }
  });

  document.addEventListener('translation-request-draft-info', async () => {
    const generation = ++summaryGeneration;
    try {
      const summary = await DraftStore.getSummary(loadedCatalogs.map((catalog) => catalog.draftId));
      if (generation === summaryGeneration) {
        document.dispatchEvent(new CustomEvent('translation-draft-info', {detail: {summary}}));
      }
    } catch {
      if (generation === summaryGeneration) {
        document.dispatchEvent(new CustomEvent('translation-draft-info', {detail: {error: true}}));
      }
    }
  });

  function draftStatus(state, message, canClear = loadedCatalogs.length > 0) {
    document.dispatchEvent(new CustomEvent('translation-draft-status', {
      detail: {state, message, canClear},
    }));
  }

  function draftError() {
    draftSaveFailed = true;
    draftBaseline = null;
    draftStatus('error', '一時保存できません。変更を残すには PO を書き出してください。', true);
  }

  async function trackDraftSave(operation, message = 'このブラウザーに一時保存しました') {
    const version = ++draftVersion;
    pendingDraftSaves++;
    draftStatus('saving', 'このブラウザーに一時保存しています…');
    try {
      await operation;
      if (version === draftVersion) {
        draftSaveFailed = false;
        draftStatus('saved', message);
      }
    } catch {
      if (version === draftVersion) draftError();
    } finally {
      pendingDraftSaves--;
    }
  }

  function ensureDraftBaseline() {
    if (!draftBaseline) {
      const baseline = DraftStore.remember(loadedCatalogs);
      draftBaseline = baseline;
      baseline.catch(() => {
        if (draftBaseline === baseline) draftBaseline = null;
      });
    }
    return draftBaseline;
  }

  function saveDrafts() {
    // A small draft write succeeding is insufficient if the original file failed
    // to save. Every edit waits for both transactions before claiming success.
    currentStorageDeleted = false;
    const baseline = ensureDraftBaseline();
    const changes = DraftStore.save(loadedCatalogs, draftRevisions());
    trackDraftSave(Promise.all([baseline, changes]));
  }

  function draftRevisions() {
    const revisions = loadedCatalogs.map(() => []);
    for (const [entry, values] of edits) {
      const location = entryLocations.get(entry);
      if (location) revisions[location.catalog].push([location.index, values]);
    }
    return revisions;
  }

  async function closeFiles(force = false) {
    if (closingFile || deletingDrafts || !loadedCatalogs.length) return;
    closingFile = true;
    loadGeneration++;
    searchGeneration++;
    draftVersion++;
    list.inert = true;
    finder.inert = true;
    document.getElementById('wp-drafts').inert = true;
    fileInput.disabled = true;
    openButton.disabled = true;
    closeButton.disabled = true;
    settingsButton.disabled = true;
    exportButton.disabled = true;
    progress.hidden = true;
    list.removeAttribute('aria-busy');
    let warn = false;
    let sessionCleared = false;
    let saved = false;
    let didClose = false;
    try {
      if (!force && !(currentStorageDeleted && edits.size === 0)) {
        try {
          draftStatus('saving', '下書きを保存してファイルを閉じています…');
          const baseline = ensureDraftBaseline();
          const changes = DraftStore.save(loadedCatalogs, draftRevisions());
          await Promise.all([baseline, changes]);
          saved = true;
        } catch {
          if (edits.size) {
            draftError();
            warn = true;
            return;
          }
        }
      }
      try {
        await DraftStore.forgetSession();
        sessionCleared = true;
      } catch {
        // If the last-session marker cannot be cleared, closing is still safe
        // after saving (or after the user explicitly discards unsaved changes).
      }
      entries = [];
      loadedCatalogs = [];
      edits.clear();
      entryLocations = new WeakMap();
      buckets = {untranslated: [], fuzzy: [], translated: []};
      catalogLoaded = false;
      loadWarning = '';
      obsoleteCount = 0;
      showFile = false;
      hits = [];
      heights = new Float64Array(0);
      prefix = new Float64Array(1);
      drawnStart = -1;
      drawnEnd = -1;
      previousDone = false;
      previousHits = null;
      previousQuery = '';
      activeTokens = [];
      draftBaseline = null;
      currentStorageDeleted = false;
      draftSaveFailed = false;
      catalog.replaceChildren();
      catalog.hidden = true;
      windowEl.replaceChildren();
      spacer.hidden = true;
      colhead.hidden = true;
      nomatch.hidden = true;
      empty.hidden = false;
      list.scrollTop = 0;
      result.textContent = '';
      document.title = '翻訳ビューア';
      document.dispatchEvent(new Event('translation-reset-controls'));
      updateCounts();
      draftStatus(sessionCleared ? 'ready' : 'error', sessionCleared
        ? (saved ? 'ファイルを閉じました。下書きはこのブラウザーに残っています。' : 'ファイルを閉じました。')
        : 'ファイルを閉じました。一時保存を更新できなかったため、再読み込み時に以前のファイルが表示される場合があります。',
      sessionCleared && (saved || force));
      didClose = true;
    } finally {
      closingFile = false;
      list.inert = false;
      finder.inert = false;
      document.getElementById('wp-drafts').inert = false;
      fileInput.disabled = false;
      openButton.disabled = false;
      closeButton.disabled = loadedCatalogs.length === 0;
      settingsButton.disabled = false;
      updateExportButton();
      if (warn) document.dispatchEvent(new Event('translation-close-warning'));
      if (didClose) {
        document.getElementById('open-empty').focus();
        refreshSavedFiles();
      }
    }
  }

  closeButton.addEventListener('click', () => closeFiles());
  document.addEventListener('translation-force-close', () => closeFiles(true));

  document.addEventListener('translation-delete-drafts', async (event) => {
    const {scope, complete} = event.detail;
    if (deletingDrafts || closingFile) {
      complete(false);
      return;
    }
    deletingDrafts = true;
    pendingDraftSaves++;
    const changesCurrent = scope !== 'other' && scope !== 'settings';
    if (changesCurrent) draftVersion++;
    const ids = loadedCatalogs.map((catalog) => catalog.draftId);
    try {
      await DraftStore.remove(scope, ids);
      if (scope === 'settings' || scope === 'all') {
        settingsVersion++;
        exportChangedOnly = false;
        publishExportSettings();
      }
      if (changesCurrent) {
        edits.clear();
        updateChangedCount();
        previousDone = false;
        scheduleSearch();
        draftSaveFailed = false;
        if (scope === 'current' || scope === 'all') {
          draftBaseline = null;
          currentStorageDeleted = loadedCatalogs.length > 0;
        }
      }
      if (draftSaveFailed) {
        draftError();
      } else {
        draftStatus('saved', '選択した一時保存を削除しました。', true);
      }
      complete(true);
      refreshSavedFiles();
    } catch {
      if (scope !== 'settings') {
        if (edits.size) draftSaveFailed = true;
        draftStatus('error', '一時保存を削除できませんでした。変更を残すには PO を書き出してください。', true);
      }
      complete(false);
    } finally {
      pendingDraftSaves--;
      deletingDrafts = false;
    }
  });

  // Warn only while a save is still pending or has failed with unsaved edits.
  window.addEventListener('beforeunload', (event) => {
    if (pendingDraftSaves || (draftSaveFailed && edits.size)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  /**
   * @return {Promise<void>}
   */
  function yieldToMain() {
    const schedulerApi = globalThis.scheduler;
    if (schedulerApi && typeof schedulerApi.yield === 'function') {
      return schedulerApi.yield();
    }
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  /**
   * @param {string} tag
   * @param {string} className
   * @param {Node} parent
   * @return {HTMLElement}
   */
  function el(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    parent.append(node);
    return node;
  }

  /**
   * @return {HTMLElement}
   */
  function createRow() {
    const root = document.createElement('article');
    root.className = 'row';
    root.setAttribute('role', 'listitem');
    const top = el('div', 'row-top', root);
    const file = el('p', 'file', top);
    const context = el('p', 'context', top);
    const flags = el('p', 'flags', top);
    const status = el('p', 'status', top);
    const pair = el('div', 'pair', root);
    const source = el('div', 'source', pair);
    const sourceLabel = el('p', 'col-label', source);
    sourceLabel.textContent = '原文';
    const sourceBody = el('div', 'body', source);
    const target = el('div', 'target', pair);
    const targetLabel = el('p', 'col-label', target);
    targetLabel.textContent = '訳文';
    const targetBody = el('div', 'body', target);
    const revised = el('div', 'revised-col', pair);
    const revisedBody = el('div', 'body', revised);
    const changed = el('p', 'changed', top);
    changed.textContent = '変更あり';
    changed.hidden = true;
    const note = el('p', 'note', root);
    const refs = el('p', 'refs', root);
    const more = el('details', 'refs-more', root);
    const summary = el('summary', '', more);
    const refsBody = el('p', 'refs', more);
    root._ui = {
      file, context, flags, status, changed, sourceBody, targetBody, revisedBody,
      note, refs, more, summary, refsBody,
    };
    return root;
  }

  /**
   * @param {string} raw
   * @return {{scope: string, text: string}[]}
   */
  function parseQuery(raw) {
    const parts = [];
    let index = 0;
    while (index < raw.length) {
      while (index < raw.length && /\s/.test(raw[index])) {
        index++;
      }
      if (index >= raw.length) {
        break;
      }
      if (raw[index] === '"') {
        const end = raw.indexOf('"', index + 1);
        if (end === -1) {
          parts.push(raw.slice(index + 1));
          break;
        }
        parts.push(raw.slice(index + 1, end));
        index = end + 1;
        continue;
      }
      let end = index;
      while (end < raw.length && !/\s/.test(raw[end])) {
        end++;
      }
      parts.push(raw.slice(index, end));
      index = end;
    }

    const tokens = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const colon = part.includes(':') ? ':' : (part.includes('：') ? '：' : '');
      if (colon) {
        const at = part.indexOf(colon);
        const scope = SCOPES[part.slice(0, at)] || SCOPES[part.slice(0, at).toLowerCase()];
        if (scope) {
          let text = part.slice(at + 1);
          if (!text && parts[i + 1]) {
            text = parts[++i];
          }
          if (text) {
            tokens.push({scope, text: text.toLowerCase()});
          }
          continue;
        }
      }
      if (part) {
        tokens.push({scope: 'all', text: part.toLowerCase()});
      }
    }
    return tokens;
  }

  /**
   * @param {Object} entry
   * @param {{scope: string, text: string}} token
   * @return {boolean}
   */
  function entryHas(entry, token) {
    if (token.scope === 'revised') {
      return revisedHas(entry, token.text);
    }
    const blob = entry.blob;
    const cuts = entry.cuts;
    let start = 0;
    let end = blob.length;
    if (token.scope === 'original') {
      end = cuts[0];
    } else if (token.scope === 'translation') {
      start = cuts[0] + 1;
      end = cuts[1];
    } else if (token.scope === 'context') {
      start = cuts[1] + 1;
      end = cuts[2];
    } else if (token.scope === 'ref') {
      start = cuts[2] + 1;
    }
    let blobHit = false;
    if (end - start >= token.text.length) {
      const at = blob.indexOf(token.text, start);
      blobHit = at !== -1 && at <= end - token.text.length;
    }
    if (blobHit) {
      return true;
    }
    if (token.scope === 'all' || token.scope === 'translation') {
      return revisedHas(entry, token.text);
    }
    return false;
  }

  /**
   * @param {Object} entry
   * @param {string} needle
   * @return {boolean}
   */
  function revisedHas(entry, needle) {
    const stored = edits.get(entry);
    if (!stored) {
      return false;
    }
    for (let i = 0; i < stored.length; i++) {
      if (stored[i].toLowerCase().includes(needle)) {
        return true;
      }
    }
    return false;
  }

  /**
   * @param {Object} entry
   * @return {boolean}
   */
  function entryChanged(entry) {
    const stored = edits.get(entry);
    if (!stored) {
      return false;
    }
    const slots = Math.max(entry.slots, entry.msgstr.length, stored.length, 1);
    for (let i = 0; i < slots; i++) {
      if ((stored[i] || '') !== (entry.msgstr[i] || '')) {
        return true;
      }
    }
    return false;
  }

  /**
   * @return {number[]}
   */
  function changedIndices() {
    const indices = [];
    for (let i = 0; i < entries.length; i++) {
      if (entryChanged(entries[i])) {
        indices.push(i);
      }
    }
    return indices;
  }

  /**
   * @param {ParentNode} parent
   * @param {string} text
   * @param {string} scope
   */
  function appendHighlighted(parent, text, scope) {
    const tokens = [];
    for (let i = 0; i < activeTokens.length; i++) {
      const token = activeTokens[i];
      if (token.scope === 'all' || token.scope === scope) {
        tokens.push(token.text);
      }
    }
    if (!tokens.length || !text) {
      parent.append(document.createTextNode(text));
      return;
    }
    const lower = text.toLowerCase();
    if (lower.length !== text.length) {
      parent.append(document.createTextNode(text));
      return;
    }
    let cursor = 0;
    while (cursor < text.length) {
      let bestAt = -1;
      let bestLength = 0;
      for (let i = 0; i < tokens.length; i++) {
        const at = lower.indexOf(tokens[i], cursor);
        if (at !== -1 && (bestAt === -1 || at < bestAt)) {
          bestAt = at;
          bestLength = tokens[i].length;
        }
      }
      if (bestAt === -1) {
        parent.append(document.createTextNode(text.slice(cursor)));
        return;
      }
      if (bestAt > cursor) {
        parent.append(document.createTextNode(text.slice(cursor, bestAt)));
      }
      const mark = document.createElement('mark');
      mark.textContent = text.slice(bestAt, bestAt + bestLength);
      parent.append(mark);
      cursor = bestAt + Math.max(bestLength, 1);
    }
  }

  /**
   * @param {ParentNode} parent
   * @param {string} label
   * @param {string} text
   * @param {string} scope
   * @param {string} className
   */
  function appendBlock(parent, label, text, scope, className) {
    const paragraph = document.createElement('p');
    paragraph.className = className;
    if (label) {
      const mini = document.createElement('span');
      mini.className = 'mini';
      mini.textContent = label;
      paragraph.append(mini);
    }
    appendHighlighted(paragraph, text, scope);
    parent.append(paragraph);
  }

  /**
   * @param {HTMLElement} root
   * @param {number} hitIndex
   */
  /**
   * @param {HTMLElement} root
   * @param {Object} entry
   * @param {number} slots
   * @param {boolean} sameEntry
   * @return {boolean}
   */
  function syncRevised(root, entry, slots, sameEntry) {
    const ui = root._ui;
    const stored = edits.get(entry);
    const body = ui.revisedBody;
    while (body.childElementCount > slots) {
      body.lastElementChild.remove();
    }
    while (body.childElementCount < slots) {
      const field = document.createElement('label');
      field.className = 'revised-field';
      const caption = document.createElement('span');
      caption.className = 'col-label';
      const plural = document.createElement('span');
      plural.className = 'mini';
      const area = document.createElement('textarea');
      area.className = 'revised';
      area.rows = 2;
      area.spellcheck = false;
      area.addEventListener('input', onRevise);
      field.append(caption, plural, area);
      body.append(field);
    }
    let changed = false;
    for (let i = 0; i < slots; i++) {
      const field = body.children[i];
      const area = field.querySelector('textarea');
      const imported = entry.msgstr[i] || '';
      const value = stored && stored[i] !== undefined ? stored[i] : imported;
      const slotChanged = value !== imported;
      if (slotChanged) {
        changed = true;
      }
      field.querySelector('.col-label').textContent = slots > 1 ? `変更後の文 ${i + 1}` : '変更後の文';
      const plural = field.querySelector('.mini');
      plural.hidden = slots === 1;
      plural.textContent = `訳文 ${i + 1}`;
      area.dataset.slot = String(i);
      area.dataset.changed = slotChanged ? '1' : '0';
      if (!(sameEntry && document.activeElement === area) && area.value !== value) {
        area.value = value;
      }
    }
    return changed;
  }

  function onRevise(event) {
    const area = event.target;
    const row = area.closest('.row');
    const entry = entries[Number(row.dataset.entry)];
    if (!entry) {
      return;
    }
    const slots = Math.max(entry.slots, entry.msgstr.length, 1);
    let stored = edits.get(entry);
    if (!stored) {
      stored = [];
      for (let i = 0; i < slots; i++) {
        stored.push(entry.msgstr[i] || '');
      }
      edits.set(entry, stored);
    }
    const slot = Number(area.dataset.slot);
    stored[slot] = area.value;
    const slotChanged = area.value !== (entry.msgstr[slot] || '');
    area.dataset.changed = slotChanged ? '1' : '0';
    if (!entryChanged(entry)) {
      edits.delete(entry);
    }
    const changed = edits.has(entry);
    row.dataset.changed = changed ? '1' : '0';
    row._ui.changed.hidden = !changed;
    updateChangedCount();
    saveDrafts();
    const hitIndex = Number(row.dataset.hit);
    requestAnimationFrame(() => {
      if (!row.isConnected || hitIndex >= heights.length) {
        return;
      }
      const height = row.offsetHeight;
      if (!(height > 0) || Math.abs(heights[hitIndex] - height) <= 1) {
        return;
      }
      heights[hitIndex] = height;
      for (let i = hitIndex; i < heights.length; i++) {
        prefix[i + 1] = prefix[i] + heights[i];
      }
      spacer.style.height = `${prefix[heights.length]}px`;
    });
  }

  function fillRow(root, hitIndex) {
    const entryIndex = hits[hitIndex];
    const entry = entries[entryIndex];
    const sameEntry = root.dataset.entry === String(entryIndex);
    const ui = root._ui;
    root.dataset.entry = String(entryIndex);
    root.dataset.hit = String(hitIndex);
    root.dataset.status = entry.status;
    root.setAttribute('aria-posinset', String(hitIndex + 1));
    root.setAttribute('aria-setsize', String(hits.length));
    ui.file.hidden = !showFile;
    ui.file.textContent = entry.file;
    ui.context.hidden = !entry.context;
    ui.context.textContent = entry.context ? `文脈 ${entry.context}` : '';
    const flags = [];
    for (let i = 0; i < entry.flags.length; i++) {
      if (entry.flags[i] !== 'fuzzy') {
        flags.push(entry.flags[i]);
      }
    }
    ui.flags.hidden = flags.length === 0;
    ui.flags.textContent = flags.join(' ');
    ui.status.textContent = STATUS_LABEL[entry.status] || entry.status;

    ui.sourceBody.replaceChildren();
    appendBlock(ui.sourceBody, '', entry.msgid, 'original', 'text');
    if (entry.msgidPlural) {
      appendBlock(ui.sourceBody, '複数形', entry.msgidPlural, 'original', 'extra');
    }
    if (entry.previous && entry.previous !== entry.msgid) {
      appendBlock(ui.sourceBody, '以前の原文', entry.previous, 'original', 'extra');
    }

    ui.targetBody.replaceChildren();
    const slots = Math.max(entry.slots, entry.msgstr.length, 1);
    for (let i = 0; i < slots; i++) {
      const text = entry.msgstr[i] || '';
      const label = slots > 1 ? `訳文 ${i + 1}` : '';
      if (!text) {
        const paragraph = document.createElement('p');
        paragraph.className = 'missing';
        paragraph.textContent = slots > 1 ? `訳文 ${i + 1} がありません` : '訳文がありません';
        ui.targetBody.append(paragraph);
      } else {
        appendBlock(ui.targetBody, label, text, 'translation', i === 0 ? 'text' : 'extra');
      }
    }

    const changed = syncRevised(root, entry, slots, sameEntry);
    root.dataset.changed = changed ? '1' : '0';
    ui.changed.hidden = !changed;

    const notes = [];
    if (entry.extracted) {
      notes.push(entry.extracted);
    }
    if (entry.translator) {
      notes.push(entry.translator);
    }
    ui.note.hidden = notes.length === 0;
    ui.note.textContent = notes.join('\n');

    const manyRefs = entry.references.length > 3;
    ui.refs.hidden = manyRefs || entry.references.length === 0;
    ui.refs.textContent = manyRefs ? '' : entry.references.join('  ');
    ui.more.hidden = !manyRefs;
    ui.more.open = false;
    if (manyRefs) {
      ui.summary.textContent = `参照 ${entry.references.length} 件`;
      ui.refsBody.textContent = entry.references.join('\n');
    }
  }

  /**
   * @param {Object} entry
   * @return {number}
   */
  function estimate(entry) {
    let right = 0;
    for (let i = 0; i < entry.msgstr.length; i++) {
      right += entry.msgstr[i].length;
    }
    const chars = Math.max(entry.msgid.length + entry.msgidPlural.length + entry.previous.length, right, 8);
    const lines = Math.ceil(chars / 22);
    const chrome = 52 + (entry.references.length > 3 ? 28 : entry.references.length ? 22 : 0) + (entry.extracted || entry.translator ? 24 : 0);
    return Math.min(12000, chrome + lines * 25);
  }

  function rebuildMetrics() {
    const count = hits.length;
    heights = new Float64Array(count);
    prefix = new Float64Array(count + 1);
    for (let i = 0; i < count; i++) {
      heights[i] = estimate(entries[hits[i]]);
      prefix[i + 1] = prefix[i] + heights[i];
    }
    spacer.style.height = `${prefix[count]}px`;
  }

  /**
   * @param {number} y
   * @return {number}
   */
  function findIndex(y) {
    let lo = 0;
    let hi = hits.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (prefix[mid + 1] <= y) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  function draw(force) {
    const hasHits = hits.length > 0;
    empty.hidden = catalogLoaded;
    nomatch.hidden = !(catalogLoaded && entries.length > 0 && !hasHits);
    spacer.hidden = !hasHits;
    colhead.hidden = !hasHits;
    if (!hasHits) {
      windowEl.replaceChildren();
      drawnStart = -1;
      drawnEnd = -1;
      return;
    }

    const scrollTop = list.scrollTop;
    const limit = scrollTop + list.clientHeight + 480;
    let start = Math.max(0, findIndex(scrollTop) - OVERSCAN);
    let end = start + 1;
    while (end < hits.length && prefix[end] < limit) {
      end++;
    }
    end = Math.min(hits.length, end + OVERSCAN);
    if (end - start > 80) {
      end = start + 80;
    }
    if (!force && start === drawnStart && end === drawnEnd) {
      return;
    }
    drawnStart = start;
    drawnEnd = end;

    const need = end - start;
    while (windowEl.childElementCount > need) {
      const extra = windowEl.lastElementChild;
      extra.remove();
      if (pool.length < 90) {
        pool.push(extra);
      }
    }
    while (windowEl.childElementCount < need) {
      windowEl.append(pool.pop() || createRow());
    }
    for (let i = 0; i < need; i++) {
      fillRow(windowEl.children[i], start + i);
    }
    windowEl.style.transform = `translateY(${prefix[start]}px)`;

    const measured = [];
    for (let i = 0; i < need; i++) {
      measured.push(windowEl.children[i].offsetHeight);
    }
    let minChanged = hits.length;
    let changed = false;
    for (let i = 0; i < need; i++) {
      const height = measured[i];
      const index = start + i;
      if (height > 0 && Math.abs(height - heights[index]) > 1) {
        heights[index] = height;
        changed = true;
        if (index < minChanged) {
          minChanged = index;
        }
      }
    }
    if (!changed) {
      return;
    }
    const previousTop = prefix[start];
    for (let i = minChanged; i < heights.length; i++) {
      prefix[i + 1] = prefix[i] + heights[i];
    }
    spacer.style.height = `${prefix[heights.length]}px`;
    windowEl.style.transform = `translateY(${prefix[start]}px)`;
    const delta = prefix[start] - previousTop;
    if (delta !== 0) {
      list.scrollTop += delta;
    }
    if (end < hits.length && prefix[end] < list.scrollTop + list.clientHeight + 240) {
      scheduleRender(true);
    }
  }

  function scheduleRender(force) {
    if (force) {
      renderForce = true;
    }
    if (renderScheduled) {
      return;
    }
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      const forceNow = renderForce;
      renderForce = false;
      draw(forceNow);
    });
  }

  function selectedStatus() {
    const checked = finder.querySelector('[role="radio"][aria-checked="true"]');
    return checked ? checked.dataset.status : 'all';
  }

  function updateCounts() {
    const counts = {
      all: entries.length,
      untranslated: buckets.untranslated.length,
      fuzzy: buckets.fuzzy.length,
      translated: buckets.translated.length,
      changed: edits.size,
    };
    const keys = Object.keys(counts);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      countNodes[key].textContent = entries.length ? counts[key].toLocaleString('ja-JP') : '';
    }
    updateExportButton();
    closeButton.disabled = loadedCatalogs.length === 0 || closingFile;
  }

  function updateChangedCount() {
    countNodes.changed.textContent = entries.length ? edits.size.toLocaleString('ja-JP') : '';
    updateExportButton();
  }

  function updateExportButton() {
    exportButton.disabled = !settingsReady || closingFile || entries.length === 0 ||
      (exportChangedOnly && edits.size === 0);
    exportButton.title = exportChangedOnly
      ? (edits.size ? `変更した ${edits.size.toLocaleString('ja-JP')} 件だけを書き出します` : '書き出す変更がありません')
      : 'すべての翻訳項目を書き出します';
  }

  /**
   * @param {number} visible
   * @param {number} obsolete
   */
  function announce(visible) {
    if (!entries.length) {
      result.textContent = loadWarning || (catalogLoaded ? '翻訳文字列がありませんでした。' : '');
      return;
    }
    const total = entries.length.toLocaleString('ja-JP');
    const shown = visible.toLocaleString('ja-JP');
    let text = visible === entries.length ? `${total} 件` : `${shown} 件 / ${total} 件`;
    if (obsoleteCount) {
      text += `（廃止 ${obsoleteCount.toLocaleString('ja-JP')} 件は非表示）`;
    }
    if (loadWarning) {
      text += ` ${loadWarning}`;
    }
    result.textContent = text;
  }

  async function runSearch() {
    const generation = ++searchGeneration;
    const query = queryInput.value;
    const status = selectedStatus();
    const tokens = parseQuery(query);
    activeTokens = tokens;
    const narrow = previousDone && status === previousStatus && previousQuery !== '' && query.startsWith(previousQuery);
    let source = null;
    if (narrow) {
      source = previousHits;
    } else if (status === 'changed') {
      source = changedIndices();
    } else if (status !== 'all') {
      source = buckets[status];
    }
    const total = source ? source.length : entries.length;
    const nextHits = [];
    let started = performance.now();
    for (let i = 0; i < total; i++) {
      const index = source ? source[i] : i;
      let matched = true;
      for (let t = 0; t < tokens.length; t++) {
        if (!entryHas(entries[index], tokens[t])) {
          matched = false;
          break;
        }
      }
      if (matched) {
        nextHits.push(index);
      }
      if (total > 10000 && (i & 8191) === 8191 && performance.now() - started > 12) {
        await yieldToMain();
        if (generation !== searchGeneration) {
          return;
        }
        started = performance.now();
      }
    }
    if (generation !== searchGeneration) {
      return;
    }
    previousQuery = query;
    previousStatus = status;
    previousHits = nextHits;
    previousDone = true;
    hits = nextHits;
    drawnStart = -1;
    drawnEnd = -1;
    rebuildMetrics();
    list.scrollTop = 0;
    announce(hits.length);
    scheduleRender(true);
  }

  function scheduleSearch() {
    if (searchQueued) {
      return;
    }
    searchQueued = true;
    requestAnimationFrame(() => {
      searchQueued = false;
      runSearch();
    });
  }

  /**
   * @param {Object[]} catalogs
   * @param {string[]} skipped
   */
  function adoptCatalogs(catalogs, skipped, drafts = []) {
    // A queued virtual-list redraw must not use indexes from the previous file.
    hits = [];
    heights = new Float64Array(0);
    prefix = new Float64Array(1);
    drawnStart = -1;
    drawnEnd = -1;
    entries = [];
    loadedCatalogs = catalogs;
    currentStorageDeleted = false;
    edits.clear();
    entryLocations = new WeakMap();
    buckets = {untranslated: [], fuzzy: [], translated: []};
    let obsolete = 0;
    const names = [];
    for (let c = 0; c < catalogs.length; c++) {
      const catalog = catalogs[c];
      names.push(catalog.filename);
      obsolete += catalog.obsolete;
      const listEntries = catalog.entries;
      for (let i = 0; i < listEntries.length; i++) {
        const entry = listEntries[i];
        entryLocations.set(entry, {catalog: c, index: i});
        const index = entries.length;
        entries.push(entry);
        if (entry.status === 'fuzzy') {
          buckets.fuzzy.push(index);
        } else if (entry.status === 'translated') {
          buckets.translated.push(index);
        } else {
          buckets.untranslated.push(index);
        }
      }
      const restored = drafts[c];
      if (Array.isArray(restored)) {
        for (const revision of restored) {
          if (!Array.isArray(revision) || revision.length !== 2) continue;
          const [index, values] = revision;
          const entry = listEntries[index];
          if (!Number.isInteger(index) || !entry || !Array.isArray(values) ||
              values.length !== Math.max(entry.slots, entry.msgstr.length, 1) ||
              !values.every((value) => typeof value === 'string')) continue;
          if (values.some((value, slot) => value !== (entry.msgstr[slot] || ''))) {
            edits.set(entry, values.slice());
          }
        }
      }
    }
    showFile = names.length > 1;
    catalogLoaded = true;
    obsoleteCount = obsolete;
    catalog.replaceChildren();
    catalog.hidden = names.length === 0;
    catalog.scrollLeft = 0;
    if (names.length === 1) {
      const headers = catalogs[0].headers;
      const bits = [names[0]];
      if (headers['Project-Id-Version']) {
        bits.push(headers['Project-Id-Version']);
      }
      if (headers['Language']) {
        bits.push(headers['Language']);
      }
      for (let i = 0; i < bits.length; i++) {
        const span = document.createElement('span');
        span.textContent = bits[i];
        catalog.append(span);
      }
      document.title = `翻訳ビューア — ${names[0]}`;
    } else if (names.length > 1) {
      const span = document.createElement('span');
      span.textContent = `${names.length} ファイル`;
      catalog.append(span);
      document.title = `翻訳ビューア — ${names.length} ファイル`;
    } else {
      document.title = '翻訳ビューア';
    }
    updateCounts();
    previousDone = false;
    previousQuery = '';
    loadWarning = skipped.length ? `読めなかったファイル: ${skipped.join('、')}` : '';
    scheduleSearch();
  }

  /**
   * @param {File} file
   * @return {Promise<string>}
   */
  async function readText(file) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let encoding = 'utf-8';
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      encoding = 'utf-16le';
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      encoding = 'utf-16be';
    }
    return new TextDecoder(encoding).decode(bytes);
  }

  /**
   * @param {File[]} files
   */
  async function loadFiles(files) {
    if (closingFile || deletingDrafts) return;
    const generation = ++loadGeneration;
    searchGeneration++;
    const poFiles = [];
    const skipped = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!/\.pot?$/i.test(file.name)) {
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        skipped.push(`${file.name}（120MB超）`);
        continue;
      }
      poFiles.push(file);
    }
    poFiles.sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, 'ja'));
    if (!poFiles.length) {
      result.textContent = skipped.length ? `読めなかったファイル: ${skipped.join('、')}` : 'PO ファイルがありません。';
      progress.hidden = true;
      return;
    }

    progress.hidden = false;
    draftVersion++;
    draftStatus('loading', 'ファイルと一時保存した下書きを読み込んでいます…');
    progress.removeAttribute('value');
    list.setAttribute('aria-busy', 'true');
    result.textContent = '読み込んでいます';
    const catalogs = [];
    for (let i = 0; i < poFiles.length; i++) {
      if (generation !== loadGeneration) {
        return;
      }
      const file = poFiles[i];
      try {
        const text = await readText(file);
        if (generation !== loadGeneration) {
          return;
        }
        const parsed = await PoParser.parsePo(text, file.name, {
          isCancelled: () => generation !== loadGeneration,
          onProgress: (ratio) => {
            progress.value = (i + ratio) / poFiles.length;
          },
        });
        if (!parsed || generation !== loadGeneration) {
          return;
        }
        const recognizable = parsed.entries.length > 0 || parsed.headers['Project-Id-Version'] || text.includes('msgid');
        if (!recognizable) {
          skipped.push(file.name);
        } else {
          try {
            parsed.draftId = await DraftStore.identify(file.webkitRelativePath || file.name, text);
          } catch {
            // Storage must never prevent a PO file from being opened or exported.
            parsed.draftId = null;
          }
          catalogs.push(parsed);
        }
      } catch {
        skipped.push(file.name);
      }
    }
    if (generation !== loadGeneration) {
      return;
    }
    progress.hidden = true;
    list.removeAttribute('aria-busy');
    if (!catalogs.length) {
      result.textContent = 'PO として読めた文字列がありませんでした。';
      draftStatus('error', 'ファイルを読み込めませんでした。前の一時保存は残っています。');
      return;
    }
    let drafts = [];
    try {
      drafts = await DraftStore.readDrafts(catalogs);
    } catch {
      // Continue with imported translations if browser storage is unavailable.
    }
    if (generation !== loadGeneration) return;
    adoptCatalogs(catalogs, skipped, drafts);
    draftBaseline = null;
    const count = edits.size;
    trackDraftSave(ensureDraftBaseline(), count
      ? `下書き ${count.toLocaleString('ja-JP')} 件を復元しました。このブラウザーに一時保存済みです。`
      : 'このブラウザーに自動保存します。ファイルと下書きは外部へ送信しません。');
  }

  /**
   * @param {DataTransferItem} item
   * @return {Promise<File[]>}
   */
  async function filesFromEntry(entry) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => {
        entry.file(resolve, reject);
      });
      return [file];
    }
    if (!entry.isDirectory) {
      return [];
    }
    const reader = entry.createReader();
    const children = [];
    let batch = [];
    do {
      batch = await new Promise((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      for (let i = 0; i < batch.length; i++) {
        children.push(batch[i]);
      }
    } while (batch.length);
    const files = [];
    for (let i = 0; i < children.length; i++) {
      const nested = await filesFromEntry(children[i]);
      for (let j = 0; j < nested.length; j++) {
        files.push(nested[j]);
      }
    }
    return files;
  }

  /**
   * @param {DataTransfer} dataTransfer
   * @return {Promise<File[]>}
   */
  async function filesFromTransfer(dataTransfer) {
    const items = dataTransfer.items ? [...dataTransfer.items] : [];
    const entries = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
      if (entry) {
        entries.push(entry);
      }
    }
    if (!entries.length) {
      return [...dataTransfer.files];
    }
    const files = [];
    for (let i = 0; i < entries.length; i++) {
      const nested = await filesFromEntry(entries[i]);
      for (let j = 0; j < nested.length; j++) {
        files.push(nested[j]);
      }
    }
    return files;
  }

  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    loadFiles(files);
  });

  /**
   * プロジェクト内の test/sample.po を一覧に出す。
   * file:// で開いて取得できないときは、同内容の見本文字列に戻す。
   * @return {Promise<void>}
   */
  async function loadSample() {
    // A deliberate sample selection takes precedence over pending restoration.
    const generation = ++loadGeneration;
    searchGeneration++;
    let text = '';
    let filename = 'sample.po';
    try {
      const response = await fetch('test/sample.po');
      if (!response.ok) {
        throw new Error(String(response.status));
      }
      text = await response.text();
    } catch {
      text = SAMPLE_PO;
      filename = '見本.po';
    }
    if (generation !== loadGeneration) {
      return;
    }
    loadFiles([new File([text], filename, {type: 'text/plain'})]);
  }

  sampleButton.addEventListener('click', () => {
    loadSample();
  });

  function exportTimestamp(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
      `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  exportButton.addEventListener('click', () => {
    if (exportButton.disabled) return;
    const timestamp = exportTimestamp(new Date());
    const status = selectedStatus();
    const filter = exportChangedOnly ? 'changed' : status === 'all' ? 'All' : status;
    for (let i = 0; i < loadedCatalogs.length; i++) {
      const catalog = loadedCatalogs[i];
      if (exportChangedOnly && !catalog.entries.some((entry) => edits.has(entry))) continue;
      const blob = new Blob([serializeCatalog(catalog, exportChangedOnly)], {type: 'text/plain;charset=utf-8'});
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const basename = (catalog.filename || 'translations').replace(/\.pot?$/i, '') || 'translations';
      link.download = `${timestamp}_${basename}_${filter}.po`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }
  });

  /**
   * @param {string} value
   * @return {string}
   */
  function poQuoted(value) {
    return `"${value
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('\r', '\\r')
      .replaceAll('\n', '\\n')
      .replaceAll('\t', '\\t')}"`;
  }

  /**
   * @param {string[]} lines
   * @param {string} prefix
   * @param {string} text
   */
  function writePrefixed(lines, prefix, text) {
    if (!text) {
      return;
    }
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      lines.push(`${prefix}${parts[i]}`);
    }
  }

  /**
   * @param {string[]} lines
   * @param {Object} entry
   */
  function writePoEntry(lines, entry) {
    writePrefixed(lines, '# ', entry.translator);
    writePrefixed(lines, '#. ', entry.extracted);
    if (entry.references.length) {
      lines.push(`#: ${entry.references.join(' ')}`);
    }
    const flags = [];
    for (let i = 0; i < entry.flags.length; i++) {
      if (entry.flags[i] === 'fuzzy' && entryChanged(entry)) {
        continue;
      }
      flags.push(entry.flags[i]);
    }
    if (flags.length) {
      lines.push(`#, ${flags.join(', ')}`);
    }
    if (entry.previous) {
      lines.push(`#| msgid ${poQuoted(entry.previous)}`);
    }
    if (entry.context) {
      lines.push(`msgctxt ${poQuoted(entry.context)}`);
    }
    lines.push(`msgid ${poQuoted(entry.msgid)}`);
    const stored = edits.get(entry);
    const slots = Math.max(entry.slots, entry.msgstr.length, stored ? stored.length : 0, 1);
    if (entry.msgidPlural) {
      lines.push(`msgid_plural ${poQuoted(entry.msgidPlural)}`);
      for (let i = 0; i < slots; i++) {
        const value = stored && stored[i] !== undefined ? stored[i] : (entry.msgstr[i] || '');
        lines.push(`msgstr[${i}] ${poQuoted(value)}`);
      }
      return;
    }
    const value = stored && stored[0] !== undefined ? stored[0] : (entry.msgstr[0] || '');
    lines.push(`msgstr ${poQuoted(value)}`);
  }

  /**
   * @param {Object} catalog
   * @param {boolean} changedOnly
   * @return {string}
   */
  function serializeCatalog(catalog, changedOnly = false) {
    const lines = ['msgid ""', 'msgstr ""'];
    const headers = catalog.headers || {};
    const keys = Object.keys(headers);
    if (!keys.length) {
      lines.push(poQuoted('Content-Type: text/plain; charset=UTF-8\n'));
    } else {
      for (let i = 0; i < keys.length; i++) {
        lines.push(poQuoted(`${keys[i]}: ${headers[keys[i]]}\n`));
      }
    }
    lines.push('');
    for (let i = 0; i < catalog.entries.length; i++) {
      if (changedOnly && !edits.has(catalog.entries[i])) continue;
      writePoEntry(lines, catalog.entries[i]);
      lines.push('');
    }
    return `${lines.join('\n')}\n`;
  }

  document.addEventListener('translation-search', () => {
    if (!composing) scheduleSearch();
  });

  finder.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch();
  });

  queryInput.addEventListener('compositionstart', () => {
    composing = true;
  });
  queryInput.addEventListener('compositionend', () => {
    composing = false;
    scheduleSearch();
  });
  queryInput.addEventListener('input', () => {
    if (!composing) {
      scheduleSearch();
    }
  });
  finder.addEventListener('change', (event) => {
    if (event.target && event.target.name === 'status') {
      scheduleSearch();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) {
      return;
    }
    event.preventDefault();
    queryInput.focus();
  });

  list.addEventListener('scroll', () => {
    scheduleRender(false);
  }, {passive: true});

  let dragTimer = 0;
  document.addEventListener('dragover', (event) => {
    if (![...event.dataTransfer.types].includes('Files')) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    veil.hidden = false;
    clearTimeout(dragTimer);
    dragTimer = setTimeout(() => {
      veil.hidden = true;
    }, 180);
  });
  document.addEventListener('drop', (event) => {
    if (![...event.dataTransfer.types].includes('Files')) {
      return;
    }
    event.preventDefault();
    clearTimeout(dragTimer);
    veil.hidden = true;
    filesFromTransfer(event.dataTransfer).then((files) => {
      loadFiles(files);
    });
  });

  let resizeTimer = 0;
  const resizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!hits.length) {
        return;
      }
      rebuildMetrics();
      drawnStart = -1;
      scheduleRender(true);
    }, 120);
  });
  resizeObserver.observe(list);

  async function resumeSession() {
    const generation = loadGeneration;
    try {
      const records = await DraftStore.restore();
      if (generation !== loadGeneration) return;
      const valid = records.length && records.every(({catalog}) => catalog &&
        typeof catalog.draftId === 'string' && Array.isArray(catalog.entries) &&
        catalog.headers && typeof catalog.filename === 'string');
      if (valid) {
        adoptCatalogs(records.map(({catalog}) => catalog), [], records.map(({edits}) => edits));
        draftBaseline = Promise.resolve();
        draftStatus('restored', `前回の作業を復元しました（下書き ${edits.size.toLocaleString('ja-JP')} 件）。このブラウザーに一時保存済みです。`);
        return;
      }
    } catch {
      if (generation === loadGeneration) {
        draftStatus('error', '一時保存を確認できませんでした。ファイルは開けます。', false);
      }
      return;
    }
    try {
      const hasSavedData = await DraftStore.hasSavedData();
      if (generation === loadGeneration) {
        draftStatus('ready', 'PO ファイルを開くか、見本を表示してください。', hasSavedData);
      }
    } catch {
      if (generation === loadGeneration) {
        draftStatus('error', '一時保存を確認できませんでした。ファイルは開けます。', false);
      }
    }
  }

  if (!globalThis.PoParser) {
    result.textContent = '読み込み機能を起動できませんでした。ページを再読み込みしてください。';
  } else {
    restoreExportSettings();
    resumeSession().finally(refreshSavedFiles);
  }
})();
