/* Kalimat review mode: storage.

   Everything the review interface saves or loads goes through the one object
   this file puts on window.KalimatReviewStore. This version keeps the feedback
   in the reviewer's own browser:
     comments, wording changes, filled content  ->  localStorage
     pictures                                   ->  IndexedDB

   TO MOVE FEEDBACK TO A SERVER (Supabase):
   write another object with the same methods and assign it to
   window.KalimatReviewStore. review.js needs no change. Every method returns a
   Promise. A failed write rejects with an Error whose .code is
     'full'     storage has no room left
     'blocked'  the browser refused to store anything

   Methods
     init()                      -> { persistent: boolean }
     getState()                  -> { reviewer, comments[], edits[], slots{}, images[] (details only) }
     setReviewer(name)
     saveComment(comment)        add, or replace the one with the same id
     deleteComment(id)
     saveEdit(edit)              add, or replace the one with the same id
     deleteEdit(id)
     saveSlot(key, entry)
     deleteSlot(key)
     putImage(key, blob, meta)
     getImage(key)               -> { key, blob, meta } or null
     deleteImage(key)
     exportAll()                 -> everything, pictures as data URLs
     importAll(data)             replaces everything
     clearAll()
*/
(function () {
  'use strict';

  var LS_KEY = 'kalimat-review-v1';
  var DB_NAME = 'kalimat-review';
  var DB_STORE = 'images';

  function fail(code, message) { var e = new Error(message); e.code = code; return e; }
  function isQuota(err) {
    return !!err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22 || err.code === 1014);
  }
  function blank() { return { version: 1, reviewer: '', comments: [], edits: [], slots: {} }; }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }

  function toBuffer(blob) {
    if (blob.arrayBuffer) { return blob.arrayBuffer(); }
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsArrayBuffer(blob);
    });
  }
  function toDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }
  function fromDataUrl(dataUrl) {
    var m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(dataUrl || '');
    if (!m) { return null; }
    var raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) { bytes[i] = raw.charCodeAt(i); }
    return new Blob([bytes], { type: m[1] });
  }

  function createLocalStore() {
    var data = blank();
    var textPersistent = true;
    var imagesPersistent = true;
    var db = null;
    var memImages = {};          // used only when IndexedDB is unavailable

    /* ----- text: one JSON document in localStorage ----- */
    function readText() {
      try {
        var raw = window.localStorage.getItem(LS_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          var base = blank();
          base.reviewer = typeof parsed.reviewer === 'string' ? parsed.reviewer : '';
          base.comments = Array.isArray(parsed.comments) ? parsed.comments : [];
          base.edits = Array.isArray(parsed.edits) ? parsed.edits : [];
          base.slots = parsed.slots && typeof parsed.slots === 'object' ? parsed.slots : {};
          data = base;
        }
        window.localStorage.setItem(LS_KEY + '-probe', '1');
        window.localStorage.removeItem(LS_KEY + '-probe');
      } catch (err) {
        textPersistent = false;   // private browsing or storage switched off: keep working in memory
      }
    }
    // Change the data, then write it. If the write fails, undo the change so
    // what is on screen always matches what was saved.
    function commit(change) {
      return new Promise(function (resolve, reject) {
        var before = JSON.stringify(data);
        change(data);
        if (!textPersistent) { resolve(); return; }
        try {
          window.localStorage.setItem(LS_KEY, JSON.stringify(data));
          resolve();
        } catch (err) {
          data = JSON.parse(before);
          reject(isQuota(err)
            ? fail('full', 'This browser has no storage room left.')
            : fail('blocked', 'This browser refused to save.'));
        }
      });
    }
    function upsert(list, item) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === item.id) { list[i] = item; return; }
      }
      list.push(item);
    }
    function without(list, id) { return list.filter(function (x) { return x.id !== id; }); }

    /* ----- pictures: IndexedDB, stored as raw bytes ----- */
    function openDb() {
      return new Promise(function (resolve) {
        var settled = false;
        function done(value) { if (!settled) { settled = true; resolve(value); } }
        var req;
        try { req = window.indexedDB.open(DB_NAME, 1); } catch (err) { done(null); return; }
        req.onupgradeneeded = function () {
          if (!req.result.objectStoreNames.contains(DB_STORE)) { req.result.createObjectStore(DB_STORE, { keyPath: 'key' }); }
        };
        req.onsuccess = function () { done(req.result); };
        req.onerror = function () { done(null); };
        req.onblocked = function () { done(null); };
        setTimeout(function () { done(null); }, 4000);   // some private modes never answer
      });
    }
    function tx(mode, work) {
      return new Promise(function (resolve, reject) {
        var t, req;
        try {
          t = db.transaction(DB_STORE, mode);
          req = work(t.objectStore(DB_STORE));
        } catch (err) { reject(fail('blocked', 'This browser refused to save the picture.')); return; }
        t.oncomplete = function () { resolve(req ? req.result : undefined); };
        t.onabort = t.onerror = function () {
          var err = t.error || (req && req.error);
          reject(isQuota(err)
            ? fail('full', 'This browser has no storage room left for pictures.')
            : fail('blocked', 'This browser refused to save the picture.'));
        };
      });
    }
    function allImages() {
      if (!db) { return Promise.resolve(Object.keys(memImages).map(function (k) { return memImages[k]; })); }
      return tx('readonly', function (s) { return s.getAll(); }).then(function (rows) { return rows || []; });
    }
    function rowToImage(row) {
      if (!row) { return null; }
      return { key: row.key, blob: new Blob([row.buffer], { type: row.type }), meta: row.meta || {} };
    }

    return {
      init: function () {
        readText();
        return openDb().then(function (opened) {
          db = opened;
          imagesPersistent = !!db;
          return { persistent: textPersistent && imagesPersistent, text: textPersistent, images: imagesPersistent };
        });
      },

      getState: function () {
        return allImages().then(function (rows) {
          var state = copy(data);
          state.images = rows.map(function (row) { return Object.assign({ key: row.key }, row.meta || {}); });
          return state;
        });
      },

      setReviewer: function (name) { return commit(function (d) { d.reviewer = String(name || '').trim(); }); },

      saveComment: function (comment) { return commit(function (d) { upsert(d.comments, copy(comment)); }); },
      deleteComment: function (id) { return commit(function (d) { d.comments = without(d.comments, id); }); },

      saveEdit: function (edit) { return commit(function (d) { upsert(d.edits, copy(edit)); }); },
      deleteEdit: function (id) { return commit(function (d) { d.edits = without(d.edits, id); }); },

      saveSlot: function (key, entry) { return commit(function (d) { d.slots[key] = copy(entry); }); },
      deleteSlot: function (key) { return commit(function (d) { delete d.slots[key]; }); },

      putImage: function (key, blob, meta) {
        return toBuffer(blob).then(function (buffer) {
          var row = { key: key, type: blob.type || 'image/png', buffer: buffer, meta: copy(meta || {}) };
          if (!db) { memImages[key] = row; return; }
          return tx('readwrite', function (s) { return s.put(row); }).then(function () {});
        });
      },
      getImage: function (key) {
        if (!db) { return Promise.resolve(rowToImage(memImages[key])); }
        return tx('readonly', function (s) { return s.get(key); }).then(rowToImage);
      },
      deleteImage: function (key) {
        if (!db) { delete memImages[key]; return Promise.resolve(); }
        return tx('readwrite', function (s) { return s.delete(key); }).then(function () {});
      },

      exportAll: function () {
        return allImages().then(function (rows) {
          return Promise.all(rows.map(function (row) {
            return toDataUrl(new Blob([row.buffer], { type: row.type })).then(function (url) {
              return { key: row.key, meta: row.meta || {}, dataUrl: url };
            });
          }));
        }).then(function (images) {
          var out = copy(data);
          out.images = images;
          return out;
        });
      },

      importAll: function (incoming) {
        var self = this;
        var next = blank();
        next.reviewer = typeof incoming.reviewer === 'string' ? incoming.reviewer : '';
        next.comments = Array.isArray(incoming.comments) ? incoming.comments : [];
        next.edits = Array.isArray(incoming.edits) ? incoming.edits : [];
        next.slots = incoming.slots && typeof incoming.slots === 'object' ? incoming.slots : {};
        var images = Array.isArray(incoming.images) ? incoming.images : [];
        return self.clearAll().then(function () {
          return commit(function (d) { d.reviewer = next.reviewer; d.comments = next.comments; d.edits = next.edits; d.slots = next.slots; });
        }).then(function () {
          return images.reduce(function (chain, image) {
            return chain.then(function () {
              var blob = fromDataUrl(image.dataUrl);
              return blob ? self.putImage(image.key, blob, image.meta) : null;
            });
          }, Promise.resolve());
        });
      },

      clearAll: function () {
        data = blank();
        try { window.localStorage.removeItem(LS_KEY); } catch (err) { /* nothing was stored */ }
        memImages = {};
        if (!db) { return Promise.resolve(); }
        return tx('readwrite', function (s) { return s.clear(); }).then(function () {});
      }
    };
  }

  window.KalimatReviewStore = createLocalStore();
})();
