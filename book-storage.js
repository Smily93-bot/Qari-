/* Device-local library: every book, its pages, reading position, bookmarks,
   highlights, saved words and downloaded narration. No API keys are stored here. */
(function(root) {
  'use strict';
  const DB_NAME = 'qari-books', DB_VERSION = 2;

  function req(r) { return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }

  class QariBookStorage {
    constructor() { this.ready = null; this.queue = Promise.resolve(); }

    open() {
      if (!this.ready) this.ready = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('Book storage is unavailable')); return; }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = event => {
          const db = request.result, tx = request.transaction;
          const has = name => db.objectStoreNames.contains(name);
          if (!has('books')) db.createObjectStore('books', {keyPath: 'id'});
          if (!has('bookPages')) db.createObjectStore('bookPages', {keyPath: ['bookId', 'pageNum']}).createIndex('bookId', 'bookId');
          if (!has('bookAudio')) db.createObjectStore('bookAudio');
          if (!has('offline')) db.createObjectStore('offline', {keyPath: 'key'}).createIndex('bookId', 'bookId');
          if (!has('notes')) db.createObjectStore('notes', {keyPath: 'id'}).createIndex('bookId', 'bookId');
          if (!has('words')) db.createObjectStore('words', {keyPath: 'id'});
          if (!has('meta')) db.createObjectStore('meta');
          // Move the single saved book from v13/v14 into the new library.
          if (event.oldVersion === 1 && has('book')) {
            const oldBook = tx.objectStore('book').get('last');
            oldBook.onsuccess = () => {
              const book = oldBook.result;
              const oldPages = tx.objectStore('pages').getAll();
              oldPages.onsuccess = () => {
                const oldAudio = tx.objectStore('audio').get('current');
                oldAudio.onsuccess = () => {
                  if (book?.id) {
                    tx.objectStore('books').put({...book, opened: Date.now()});
                    for (const page of oldPages.result || []) tx.objectStore('bookPages').put({...page, bookId: book.id});
                    if (oldAudio.result) tx.objectStore('bookAudio').put(oldAudio.result, book.id);
                    tx.objectStore('meta').put(book.id, 'active');
                  }
                  db.deleteObjectStore('book'); db.deleteObjectStore('pages'); db.deleteObjectStore('audio');
                };
              };
            };
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return this.ready;
    }
    write(action) {
      const job = this.queue.then(async () => action(await this.open()));
      this.queue = job.catch(() => {});
      return job;
    }
    transaction(db, names, action, mode = 'readwrite') {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(names, mode);
        let result;
        tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
        result = action(tx);
      });
    }
    async read(names, action) { const db = await this.open(); return this.transaction(db, names, action, 'readonly'); }

    // ---- book life-cycle (same calls the reader already uses) ----
    start(meta, file) {
      return this.write(db => this.transaction(db, ['books', 'meta'], tx => {
        tx.objectStore('books').put({...meta, file, size: file?.size || 0, added: Date.now(), opened: Date.now()});
        tx.objectStore('meta').put(meta.id, 'active');
      }));
    }
    page(bookId, page, patch) {
      return this.write(db => this.transaction(db, ['books', 'bookPages'], tx => {
        const books = tx.objectStore('books'), get = books.get(bookId);
        get.onsuccess = () => {
          if (!get.result) return;
          tx.objectStore('bookPages').put({...page, bookId});
          books.put({...get.result, ...patch, id: bookId});
        };
      }));
    }
    progress(bookId, patch, audio) {
      return this.write(db => this.transaction(db, ['books', 'bookAudio'], tx => {
        const books = tx.objectStore('books'), get = books.get(bookId);
        get.onsuccess = () => {
          if (!get.result) return;
          books.put({...get.result, ...patch, id: bookId, opened: Date.now()});
          if (audio) tx.objectStore('bookAudio').put(audio, bookId);
        };
      }));
    }
    setActive(bookId) { return this.write(db => this.transaction(db, ['meta'], tx => { tx.objectStore('meta').put(bookId, 'active'); })); }

    /** Loads one book (the active one when no id is given). */
    async load(bookId) {
      const db = await this.open();
      if (!bookId) bookId = await this.transaction(db, ['meta'], tx => req(tx.objectStore('meta').get('active')), 'readonly').then(p => p);
      if (!bookId) return {};
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['books', 'bookPages', 'bookAudio'], 'readonly');
        const book = tx.objectStore('books').get(bookId);
        const pages = tx.objectStore('bookPages').index('bookId').getAll(bookId);
        const audio = tx.objectStore('bookAudio').get(bookId);
        tx.oncomplete = () => resolve({book: book.result, pages: (pages.result || []).sort((a, b) => a.pageNum - b.pageNum), audio: audio.result});
        tx.onerror = () => reject(tx.error);
      });
    }
    async list() {
      const books = await this.read(['books'], tx => req(tx.objectStore('books').getAll())).then(p => p);
      return (books || []).map(b => ({...b, file: undefined, hasFile: !!b.file})).sort((a, b) => (b.opened || 0) - (a.opened || 0));
    }
    async findSame(name, size) {
      const books = await this.list();
      return books.find(b => b.name === name && (!size || !b.size || b.size === size));
    }
    remove(bookId) {
      return this.write(async db => {
        const pageKeys = await this.transaction(db, ['bookPages'], tx => req(tx.objectStore('bookPages').index('bookId').getAllKeys(bookId)), 'readonly').then(p => p);
        const offKeys = await this.transaction(db, ['offline'], tx => req(tx.objectStore('offline').index('bookId').getAllKeys(bookId)), 'readonly').then(p => p);
        const noteKeys = await this.transaction(db, ['notes'], tx => req(tx.objectStore('notes').index('bookId').getAllKeys(bookId)), 'readonly').then(p => p);
        return this.transaction(db, ['books', 'bookPages', 'bookAudio', 'offline', 'notes', 'meta'], tx => {
          tx.objectStore('books').delete(bookId);
          tx.objectStore('bookAudio').delete(bookId);
          for (const k of pageKeys || []) tx.objectStore('bookPages').delete(k);
          for (const k of offKeys || []) tx.objectStore('offline').delete(k);
          for (const k of noteKeys || []) tx.objectStore('notes').delete(k);
          const active = tx.objectStore('meta').get('active');
          active.onsuccess = () => { if (active.result === bookId) tx.objectStore('meta').delete('active'); };
        });
      });
    }

    // ---- bookmarks & highlights ----
    saveNote(note) { return this.write(db => this.transaction(db, ['notes'], tx => { tx.objectStore('notes').put(note); })); }
    deleteNote(id) { return this.write(db => this.transaction(db, ['notes'], tx => { tx.objectStore('notes').delete(id); })); }
    async notes(bookId) {
      const all = await this.read(['notes'], tx => req(tx.objectStore('notes').index('bookId').getAll(bookId))).then(p => p);
      return (all || []).sort((a, b) => a.pageNum - b.pageNum || a.offset - b.offset);
    }

    // ---- saved words ----
    saveWord(word) { return this.write(db => this.transaction(db, ['words'], tx => { tx.objectStore('words').put(word); })); }
    deleteWord(id) { return this.write(db => this.transaction(db, ['words'], tx => { tx.objectStore('words').delete(id); })); }
    async words() {
      const all = await this.read(['words'], tx => req(tx.objectStore('words').getAll())).then(p => p);
      return (all || []).sort((a, b) => (b.created || 0) - (a.created || 0));
    }

    // ---- downloaded narration ----
    saveOffline(item) { return this.write(db => this.transaction(db, ['offline'], tx => { tx.objectStore('offline').put(item); })); }
    async offline(key) { return this.read(['offline'], tx => req(tx.objectStore('offline').get(key))).then(p => p); }
    async offlineSummary(bookId) {
      const items = await this.read(['offline'], tx => req(tx.objectStore('offline').index('bookId').getAll(bookId))).then(p => p);
      return {count: (items || []).length, bytes: (items || []).reduce((n, i) => n + (i.blob?.size || 0), 0),
        starts: new Set((items || []).map(i => i.start))};
    }
    clearOffline(bookId) {
      return this.write(async db => {
        const keys = await this.transaction(db, ['offline'], tx => req(tx.objectStore('offline').index('bookId').getAllKeys(bookId)), 'readonly').then(p => p);
        return this.transaction(db, ['offline'], tx => { for (const k of keys || []) tx.objectStore('offline').delete(k); });
      });
    }
  }
  root.QariBookStorage = QariBookStorage;
})(typeof window !== 'undefined' ? window : globalThis);
