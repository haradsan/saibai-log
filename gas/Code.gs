/**
 * 栽培記録 同期サーバー (Google Apps Script)
 *
 * デプロイ方法:
 * 1. script.google.com で新しいプロジェクトを作成
 * 2. このファイルの内容を コード.gs に貼り付け、TOKEN を自分のトークンに書き換える
 * 3. デプロイ → 新しいデプロイ → ウェブアプリ
 *    - 実行ユーザー: 自分
 *    - アクセスできるユーザー: 全員
 * 4. 発行されたウェブアプリURLをアプリの設定画面に貼り付ける
 *
 * 初回同期時に Drive 直下へ「栽培記録DB」(スプレッドシート) と
 * 「栽培記録photos」(フォルダ) を自動作成する。
 */

const TOKEN = 'CHANGE_ME';
const STORES = ['seasons', 'crops', 'varieties', 'locations', 'plantings', 'records'];

function doGet(e) {
  return json_({ ok: true, service: 'saibai-log-sync' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad request' });
  }
  if (body.token !== TOKEN) return json_({ ok: false, error: 'unauthorized' });
  if (body.action === 'ping') return json_({ ok: true, service: 'saibai-log-sync' });
  if (body.action === 'sync') return handleSync_(body);
  if (body.action === 'getPhotos') return handleGetPhotos_(body);
  return json_({ ok: false, error: 'unknown action' });
}

function setup_() {
  const props = PropertiesService.getScriptProperties();
  let ssId = props.getProperty('SS_ID');
  let folderId = props.getProperty('FOLDER_ID');
  let ss, folder;
  if (ssId) {
    ss = SpreadsheetApp.openById(ssId);
  } else {
    ss = SpreadsheetApp.create('栽培記録DB');
    props.setProperty('SS_ID', ss.getId());
  }
  if (folderId) {
    folder = DriveApp.getFolderById(folderId);
  } else {
    folder = DriveApp.createFolder('栽培記録photos');
    props.setProperty('FOLDER_ID', folder.getId());
  }
  return { ss: ss, folder: folder, props: props };
}

function sheetFor_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(['id', 'updatedAt', 'rev', 'json']);
  }
  return sh;
}

function readAll_(sh) {
  const values = sh.getDataRange().getValues();
  const map = new Map();
  for (let i = 1; i < values.length; i++) {
    map.set(String(values[i][0]), {
      rowIndex: i + 1,
      updatedAt: String(values[i][1] || ''),
      rev: Number(values[i][2] || 0),
      json: String(values[i][3] || ''),
    });
  }
  return map;
}

function handleSync_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ctx = setup_();
    let rev = Number(ctx.props.getProperty('REV') || '0');
    const sinceRev = Number(body.sinceRev || 0);
    const resChanges = {};

    for (const store of STORES) {
      const sh = sheetFor_(ctx.ss, store);
      const server = readAll_(sh);
      for (const obj of (body.changes && body.changes[store]) || []) {
        const u = String(obj.updatedAt || '');
        const cur = server.get(String(obj.id));
        if (!cur) {
          rev++;
          sh.appendRow([obj.id, u, rev, JSON.stringify(obj)]);
          server.set(String(obj.id), { rowIndex: -1, updatedAt: u, rev: rev, json: JSON.stringify(obj) });
        } else if (u > cur.updatedAt) {
          rev++;
          sh.getRange(cur.rowIndex, 1, 1, 4).setValues([[obj.id, u, rev, JSON.stringify(obj)]]);
          cur.updatedAt = u; cur.rev = rev; cur.json = JSON.stringify(obj);
        }
      }
      const out = [];
      server.forEach(function (v) {
        if (v.rev > sinceRev && v.json) out.push(JSON.parse(v.json));
      });
      resChanges[store] = out;
    }

    // photos: バイナリはDrive、メタ情報はシート
    const psh = sheetFor_(ctx.ss, 'photos');
    const pserver = readAll_(psh);
    for (const p of body.photos || []) {
      const u = String(p.updatedAt || '');
      const cur = pserver.get(String(p.id));
      if (!cur) {
        let fileId = '';
        if (p.dataB64 && !p.deleted) {
          const blob = Utilities.newBlob(Utilities.base64Decode(p.dataB64), 'image/jpeg', p.id + '.jpg');
          fileId = ctx.folder.createFile(blob).getId();
        }
        const meta = {
          id: p.id, recordId: p.recordId, takenAt: p.takenAt,
          width: p.width, height: p.height, deleted: p.deleted ? 1 : 0,
          fileId: fileId, updatedAt: u,
        };
        rev++;
        psh.appendRow([p.id, u, rev, JSON.stringify(meta)]);
        pserver.set(String(p.id), { rowIndex: -1, updatedAt: u, rev: rev, json: JSON.stringify(meta) });
      } else if (u > cur.updatedAt) {
        const meta = JSON.parse(cur.json);
        meta.deleted = p.deleted ? 1 : 0;
        meta.updatedAt = u;
        if (meta.deleted && meta.fileId) {
          try { DriveApp.getFileById(meta.fileId).setTrashed(true); } catch (err) {}
          meta.fileId = '';
        }
        rev++;
        psh.getRange(cur.rowIndex, 1, 1, 4).setValues([[p.id, u, rev, JSON.stringify(meta)]]);
        cur.updatedAt = u; cur.rev = rev; cur.json = JSON.stringify(meta);
      }
    }
    const photoMeta = [];
    pserver.forEach(function (v) {
      if (v.rev > sinceRev && v.json) photoMeta.push(JSON.parse(v.json));
    });

    ctx.props.setProperty('REV', String(rev));
    return json_({ ok: true, maxRev: rev, changes: resChanges, photoMeta: photoMeta });
  } finally {
    lock.releaseLock();
  }
}

function handleGetPhotos_(body) {
  const ctx = setup_();
  const psh = sheetFor_(ctx.ss, 'photos');
  const pserver = readAll_(psh);
  const out = [];
  for (const id of (body.ids || []).slice(0, 10)) {
    const cur = pserver.get(String(id));
    if (!cur || !cur.json) continue;
    const meta = JSON.parse(cur.json);
    if (!meta.fileId) continue;
    try {
      const bytes = DriveApp.getFileById(meta.fileId).getBlob().getBytes();
      out.push({ id: id, dataB64: Utilities.base64Encode(bytes) });
    } catch (err) {}
  }
  return json_({ ok: true, photos: out });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
