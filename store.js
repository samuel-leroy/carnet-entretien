/* Carnet d'entretien : stockage local d'abord.
   - Les documents (véhicules, lignes, rappels) et les fichiers (factures) vivent dans IndexedDB, sur l'appareil.
   - Store sert à la synchronisation (drive.js). window.claude est un adaptateur qui garde l'interface inchangée. */
(function () {
  'use strict';

  var COLS = ['vehicles', 'entries', 'reminders'];
  var ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'];
  var idb = null, mem = {}, subs = [], localFns = [], pending = {}, queued = false, lastTs = 0;
  COLS.forEach(function (c) { mem[c] = new Map(); });

  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function now() { lastTs = Math.max(Date.now(), lastTs + 1); return lastTs; }
  function hex(n) {
    var a = new Uint8Array(n); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('IndexedDB indisponible')); return; }
      var r = indexedDB.open('carnet-entretien', 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        d.createObjectStore('docs', { keyPath: 'k' });
        d.createObjectStore('blobs', { keyPath: 'id' });
      };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function run(store, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t, out;
      try { t = idb.transaction(store, mode); out = fn(t.objectStore(store)); } catch (e) { reject(e); return; }
      t.oncomplete = function () { resolve(out && 'result' in out ? out.result : undefined); };
      t.onabort = t.onerror = function () {
        var e = t.error || {};
        reject(e.name === 'QuotaExceededError' ? { code: 'quota_exceeded', message: "L'espace de stockage de l'appareil est plein." } : (e.message ? e : new Error('Écriture impossible')));
      };
    });
  }

  var ready = openDb().then(function (d) {
    idb = d;
    return run('docs', 'readonly', function (s) { return s.getAll(); });
  }).then(function (all) {
    all.forEach(function (r) { if (mem[r.c]) mem[r.c].set(r.id, r); });
    return true;
  });
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) {}

  /* ---------- documents ---------- */
  function live(c, id) { var r = mem[c].get(id); return r && !r.deleted ? r : null; }
  function snap(c) {
    var docs = [];
    mem[c].forEach(function (r) {
      if (r.deleted) return;
      docs.push({ id: r.id, exists: true, data: function () { return clone(r.data); }, metadata: {} });
    });
    return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: {} };
  }
  function queueNotify(c) {
    pending[c] = true;
    if (queued) return;
    queued = true;
    Promise.resolve().then(function () {
      queued = false;
      var cs = Object.keys(pending); pending = {};
      cs.forEach(function (name) {
        subs.filter(function (s) { return s.c === name; }).forEach(function (s) { try { s.fn(snap(name)); } catch (e) { console.error(e); } });
      });
    });
  }
  function fireLocal() { localFns.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); }
  async function write(c, id, data, deleted) {
    var rec = { k: c + '/' + id, c: c, id: id, data: deleted ? null : data, updatedAt: now(), deleted: !!deleted };
    var prev = mem[c].get(id);
    mem[c].set(id, rec);
    try { await run('docs', 'readwrite', function (s) { s.put(rec); }); }
    catch (e) { if (prev) mem[c].set(id, prev); else mem[c].delete(id); queueNotify(c); throw e; }
    queueNotify(c); fireLocal();
  }
  function docRef(c, id) {
    return {
      id: id, path: c + '/' + id,
      get: async function () { var r = live(c, id); return { id: id, exists: !!r, data: function () { return r ? clone(r.data) : undefined; }, metadata: {} }; },
      set: function (data) { return write(c, id, clone(data), false); },
      update: function (data) {
        var r = live(c, id);
        if (!r) return Promise.reject({ code: 'invalid_argument', message: 'Élément introuvable.' });
        return write(c, id, Object.assign({}, clone(r.data), clone(data)), false);
      },
      delete: function () { return write(c, id, null, true); }
    };
  }
  function col(name) {
    if (!mem[name]) throw new TypeError('Collection inconnue : ' + name);
    var q = {
      path: name,
      orderBy: function () { return q; }, limit: function () { return q; }, where: function () { return q; },
      get: async function () { return snap(name); },
      onSnapshot: function (next) {
        var s = { c: name, fn: next }; subs.push(s);
        setTimeout(function () { try { next(snap(name)); } catch (e) { console.error(e); } }, 0);
        return function () { subs = subs.filter(function (x) { return x !== s; }); };
      },
      doc: function (id) { return docRef(name, id || hex(10)); },
      add: async function (d) { var r = docRef(name, hex(10)); await r.set(d); return r; }
    };
    return q;
  }

  /* ---------- fichiers (factures) ---------- */
  function blobGet(id) { return run('blobs', 'readonly', function (s) { return s.get(id); }); }
  function blobPut(rec) { return run('blobs', 'readwrite', function (s) { s.put(rec); }); }
  function blobRemove(id) { return run('blobs', 'readwrite', function (s) { s.delete(id); }); }
  function blobList() { return run('blobs', 'readonly', function (s) { return s.getAll(); }); }

  async function shrink(blob, type) {
    if (type === 'application/pdf' || type === 'image/gif') return blob;
    try {
      var bmp = await createImageBitmap(blob);
      var sc = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
      if (sc === 1 && blob.size < 1500000) { if (bmp.close) bmp.close(); return blob; }
      var w = Math.max(1, Math.round(bmp.width * sc)), h = Math.max(1, Math.round(bmp.height * sc));
      var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      var ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      var out = await new Promise(function (res) { cv.toBlob(res, 'image/jpeg', 0.86); });
      return out && out.size < blob.size ? out : blob;
    } catch (e) { return blob; }
  }
  var assetsApi = {
    upload: async function (blob, options) {
      var type = (options && options.type) || blob.type;
      if (ALLOWED.indexOf(type) < 0) throw { code: 'unsupported_type' };
      if (blob.size > 20 * 1024 * 1024) throw { code: 'too_large' };
      var out = await shrink(blob, type);
      var rec = { id: hex(16), blob: out, name: blob.name || 'facture', type: out.type || type, size: out.size,
        label: (options && options.label) || '', synced: false, deleted: false, createdAt: Date.now() };
      await blobPut(rec);
      fireLocal();
      return { id: rec.id, url: '', sizeBytes: rec.size, contentType: rec.type };
    },
    delete: async function (id) {
      var rec = await blobGet(id);
      if (!rec) return { deleted: false };
      if (!rec.driveId) await blobRemove(id);
      else { rec.deleted = true; rec.blob = null; await blobPut(rec); }
      fireLocal();
      return { deleted: true };
    },
    list: async function () { return { assets: [], usage: {} }; }
  };

  /* ---------- enregistrement de fichiers sur l'appareil ---------- */
  function saveFile(req) {
    return new Promise(function (resolve, reject) {
      try {
        var ext = (req.filename.split('.').pop() || '').toLowerCase();
        var type = ext === 'csv' ? 'text/csv;charset=utf-8' : ext === 'json' ? 'application/json' : 'application/octet-stream';
        var blob = req.data instanceof Blob ? req.data : new Blob([req.data], { type: type });
        var url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = req.filename; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        resolve({ status: 'saved' });
      } catch (e) { reject({ code: 'unavailable' }); }
    });
  }

  /* ---------- adaptateur utilisé par l'interface ---------- */
  window.claude = {
    use: async function (name) {
      if (name === 'db') { try { await ready; } catch (e) { return null; } return { collection: col }; }
      if (name === 'assets') { try { await ready; } catch (e) { return null; } return assetsApi; }
      if (name === 'downloads') return { save: saveFile };
      if (name === 'user') return { can: async function () { return true; }, canEdit: function () { return true; }, isOwner: function () { return true; }, id: async function () { return 'local'; } };
      return null;
    }
  };

  /* ---------- API pour la synchronisation ---------- */
  window.Store = {
    ready: ready,
    dump: function () {
      var out = [];
      COLS.forEach(function (c) {
        mem[c].forEach(function (r) { out.push({ k: r.k, c: r.c, id: r.id, data: r.data, updatedAt: r.updatedAt, deleted: !!r.deleted }); });
      });
      out.sort(function (a, b) { return a.k < b.k ? -1 : a.k > b.k ? 1 : 0; });
      return out;
    },
    mergeRemote: async function (list) {
      var changed = [];
      (list || []).forEach(function (r) {
        if (!r || !mem[r.c] || !r.id || typeof r.updatedAt !== 'number') return;
        var cur = mem[r.c].get(r.id);
        if (!cur || r.updatedAt > cur.updatedAt) {
          var rec = { k: r.c + '/' + r.id, c: r.c, id: r.id, data: r.data, updatedAt: r.updatedAt, deleted: !!r.deleted };
          mem[r.c].set(r.id, rec); changed.push(rec); lastTs = Math.max(lastTs, r.updatedAt);
        }
      });
      if (changed.length) {
        await run('docs', 'readwrite', function (s) { changed.forEach(function (r) { s.put(r); }); });
        changed.forEach(function (r) { queueNotify(r.c); });
      }
      return changed.length;
    },
    importRecords: async function (obj) {
      var ENRICH = ['fuelType', 'station', 'full', 'missed'];
      var recs = [];
      COLS.forEach(function (c) {
        (Array.isArray(obj[c]) ? obj[c] : []).forEach(function (d) {
          if (!d || typeof d !== 'object' || !d.id) return;
          var id = String(d.id), cur = mem[c].get(id);
          if (cur) {
            // élément déjà présent : on complète seulement les champs d'enrichissement manquants
            if (c !== 'entries' || cur.deleted || !cur.data) return;
            var add = {};
            var tt = String(cur.data.title || '').toLowerCase();
            ENRICH.forEach(function (k) {
              if (d[k] === undefined || cur.data[k] !== undefined) return;
              // carburant / station : seulement si le titre actuel les contient encore (sinon la ligne a été renommée : on respecte le titre)
              if ((k === 'station' && d[k]) || k === 'fuelType') { if (tt.indexOf(String(d[k]).toLowerCase()) < 0) return; }
              add[k] = d[k];
            });
            if (Object.keys(add).length) recs.push({ k: c + '/' + id, c: c, id: id, data: Object.assign({}, cur.data, add), updatedAt: now(), deleted: false });
            return;
          }
          var data = clone(d); delete data.id;
          recs.push({ k: c + '/' + id, c: c, id: id, data: data, updatedAt: now(), deleted: false });
        });
      });
      if (!recs.length) return 0;
      recs.forEach(function (r) { mem[r.c].set(r.id, r); });
      await run('docs', 'readwrite', function (s) { recs.forEach(function (r) { s.put(r); }); });
      recs.forEach(function (r) { queueNotify(r.c); });
      fireLocal();
      return recs.length;
    },
    exportAll: function () {
      var o = {};
      COLS.forEach(function (c) {
        o[c] = [];
        mem[c].forEach(function (r) { if (!r.deleted) o[c].push(Object.assign({ id: r.id }, clone(r.data))); });
      });
      return o;
    },
    onLocalChange: function (fn) { localFns.push(fn); },
    blob: { get: blobGet, put: blobPut, remove: blobRemove, list: blobList }
  };
})();
