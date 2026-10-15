/* Carnet d'entretien : synchronisation avec Google Drive.
   - Portée « drive.file » : l'application ne voit que les fichiers qu'elle a elle-même créés.
   - Dossier « Carnet entretien véhicules » : carnet-db.json (données) et « Factures » (PDF et photos).
   - Fusion élément par élément : la modification la plus récente l'emporte, les suppressions sont propagées. */
(function () {
  'use strict';

  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var ROOT = 'Carnet entretien véhicules', DBNAME = 'carnet-db.json', FACT = 'Factures';
  var FOLDER = 'application/vnd.google-apps.folder';
  var API = 'https://www.googleapis.com/drive/v3/files', UP = 'https://www.googleapis.com/upload/drive/v3/files';
  var LS = { cid: 'carnet.clientId', meta: 'carnet.drive', tok: 'carnet.token' };
  var token = null, tokenExp = 0, running = false, again = false, timer = null, gis = null;
  var st = { status: 'off', last: 0, error: '' }, fns = [];

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function meta() { try { return JSON.parse(lsGet(LS.meta) || '{}') || {}; } catch (e) { return {}; } }
  function saveMeta(m) { lsSet(LS.meta, JSON.stringify(m)); }
  function clientId() { return (lsGet(LS.cid) || (window.CARNET_CONFIG && window.CARNET_CONFIG.googleClientId) || '').trim(); }
  try {
    var t0 = JSON.parse(lsGet(LS.tok) || 'null');
    if (t0 && t0.exp > Date.now() + 60000) { token = t0.t; tokenExp = t0.exp; }
  } catch (e) {}
  function tokenOk() { return !!token && Date.now() < tokenExp - 60000; }

  function set(status, error) {
    st.status = status; st.error = error || ''; st.last = meta().last || 0;
    fns.forEach(function (fn) { try { fn(st); } catch (e) { console.error(e); } });
  }
  function idleStatus() {
    if (!clientId()) return 'off';
    if (!meta().connected) return 'disconnected';
    if (!navigator.onLine) return 'offline';
    return tokenOk() ? 'idle' : 'pending';
  }
  function fail(e) {
    if (e && e.code === 'auth') { set('pending', e.message); return; }
    if (e instanceof TypeError || (e && e.code === 'gis') || !navigator.onLine) { set('offline'); return; }
    set('error', (e && e.message) || 'Erreur de synchronisation.');
  }

  /* ---------- connexion Google ---------- */
  function loadGIS() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (gis) return gis;
    gis = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { gis = null; reject({ code: 'gis', message: 'Impossible de joindre le service de connexion Google.' }); };
      document.head.appendChild(s);
    });
    return gis;
  }
  function getToken(interactive) {
    if (tokenOk()) return Promise.resolve(token);
    if (!interactive) return Promise.reject({ code: 'auth', message: 'Connexion Google à renouveler : touchez « Synchro ».' });
    var cid = clientId();
    if (!cid) return Promise.reject({ message: "Renseignez d'abord l'identifiant client Google." });
    return loadGIS().then(function () {
      return new Promise(function (resolve, reject) {
        var client = google.accounts.oauth2.initTokenClient({
          client_id: cid, scope: SCOPE,
          callback: function (r) {
            if (!r || r.error) { reject({ code: 'auth', message: (r && (r.error_description || r.error)) || 'Connexion refusée.' }); return; }
            token = r.access_token; tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
            lsSet(LS.tok, JSON.stringify({ t: token, exp: tokenExp }));
            resolve(token);
          },
          error_callback: function (e) {
            reject({ code: 'auth', message: e && e.type === 'popup_closed' ? 'Connexion annulée.' : (e && e.message) || 'Connexion impossible.' });
          }
        });
        client.requestAccessToken({ prompt: '' });
      });
    });
  }

  /* ---------- appels à l'API Drive ---------- */
  async function api(url, opts) {
    opts = opts || {};
    var headers = Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {});
    var r = await fetch(url, Object.assign({}, opts, { headers: headers }));
    if (r.status === 401) {
      token = null; tokenExp = 0; lsSet(LS.tok, null);
      throw { code: 'auth', message: 'Session Google expirée : touchez « Synchro » pour la renouveler.' };
    }
    if (!r.ok) {
      throw { code: 'http', status: r.status, message: 'Google Drive a répondu ' + r.status + (r.status === 403 ? ' (accès refusé : l\'API Google Drive est-elle activée dans votre projet ?)' : '') + '.' };
    }
    return r;
  }
  async function findOne(q) {
    var r = await api(API + '?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('files(id,name,mimeType)') + '&pageSize=10&spaces=drive');
    var j = await r.json();
    return (j.files && j.files[0]) || null;
  }
  async function createFolder(name, parent) {
    var body = { name: name, mimeType: FOLDER };
    if (parent) body.parents = [parent];
    var r = await api(API + '?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return (await r.json()).id;
  }
  function multipart(metaObj, blob, type) {
    var b = 'carnet' + Math.random().toString(36).slice(2) + Date.now().toString(36), enc = new TextEncoder();
    var head = enc.encode('--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metaObj) + '\r\n--' + b + '\r\nContent-Type: ' + (type || 'application/octet-stream') + '\r\n\r\n');
    var tail = enc.encode('\r\n--' + b + '--');
    return { body: new Blob([head, blob, tail]), type: 'multipart/related; boundary=' + b };
  }
  async function ensureFolders() {
    var m = meta();
    if (!m.rootId) {
      var f = await findOne("name='" + ROOT + "' and mimeType='" + FOLDER + "' and trashed=false");
      m.rootId = f ? f.id : await createFolder(ROOT);
      m.factId = null; m.dbId = null; saveMeta(m);
    }
    if (!m.factId) {
      var g = await findOne("name='" + FACT + "' and mimeType='" + FOLDER + "' and '" + m.rootId + "' in parents and trashed=false");
      m.factId = g ? g.id : await createFolder(FACT, m.rootId); saveMeta(m);
    }
    return m;
  }

  /* ---------- données ---------- */
  async function readRemote(m) {
    var f = m.dbId ? { id: m.dbId } : await findOne("name='" + DBNAME + "' and '" + m.rootId + "' in parents and trashed=false");
    if (!f) return { id: null, text: null, records: [] };
    var r;
    try { r = await api(API + '/' + f.id + '?alt=media'); }
    catch (e) { if (e && e.status === 404) { m.dbId = null; saveMeta(m); return readRemote(m); } throw e; }
    var text = await r.text(), j;
    try { j = JSON.parse(text); } catch (e) { throw { message: 'Le fichier de données dans Google Drive est illisible : rien n\'a été modifié.' }; }
    if (m.dbId !== f.id) { m.dbId = f.id; saveMeta(m); }
    return { id: f.id, text: text, records: (j && j.docs) || [] };
  }
  async function writeRemote(id, body, m) {
    if (id) {
      await api(UP + '/' + id + '?uploadType=media&fields=id', { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: body });
    } else {
      var mp = multipart({ name: DBNAME, parents: [m.rootId], mimeType: 'application/json' }, new Blob([body]), 'application/json; charset=UTF-8');
      var r = await api(UP + '?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': mp.type }, body: mp.body });
      m.dbId = (await r.json()).id; saveMeta(m);
    }
  }
  function serialize(list) { return JSON.stringify({ app: 'carnet-entretien', v: 1, docs: list }); }

  /* ---------- factures ---------- */
  function fileName(rec) {
    var ext = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[rec.type] || '';
    var base = String(rec.label || rec.name || 'facture').replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/[\\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'facture';
    return base + ext;
  }
  async function uploadFile(rec, parent) {
    var mp = multipart({ name: fileName(rec), parents: [parent], mimeType: rec.type, appProperties: { assetId: rec.id } }, rec.blob, rec.type);
    var r = await api(UP + '?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': mp.type }, body: mp.body });
    return (await r.json()).id;
  }
  async function syncBlobs(m) {
    var list = await Store.blob.list();
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      if (rec.deleted) {
        if (rec.driveId) { try { await api(API + '/' + rec.driveId, { method: 'DELETE' }); } catch (e) { if (!(e && e.status === 404)) throw e; } }
        await Store.blob.remove(rec.id);
        continue;
      }
      if (!rec.synced && rec.blob) {
        var ex = await findOne("appProperties has { key='assetId' and value='" + rec.id + "' } and trashed=false");
        var id = ex ? ex.id : await uploadFile(rec, m.factId);
        var cur = await Store.blob.get(rec.id);
        if (cur) { cur.driveId = id; cur.synced = true; await Store.blob.put(cur); }
      }
    }
  }
  async function fetchBlob(id) {
    var rec = await Store.blob.get(id);
    if (rec && rec.blob) return rec.blob;
    if (!meta().connected) throw { message: "Ce fichier n'est pas sur cet appareil. Connectez Google Drive (bouton Synchro) pour le récupérer." };
    await getToken(true);
    var f = rec && rec.driveId ? { id: rec.driveId } : await findOne("appProperties has { key='assetId' and value='" + id + "' } and trashed=false");
    if (!f) throw { message: 'Fichier introuvable dans Google Drive.' };
    var r = await api(API + '/' + f.id + '?alt=media'), b = await r.blob();
    await Store.blob.put({ id: id, blob: b, name: f.name || 'facture', type: b.type, size: b.size, label: '', synced: true, deleted: false, driveId: f.id });
    return b;
  }

  /* ---------- synchronisation ---------- */
  async function once(interactive) {
    await getToken(interactive);
    var m = await ensureFolders();
    var remote = await readRemote(m);
    await Store.mergeRemote(remote.records);
    await syncBlobs(m);
    var local = Store.dump();
    if (local.length || remote.id) {
      var body = serialize(local);
      if (body !== remote.text) await writeRemote(remote.id, body, m);
    }
    m = meta(); m.last = Date.now(); saveMeta(m);
  }
  async function sync(interactive) {
    if (running) { again = true; return; }
    running = true; set('syncing');
    try {
      try { await once(interactive); }
      catch (e) {
        if (e && e.status === 404) { var m = meta(); m.rootId = m.factId = m.dbId = null; saveMeta(m); await once(interactive); }
        else throw e;
      }
      set('idle');
    } catch (e) { fail(e); }
    finally { running = false; if (again) { again = false; schedule(1500); } }
    return st.status;
  }
  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var s = idleStatus();
      if (s === 'idle') sync(false); else set(s);
    }, ms);
  }

  window.Drive = {
    state: function () { return st; },
    onState: function (fn) { fns.push(fn); },
    clientId: clientId,
    setClientId: function (v) { v = (v || '').trim(); if (v !== clientId()) { lsSet(LS.cid, v || null); var m = meta(); m.connected = false; saveMeta(m); token = null; tokenExp = 0; lsSet(LS.tok, null); } set(idleStatus()); },
    connected: function () { return !!meta().connected; },
    connect: async function () {
      set('syncing');
      try { await getToken(true); } catch (e) { fail(e); throw e; }
      var m = meta(); m.connected = true; saveMeta(m);
      return sync(true);
    },
    syncNow: function () { return sync(true); },
    disconnect: async function () {
      try { if (token && window.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(token, function () {}); } catch (e) {}
      token = null; tokenExp = 0; lsSet(LS.tok, null); lsSet(LS.meta, null);
      set(idleStatus());
    },
    fetchBlob: fetchBlob,
    init: function () {
      Store.onLocalChange(function () { schedule(4000); });
      window.addEventListener('online', function () { schedule(1000); });
      window.addEventListener('offline', function () { set(idleStatus()); });
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') schedule(1500); });
      set(idleStatus());
      if (idleStatus() === 'idle') schedule(1200);
    }
  };
})();
