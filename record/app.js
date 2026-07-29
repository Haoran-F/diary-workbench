/* ===== 日记工作台 - 主逻辑 ===== */

(function () {
  'use strict';

  /* ---------- IndexedDB 存储层 ---------- */
  const DB_NAME = 'diary-db';
  const DB_VERSION = 1;
  const STORE = 'records';
  let dbReady = null;

  function openDB() {
    if (dbReady) return dbReady;
    dbReady = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbReady;
  }

  async function addRecord(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllRecords() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const idx = tx.objectStore(STORE).index('createdAt');
      const req = idx.openCursor(null, 'prev'); // 倒序
      const list = [];
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur) {
          list.push(cur.value);
          cur.continue();
        } else {
          resolve(list);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteRecord(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /* ---------- DOM 引用 ---------- */
  const $ = (id) => document.getElementById(id);
  const video = $('camera-video');
  const placeholder = $('camera-placeholder');
  const recIndicator = $('recording-indicator');
  const recTimer = $('rec-timer');
  const mediaPreview = $('media-preview');
  const diaryText = $('diary-text');
  const currentTime = $('current-time');
  const btnStartCam = $('btn-start-camera');
  const btnPhoto = $('btn-capture-photo');
  const btnRecord = $('btn-record-video');
  const btnSave = $('btn-save');
  const historyList = $('history-list');
  const viewer = $('viewer-overlay');
  const viewerContent = $('viewer-content');
  const viewerClose = $('viewer-close');

  /* ---------- 状态 ---------- */
  let stream = null;          // 摄像头流
  let mediaRecorder = null;   // 视频录制器
  let recChunks = [];
  let recTimerId = null;
  let recStartTs = 0;
  let isRecording = false;
  let pendingMedia = [];      // 待保存的媒体 { type, blob }
  let objectUrls = [];        // 待清理的 ObjectURL

  /* ---------- 时间格式化 ---------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function formatDateTime(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function formatDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日`;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  }

  /* ---------- 当前时间显示 ---------- */
  function updateCurrentTime() {
    currentTime.textContent = formatDateTime(Date.now());
  }
  updateCurrentTime();
  setInterval(updateCurrentTime, 30000);

  /* ---------- 标签切换 ---------- */
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
      if (view === 'history') renderHistory();
      if (view === 'compose') stopCamera();
    });
  });

  /* ---------- 摄像头 ---------- */
  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: true
      });
      video.srcObject = stream;
      video.classList.add('active');
      placeholder.classList.add('hidden');
      btnPhoto.disabled = false;
      btnRecord.disabled = false;
      btnStartCam.textContent = '关闭摄像头';
    } catch (err) {
      alert('无法访问摄像头：' + (err.message || err.name));
    }
  }

  function stopCamera() {
    if (isRecording) stopRecording();
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
      video.classList.remove('active');
      placeholder.classList.remove('hidden');
      btnPhoto.disabled = true;
      btnRecord.disabled = true;
      btnStartCam.textContent = '开启摄像头';
    }
  }

  btnStartCam.addEventListener('click', () => {
    if (stream) stopCamera();
    else startCamera();
  });

  /* ---------- 拍照 ---------- */
  btnPhoto.addEventListener('click', () => {
    if (!stream) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (blob) addPendingMedia('image', blob);
    }, 'image/jpeg', 0.85);
  });

  /* ---------- 录制视频 ---------- */
  btnRecord.addEventListener('click', () => {
    if (!isRecording) startRecording();
    else stopRecording();
  });

  function startRecording() {
    if (!stream) return;
    recChunks = [];
    // 优先使用 video/webm
    const mime = MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : '';
    mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recChunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recChunks, { type: mime || 'video/webm' });
      addPendingMedia('video', blob);
    };
    mediaRecorder.start();
    isRecording = true;
    recStartTs = Date.now();
    recIndicator.hidden = false;
    btnRecord.textContent = '停止录制';
    btnPhoto.disabled = true;
    recTimerId = setInterval(() => {
      recTimer.textContent = formatDuration(Date.now() - recStartTs);
    }, 500);
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    isRecording = false;
    recIndicator.hidden = true;
    btnRecord.textContent = '录制视频';
    btnPhoto.disabled = false;
    if (recTimerId) {
      clearInterval(recTimerId);
      recTimerId = null;
    }
  }

  /* ---------- 待保存媒体管理 ---------- */
  function addPendingMedia(type, blob) {
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    pendingMedia.push({ type, blob, url });
    renderPendingMedia();
    updateSaveState();
  }

  function removePendingMedia(index) {
    const item = pendingMedia[index];
    if (item && item.url) {
      URL.revokeObjectURL(item.url);
      objectUrls = objectUrls.filter((u) => u !== item.url);
    }
    pendingMedia.splice(index, 1);
    renderPendingMedia();
    updateSaveState();
  }

  function renderPendingMedia() {
    if (pendingMedia.length === 0) {
      mediaPreview.hidden = true;
      mediaPreview.innerHTML = '';
      return;
    }
    mediaPreview.hidden = false;
    mediaPreview.innerHTML = '';
    pendingMedia.forEach((item, index) => {
      const wrap = document.createElement('div');
      wrap.className = 'media-item';

      if (item.type === 'image') {
        const img = document.createElement('img');
        img.src = item.url;
        img.alt = '照片';
        img.addEventListener('click', () => openViewer(item));
        wrap.appendChild(img);
      } else {
        const vid = document.createElement('video');
        vid.src = item.url;
        vid.muted = true;
        vid.preload = 'metadata';
        vid.addEventListener('click', () => openViewer(item));
        wrap.appendChild(vid);
        const badge = document.createElement('span');
        badge.className = 'media-badge';
        badge.textContent = '视频';
        wrap.appendChild(badge);
      }

      const rm = document.createElement('button');
      rm.className = 'media-remove';
      rm.textContent = '×';
      rm.setAttribute('aria-label', '移除');
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        removePendingMedia(index);
      });
      wrap.appendChild(rm);

      mediaPreview.appendChild(wrap);
    });
  }

  /* ---------- 保存状态控制 ---------- */
  function updateSaveState() {
    const hasText = diaryText.value.trim().length > 0;
    const hasMedia = pendingMedia.length > 0;
    btnSave.disabled = !(hasText || hasMedia);
  }

  diaryText.addEventListener('input', updateSaveState);

  /* ---------- 保存记录 ---------- */
  btnSave.addEventListener('click', async () => {
    const hasText = diaryText.value.trim().length > 0;
    const hasMedia = pendingMedia.length > 0;
    if (!hasText && !hasMedia) return;

    const record = {
      createdAt: Date.now(),
      text: diaryText.value.trim(),
      media: pendingMedia.map((m) => ({ type: m.type, blob: m.blob }))
    };

    btnSave.disabled = true;
    btnSave.textContent = '保存中…';

    try {
      await addRecord(record);
      // 重置表单
      diaryText.value = '';
      pendingMedia = [];
      objectUrls.forEach((u) => URL.revokeObjectURL(u));
      objectUrls = [];
      renderPendingMedia();
      updateSaveTime();
      updateSaveState();
      btnSave.textContent = '已保存';
      setTimeout(() => { btnSave.textContent = '保存记录'; }, 1500);
    } catch (err) {
      alert('保存失败：' + (err.message || err));
      btnSave.textContent = '保存记录';
      updateSaveState();
    }
  });

  function updateSaveTime() {
    // 让保存后时间戳保持当前时刻
    currentTime.textContent = formatDateTime(Date.now());
  }

  /* ---------- 历史记录渲染 ---------- */
  async function renderHistory() {
    let records;
    try {
      records = await getAllRecords();
    } catch (err) {
      historyList.innerHTML = '<p class="empty-hint">读取记录失败</p>';
      return;
    }

    if (records.length === 0) {
      historyList.innerHTML = '<p class="empty-hint">还没有记录，去写下第一条吧</p>';
      return;
    }

    historyList.innerHTML = '';
    records.forEach((rec) => {
      historyList.appendChild(buildRecordCard(rec));
    });
  }

  function buildRecordCard(rec) {
    const card = document.createElement('article');
    card.className = 'record-card';

    // 头部：日期 + 时间
    const head = document.createElement('div');
    head.className = 'record-head';
    const dateEl = document.createElement('span');
    dateEl.className = 'record-date';
    dateEl.textContent = formatDate(rec.createdAt);
    const timeEl = document.createElement('span');
    timeEl.className = 'record-time';
    timeEl.textContent = formatTime(rec.createdAt);
    head.appendChild(dateEl);
    head.appendChild(timeEl);
    card.appendChild(head);

    // 文字
    if (rec.text) {
      const textEl = document.createElement('p');
      textEl.className = 'record-text collapsed';
      textEl.textContent = rec.text;
      card.appendChild(textEl);
    }

    // 媒体缩略图
    if (rec.media && rec.media.length > 0) {
      const mediaWrap = document.createElement('div');
      mediaWrap.className = 'record-media';
      rec.media.forEach((m) => {
        const url = URL.createObjectURL(m.blob);
        const item = document.createElement('div');
        item.className = 'media-item';
        if (m.type === 'image') {
          const img = document.createElement('img');
          img.src = url;
          img.alt = '照片';
          img.addEventListener('click', () => openViewer(m));
          item.appendChild(img);
        } else {
          const vid = document.createElement('video');
          vid.src = url;
          vid.muted = true;
          vid.preload = 'metadata';
          vid.addEventListener('click', () => openViewer(m));
          item.appendChild(vid);
          const badge = document.createElement('span');
          badge.className = 'media-badge';
          badge.textContent = '视频';
          item.appendChild(badge);
        }
        mediaWrap.appendChild(item);
      });
      card.appendChild(mediaWrap);
    }

    // 操作区
    const actions = document.createElement('div');
    actions.className = 'record-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger';
    delBtn.textContent = '删除此条记录';
    delBtn.addEventListener('click', async () => {
      if (!confirm('确定删除这条记录吗？')) return;
      delBtn.disabled = true;
      delBtn.textContent = '删除中…';
      try {
        await deleteRecord(rec.id);
        card.remove();
        // 检查是否清空
        if (historyList.children.length === 0) {
          historyList.innerHTML = '<p class="empty-hint">还没有记录，去写下第一条吧</p>';
        }
      } catch (err) {
        alert('删除失败：' + (err.message || err));
        delBtn.disabled = false;
        delBtn.textContent = '删除此条记录';
      }
    });
    actions.appendChild(delBtn);
    card.appendChild(actions);

    // 点击展开/折叠
    card.addEventListener('click', (e) => {
      if (e.target.closest('.record-actions') || e.target.closest('.media-item')) return;
      card.classList.toggle('expanded');
    });

    return card;
  }

  /* ---------- 媒体查看层 ---------- */
  function openViewer(media) {
    viewerContent.innerHTML = '';
    const url = URL.createObjectURL(media.blob);
    if (media.type === 'image') {
      const img = document.createElement('img');
      img.src = url;
      viewerContent.appendChild(img);
    } else {
      const vid = document.createElement('video');
      vid.src = url;
      vid.controls = true;
      vid.autoplay = true;
      viewerContent.appendChild(vid);
    }
    viewer.hidden = false;
    // 关闭时释放
    viewer._url = url;
  }

  function closeViewer() {
    viewer.hidden = true;
    viewerContent.innerHTML = '';
    if (viewer._url) {
      URL.revokeObjectURL(viewer._url);
      viewer._url = null;
    }
  }

  viewerClose.addEventListener('click', closeViewer);
  viewer.addEventListener('click', (e) => {
    if (e.target === viewer) closeViewer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !viewer.hidden) closeViewer();
  });

  /* ---------- Service Worker 注册 ---------- */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  /* ---------- 离开时清理摄像头 ---------- */
  window.addEventListener('beforeunload', () => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  });

  /* ---------- 初始状态 ---------- */
  updateSaveState();
})();
