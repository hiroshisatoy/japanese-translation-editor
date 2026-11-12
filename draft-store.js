'use strict';

// Keep imported catalogs separate from small, frequently updated draft records.
(function attachDraftStore() {
  let database;
  let writes = Promise.resolve();

  function open() {
    if (!database) {
      database = new Promise((resolve, reject) => {
        let blocked = false;
        const request = indexedDB.open('japanese-translation-editor-drafts', 1);
        request.onupgradeneeded = () => {
          for (const name of ['catalogs', 'drafts', 'meta']) {
            request.result.createObjectStore(name);
          }
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
          blocked = true;
          reject(new Error('Storage upgrade blocked'));
        };
        request.onsuccess = () => {
          const db = request.result;
          if (blocked) {
            db.close();
            return;
          }
          db.onversionchange = () => {
            db.close();
            database = null;
          };
          resolve(db);
        };
      }).catch((error) => {
        database = null;
        throw error;
      });
    }
    return database;
  }

  async function transaction(names, mode, execute) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
      // Requests are queued synchronously, without awaiting inside a transaction.
      try {
        result = execute(tx);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }

  function write(names, execute) {
    const operation = writes.then(() => transaction(names, 'readwrite', execute));
    // A failed write must not prevent subsequent retries or deletion.
    writes = operation.catch(() => {});
    return operation;
  }

  async function identify(filename, text) {
    const bytes = new TextEncoder().encode(JSON.stringify([filename, text]));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function readDrafts(catalogs) {
    await writes;
    return transaction(['drafts'], 'readonly', (tx) => {
      const records = catalogs.map(() => []);
      catalogs.forEach((catalog, index) => {
        if (!catalog.draftId) return;
        tx.objectStore('drafts').get(catalog.draftId).onsuccess = (event) => {
          records[index] = event.target.result?.edits || [];
        };
      });
      return records;
    });
  }

  function remember(catalogs) {
    return write(['catalogs', 'meta'], (tx) => {
      for (const catalog of catalogs) {
        if (!catalog.draftId) throw new Error('Missing catalog identity');
        tx.objectStore('catalogs').put(catalog, catalog.draftId);
      }
      tx.objectStore('meta').put(catalogs.map((catalog) => catalog.draftId), 'session');
    });
  }

  function save(catalogs, revisions) {
    // Copy before queuing so later keystrokes cannot mutate an in-flight save.
    const snapshot = revisions.map((edits) => edits.map(([index, values]) => [index, values.slice()]));
    const ids = catalogs.map((catalog) => catalog.draftId);
    return write(['drafts'], (tx) => {
      ids.forEach((id, index) => {
        if (!id) throw new Error('Missing catalog identity');
        tx.objectStore('drafts').put({edits: snapshot[index]}, id);
      });
    });
  }

  async function restore() {
    await writes;
    return transaction(['meta', 'catalogs', 'drafts'], 'readonly', (tx) => {
      const records = [];
      tx.objectStore('meta').get('session').onsuccess = (event) => {
        const ids = event.target.result;
        if (!Array.isArray(ids)) return;
        ids.forEach((id, index) => {
          const record = {catalog: null, edits: []};
          records[index] = record;
          tx.objectStore('catalogs').get(id).onsuccess = (loaded) => {
            record.catalog = loaded.target.result;
          };
          tx.objectStore('drafts').get(id).onsuccess = (loaded) => {
            record.edits = loaded.target.result?.edits || [];
          };
        });
      };
      return records;
    });
  }

  async function listSaved() {
    await writes;
    return transaction(['catalogs', 'drafts'], 'readonly', (tx) => {
      const records = [];
      // Read one catalog at a time; retain only the small display summaries.
      // Existing v1 records need no migration or invented save timestamps.
      tx.objectStore('catalogs').openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        const catalog = cursor.value;
        if (typeof catalog?.filename === 'string' && Array.isArray(catalog.entries)) {
          const record = {
            id: cursor.primaryKey,
            filename: catalog.filename,
            project: catalog.headers?.['Project-Id-Version'] || '',
            language: catalog.headers?.Language || '',
            entries: catalog.entries.length,
            changes: 0,
          };
          records.push(record);
          tx.objectStore('drafts').get(cursor.primaryKey).onsuccess = (loaded) => {
            record.changes = loaded.target.result?.edits?.length || 0;
          };
        }
        cursor.continue();
      };
      return records;
    });
  }

  async function readSaved(id) {
    await writes;
    return transaction(['catalogs', 'drafts'], 'readonly', (tx) => {
      const record = {catalog: null, edits: []};
      tx.objectStore('catalogs').get(id).onsuccess = (event) => {
        record.catalog = event.target.result;
      };
      tx.objectStore('drafts').get(id).onsuccess = (event) => {
        record.edits = event.target.result?.edits || [];
      };
      return record;
    });
  }

  function forgetSession() {
    return write(['meta'], (tx) => {
      tx.objectStore('meta').delete('session');
    });
  }

  async function hasSavedData() {
    await writes;
    const result = await transaction(['catalogs'], 'readonly', (tx) => {
      const state = {exists: false};
      tx.objectStore('catalogs').count().onsuccess = (event) => {
        state.exists = event.target.result > 0;
      };
      return state;
    });
    return result.exists;
  }

  function remove(scope, currentIds) {
    const active = new Set(currentIds.filter(Boolean));
    if (!['current', 'other', 'drafts', 'all'].includes(scope)) {
      return Promise.reject(new Error('Invalid deletion scope'));
    }
    return write(['meta', 'catalogs', 'drafts'], (tx) => {
      if (scope === 'all') {
        for (const name of ['meta', 'catalogs', 'drafts']) tx.objectStore(name).clear();
        return;
      }
      if (scope === 'drafts') {
        tx.objectStore('drafts').clear();
        return;
      }
      const shouldDelete = (id) => scope === 'current' ? active.has(id) : !active.has(id);
      for (const name of ['catalogs', 'drafts']) {
        const request = tx.objectStore(name).openKeyCursor();
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) return;
          if (shouldDelete(cursor.primaryKey)) tx.objectStore(name).delete(cursor.primaryKey);
          cursor.continue();
        };
      }
      const meta = tx.objectStore('meta');
      meta.get('session').onsuccess = (event) => {
        const session = event.target.result;
        // Do not leave a last-session marker that references deleted catalogs.
        if (Array.isArray(session) && session.some(shouldDelete)) meta.delete('session');
      };
    });
  }

  async function getSummary(currentIds = []) {
    await writes;
    return transaction(['catalogs', 'drafts'], 'readonly', (tx) => {
      const active = new Set(currentIds.filter(Boolean));
      const summary = {files: 0, changes: 0, currentFiles: 0, currentChanges: 0};
      const files = tx.objectStore('catalogs').openKeyCursor();
      files.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        summary.files++;
        if (active.has(cursor.primaryKey)) summary.currentFiles++;
        cursor.continue();
      };
      const request = tx.objectStore('drafts').openCursor();
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        if (Array.isArray(cursor.value?.edits)) {
          summary.changes += cursor.value.edits.length;
          if (active.has(cursor.primaryKey)) summary.currentChanges += cursor.value.edits.length;
        }
        cursor.continue();
      };
      return summary;
    });
  }

  globalThis.DraftStore = {identify, readDrafts, remember, save, restore, listSaved, readSaved, forgetSession, hasSavedData, getSummary, remove};
})();
