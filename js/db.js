/* ============================================================
 * db.js — IndexedDB 封装
 * 用于持久化保存用户本地导入的视频文件与封面图片（Blob）
 * ============================================================ */
const PlayerDB = (function () {
  const DB_NAME = 'smart_player_db';
  const DB_VERSION = 1;
  const STORE = 'files';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function put(key, blob) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key: key, blob: blob, time: Date.now() });
      tx.oncomplete = function () { resolve(); db.close(); };
      tx.onerror = function () { reject(tx.error); db.close(); };
    });
  }

  async function get(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = function () {
        resolve(req.result ? req.result.blob : null);
        db.close();
      };
      req.onerror = function () { reject(req.error); db.close(); };
    });
  }

  async function remove(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = function () { resolve(); db.close(); };
      tx.onerror = function () { reject(tx.error); db.close(); };
    });
  }

  async function getAllKeys() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = function () { resolve(req.result); db.close(); };
      req.onerror = function () { reject(req.error); db.close(); };
    });
  }

  return { put: put, get: get, remove: remove, getAllKeys: getAllKeys };
})();
