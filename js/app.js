/* ============================================================
 * app.js — 智能播放器主逻辑
 * 功能：本地视频/图片导入、播放/暂停、倍速、选集(可自定义集数)、
 *       剧集名窄条、外框颜色自定义、网盘/网络链接播放、画面比例
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 全局状态 ---------- */
  const STORE_KEY = 'smart_player_config_v1';
  const $ = (id) => document.getElementById(id);

  let state = {
    seriesName: '春风渡（未删减版）',
    totalEpisodes: 12,
    accentColor: '#ff3b30',
    ratio: 'auto',
    speed: 1,
    currentEp: 1,
    epDisplayMode: 'full',  // 'full'=显示集数+名字, 'num'=只显示集数
    danmakuInputVisible: true,  // 弹幕输入框是否显示
    danmakuMode: 'scroll',  // 弹幕模式：scroll=滚动飘过, fixed=固定不动
    licenseServerEnabled: true,  // 是否启用服务端验证（默认启用）
    licenseServer: '/api',  // 授权服务器地址（Netlify反向代理，同域名无跨域问题）
    eps: {}          // { N: { title:'', remoteUrl:'' } }
  };

  const els = {};
  let localVideos = new Set();   // 已有本地视频的集号
  let currentObjectUrl = null;
  let hls = null;
  let flvPlayer = null;
  let controlsTimer = null;
  let isSeeking = false;
  let pendingVideoFile = null;   // 当前导入的视频（用于兼容转码）
  let isActivated = false;

  /* ---------- 工具 ---------- */
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        state = Object.assign(state, s);
        if (!state.eps) state.eps = {};
      }
    } catch (e) {}
    // 范围保护：集数至少为1
    if (!state.totalEpisodes || state.totalEpisodes < 1) state.totalEpisodes = 12;
    if (!state.currentEp || state.currentEp < 1) state.currentEp = 1;
    if (state.currentEp > state.totalEpisodes) state.currentEp = state.totalEpisodes;
  }
  function fmtTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    const h = Math.floor(m / 60);
    if (h > 0) {
      return String(h).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  function applyAccent() {
    document.documentElement.style.setProperty('--accent', state.accentColor);
    els.playerFrame.style.borderColor = state.accentColor;
    els.playerFrame.style.boxShadow = '0 0 24px -6px ' + state.accentColor;
    els.brandDot.style.background = state.accentColor;
    els.brandDot.style.boxShadow = '0 0 12px ' + state.accentColor;
  }
  function epTitleText(ep) {
    const custom = state.eps[ep] && state.eps[ep].title;
    if (custom) return custom;
    return state.seriesName + ' · 第 ' + ep + ' 集';
  }
  function isM3u8(url) { return /\.m3u8($|\?)/i.test(url) || /m3u8/i.test(url); }
  function isFlv(url) { return /\.flv($|\?)/i.test(url); }

  /* ---------- 销毁媒体流 ---------- */
  function destroyMedia() {
    if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (flvPlayer) { try { flvPlayer.destroy(); } catch (e) {} flvPlayer = null; }
    els.video.removeAttribute('src');
    els.video.load();
  }

  /* ---------- 播放网络/直链 ---------- */
  // 检测是否为网盘分享页面（无法直接解析）
  function isCloudPage(url) {
    return /pan\.baidu\.com|pan\.quark\.cn|aliyundrive\.com|alipan\.com|pan\.xunlei\.com|www\.123pan\.com|115\.com|pan\.weiyun\.com|cloud\.189\.cn|uc\.com|wenshushu/i.test(url);
  }

  function playRemoteUrl(url) {
    destroyMedia();
    els.posterLayer.hidden = true;
    els.posterEmpty.hidden = true;
    if (isCloudPage(url)) {
      showPosterEmpty('这是网盘「分享页面」，播放器无法直接解析登录鉴权页面。<br>请在网盘内点「下载/获取直链」，复制 .mp4 或 .m3u8 结尾的可直链地址后重试');
      return;
    }
    if (isM3u8(url) && window.Hls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true });
      hls.loadSource(url);
      hls.attachMedia(els.video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        els.video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (evt, data) => {
        if (data.fatal) showPosterEmpty('HLS 加载失败：可能链接需要鉴权、已失效或服务器禁止跨域访问');
      });
    } else if (isFlv(url) && window.flvjs && flvjs.isSupported()) {
      flvPlayer = flvjs.createPlayer({ type: 'flv', url: url });
      flvPlayer.attachMediaElement(els.video);
      flvPlayer.load();
      flvPlayer.play();
    } else {
      els.video.src = url;
      els.video.play().catch(() => showPosterEmpty('无法播放该链接。<br>请确认是 .mp4 / .m3u8 结尾的可直接访问视频直链'));
    }
    els.loading.hidden = true;
  }

  /* ---------- 播放本地 IndexedDB 视频 ---------- */
  async function playLocalVideo(ep) {
    // 优先使用临时 URL（导入后立即播放，后台写入 IndexedDB 时）
    const epData = state.eps[ep] || {};
    if (epData._tempUrl) {
      const oldUrl = currentObjectUrl;
      els.posterLayer.hidden = true;
      els.posterEmpty.hidden = true;
      currentObjectUrl = epData._tempUrl;
      els.video.src = currentObjectUrl;
      els.video.play().catch(() => {});
      // 新视频播放后再释放旧 URL，避免画面闪烁
      if (oldUrl && oldUrl !== currentObjectUrl) {
        setTimeout(() => { try { URL.revokeObjectURL(oldUrl); } catch (e) {} }, 1000);
      }
      return;
    }
    const key = 'video_' + ep;
    const blob = await PlayerDB.get(key);
    if (!blob) { showPosterEmpty('第 ' + ep + ' 集暂无视频'); return; }
    // 先准备好新视频 URL，再切换画面，避免黑屏闪烁
    const newUrl = URL.createObjectURL(blob);
    const oldUrl = currentObjectUrl;
    els.posterLayer.hidden = true;
    els.posterEmpty.hidden = true;
    currentObjectUrl = newUrl;
    els.video.src = newUrl;
    els.video.play().catch(() => {});
    // 新视频播放后再释放旧 URL 和销毁 hls/flv，避免画面抖动
    if (oldUrl && oldUrl !== newUrl) {
      setTimeout(() => { try { URL.revokeObjectURL(oldUrl); } catch (e) {} }, 1000);
    }
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (flvPlayer) { try { flvPlayer.destroy(); } catch (e) {} flvPlayer = null; }
  }

  /* ---------- 显示封面 / 空提示 ---------- */
  async function showCoverOrEmpty(ep) {
    destroyMedia();
    els.posterLayer.hidden = false;
    const coverKey = 'cover_' + ep;
    const blob = await PlayerDB.get(coverKey);
    if (blob) {
      const imgUrl = URL.createObjectURL(blob);
      els.posterImg.src = imgUrl;
      els.posterImg.hidden = false;
      els.posterEmpty.hidden = true;
      setTimeout(() => URL.revokeObjectURL(imgUrl), 1000);
    } else {
      els.posterImg.hidden = true;
      els.posterImg.removeAttribute('src');
      els.posterEmpty.hidden = false;
    }
    els.posterEmptyText.innerHTML = '第 ' + ep + ' 集暂无视频<br>点击「导入」添加视频或输入网盘链接';
    els.curTime.textContent = '00:00';
    els.durTime.textContent = '00:00';
    els.seek.value = 0;
  }

  function showPosterEmpty(msg) {
    els.posterLayer.hidden = false;
    els.posterImg.hidden = true;
    els.posterEmpty.hidden = false;
    els.posterEmptyText.innerHTML = (msg || '第 ' + state.currentEp + ' 集暂无视频') + '<br>点击「导入」或输入网盘链接';
  }

  /* ---------- 播放指定集 ---------- */
  async function playEpisode(ep) {
    state.currentEp = ep;
    const epData = state.eps[ep] || {};
    // 更新顶部信息栏（剧名 + 集数分开显示）
    if (els.titleSeriesName) els.titleSeriesName.textContent = state.seriesName;
    const customTitle = epData.title;
    els.titleBarText.textContent = customTitle ? customTitle : ('第' + ep + '集');
    if (epData.remoteUrl) {
      playRemoteUrl(epData.remoteUrl);
    } else if (localVideos.has(ep)) {
      await playLocalVideo(ep);
    } else {
      await showCoverOrEmpty(ep);
    }
    renderEpisodeList();
    // 更新选集面板导入按钮的集数显示
    if (els.btnEpImport && !els.episodePanel.hidden && els.episodePanel.classList.contains('show')) {
      els.btnEpImport.textContent = '第' + ep + '集';
    }
    saveState();
  }

  /* ---------- 选集列表渲染 ---------- */
  function renderEpisodeList() {
    if (!els.epList) return;
    els.epList.innerHTML = '';
    const count = Math.max(1, parseInt(state.totalEpisodes, 10) || 12);
    for (let i = 1; i <= count; i++) {
      try {
        const d = document.createElement('div');
        d.className = 'ep-item' + (i === state.currentEp ? ' active' : '') + (hasVideo(i) ? ' has-video' : '') + (state.epDisplayMode === 'num' ? ' num-only' : '');
        // 集数
        const num = document.createElement('span');
        num.className = 'ep-num';
        num.textContent = '第' + i + '集';
        d.appendChild(num);
        // 集名（非纯数字模式）
        if (state.epDisplayMode !== 'num') {
          const name = document.createElement('span');
          name.className = 'ep-name';
          name.textContent = (state.eps[i] && state.eps[i].title) || '';
          d.appendChild(name);
          const edit = document.createElement('span');
          edit.className = 'ep-edit';
          edit.textContent = '✎';
          edit.addEventListener('click', (e) => {
            e.stopPropagation();
            renameEpisode(i);
          });
          d.appendChild(edit);
        }
        d.addEventListener('click', () => {
          playEpisode(i);
          // 选集后自动关闭选集面板
          closeEpisodePanel();
        });
        els.epList.appendChild(d);
      } catch (e) {}
    }
    try { renderNetEpSelect(); } catch (e) {}
  }

  /* ---------- 选集面板开关 ---------- */
  function openEpisodePanel() {
    els.episodePanel.classList.add('show');
    els.epMask.hidden = false;
    showControls();
    // 更新导入按钮显示当前集数
    if (els.btnEpImport) els.btnEpImport.textContent = '第' + state.currentEp + '集';
    // 滚动到当前集
    setTimeout(() => {
      const activeItem = els.epList.querySelector('.ep-item.active');
      if (activeItem) activeItem.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 100);
  }
  function closeEpisodePanel() {
    els.episodePanel.classList.remove('show');
    els.epMask.hidden = true;
    showControls(); // 重置控制栏隐藏计时器
  }
  function toggleEpisodePanel() {
    if (els.episodePanel.classList.contains('show')) closeEpisodePanel();
    else openEpisodePanel();
  }
  function applyDanmakuInputVisibility() {
    const row = document.querySelector('.danmaku-row');
    if (row) row.style.display = state.danmakuInputVisible ? '' : 'none';
  }
  function renameEpisode(ep) {
    const cur = (state.eps[ep] && state.eps[ep].title) || '';
    const val = prompt('修改第 ' + ep + ' 集的名字：', cur);
    if (val === null) return;
    if (!state.eps[ep]) state.eps[ep] = {};
    const t = val.trim();
    if (t) state.eps[ep].title = t;
    else delete state.eps[ep].title;
    saveState();
    renderEpisodeList();
    if (ep === state.currentEp) {
      const t = (state.eps[ep] && state.eps[ep].title) || ('第' + ep + '集');
      els.titleBarText.textContent = t;
    }
  }
  function hasVideo(ep) {
    const d = state.eps[ep];
    if (d && d.remoteUrl) return true;
    return localVideos.has(ep);
  }

  /* ---------- 导入 ---------- */
  async function importVideoTo(ep, file) {
    els.loading.hidden = false;
    const isPWA = !window.playerAPI && !window.androidAPI;
    try {
      // 获取文件真实路径（Electron / 安卓）
      let filePath = null;
      if (file.path) filePath = file.path;
      else if (window.playerAPI && window.playerAPI.getFilePath) filePath = window.playerAPI.getFilePath(file);
      else if (window.__lastImportedPath) { filePath = window.__lastImportedPath; window.__lastImportedPath = null; }
      // 记录当前视频文件（含路径与编码，供兼容转码使用）
      pendingVideoFile = { ep: ep, file: file, path: filePath, isHevc: false };
      // HEVC 编码检测：仅在有转码能力的环境（Electron/安卓）执行，PWA 跳过节省时间
      if (!isPWA) {
        try { pendingVideoFile.isHevc = await detectHevc(file); } catch (e) {}
      }
      // PWA 环境：先创建本地 URL 立即播放，再后台写入 IndexedDB（减少等待）
      if (isPWA) {
        const objectUrl = URL.createObjectURL(file);
        // 立即标记为有视频并播放
        localVideos.add(ep);
        if (!state.eps[ep]) state.eps[ep] = {};
        delete state.eps[ep].remoteUrl;
        state.eps[ep]._tempUrl = objectUrl;
        saveState();
        await playEpisode(ep);
        // 后台异步写入 IndexedDB
        (async () => {
          try {
            await PlayerDB.put('video_' + ep, file);
            // 写入完成后清除临时 URL，后续播放从 IndexedDB 读取
            if (state.eps[ep] && state.eps[ep]._tempUrl === objectUrl) {
              delete state.eps[ep]._tempUrl;
              saveState();
            }
          } catch (e) {
            console.warn('视频后台保存失败：', e);
          }
        })();
      } else {
        // Electron / 安卓：正常写入 IndexedDB 后播放
        await PlayerDB.put('video_' + ep, file);
        localVideos.add(ep);
        if (!state.eps[ep]) state.eps[ep] = {};
        delete state.eps[ep].remoteUrl;
        saveState();
        els.convertTip.hidden = true;
        // 检测到 HEVC 且有转码能力时，直接显示一键转码提示
        if (pendingVideoFile.isHevc && (window.playerAPI || window.androidAPI)) {
          await playEpisode(ep);
          setTimeout(() => {
            if (els.video.error || els.video.videoWidth === 0) {
              els.convertTip.hidden = false;
              els.posterLayer.hidden = false;
              els.posterImg.hidden = true;
              els.posterEmpty.hidden = true;
            }
          }, 2000);
        } else {
          await playEpisode(ep);
        }
      }
    } catch (e) {
      alert('视频保存失败：' + e.message);
    }
    els.loading.hidden = true;
  }

  // 检测 MP4 是否为 HEVC/H.265（采样文件头/中/尾的 sample entry 标记，大文件也快）
  async function detectHevc(file) {
    const read = async (start, end) => {
      try {
        if (start < 0) start = 0;
        if (end > file.size) end = file.size;
        if (start >= end) return '';
        const buf = await file.slice(start, end).arrayBuffer();
        return new TextDecoder('latin1').decode(buf);
      } catch (e) { return ''; }
    };
    const CHUNK = 1024 * 1024; // 每块 1MB
    const parts = [];
    parts.push(await read(0, Math.min(CHUNK * 2, file.size)));           // 头部 2MB
    if (file.size > CHUNK * 4) {
      const mid = Math.floor(file.size / 2);
      parts.push(await read(mid - CHUNK / 2, mid + CHUNK / 2));           // 中间 1MB
    }
    if (file.size > CHUNK * 2) {
      parts.push(await read(file.size - CHUNK * 2, file.size));            // 尾部 2MB
    }
    const s = parts.join('').toLowerCase();
    if (s.includes('hvc1') || s.includes('hev1')) return true;   // HEVC
    return false;
  }

  // 一键转码播放（Electron 内置 ffmpeg；HEVC → H.264）
  async function convertAndPlay() {
    if (!pendingVideoFile) return;
    // 安卓一键转码（ffmpeg-kit）
    if (window.androidAPI && window.androidAPI.supportTranscode && window.androidAPI.supportTranscode()) {
      if (!pendingVideoFile.path) {
        alert('无法获取文件路径，请重新导入视频');
        return;
      }
      els.convertTip.hidden = true;
      els.loading.hidden = false;
      const callbackId = 'cb_' + Date.now();
      window.__androidTranscodeCallback = function(cbId, outputPath) {
        if (cbId !== callbackId) return;
        els.loading.hidden = true;
        if (outputPath) {
          destroyMedia();
          els.video.src = 'file://' + outputPath;
          els.video.play().catch(() => {});
        } else {
          showPosterEmpty('转码失败，请检查视频文件或改用剪映转码为 H.264');
        }
      };
      try {
        window.androidAPI.convertVideo(pendingVideoFile.path, String(pendingVideoFile.ep), callbackId);
      } catch (e) {
        els.loading.hidden = true;
        showPosterEmpty('转码失败：' + (e && e.message ? e.message : e));
      }
      return;
    }
    // Electron 一键转码
    if (!window.playerAPI || !pendingVideoFile.path) {
      alert('当前环境不支持内置转码。请使用剪映等工具将该视频转为 H.264 编码（MP4）后重新导入。');
      return;
    }
    els.convertTip.hidden = false;
    els.loading.hidden = true;
    // 转码中隐藏弹幕输入框，显示进度
    document.body.classList.add('is-converting');
    const convertText = document.getElementById('convertText');
    const convertProgress = document.getElementById('convertProgress');
    const convertProgressBar = document.getElementById('convertProgressBar');
    const convertProgressText = document.getElementById('convertProgressText');
    const btnConvert = document.getElementById('btnConvert');
    if (convertText) convertText.textContent = '正在转码中，请稍候…（HEVC/H.265 → H.264）';
    if (btnConvert) { btnConvert.hidden = true; btnConvert.disabled = true; }
    if (convertProgress) convertProgress.hidden = false;
    if (convertProgressText) convertProgressText.hidden = false;
    try {
      const url = await window.playerAPI.convertVideo(pendingVideoFile.path, pendingVideoFile.ep, (percent) => {
        if (convertProgressBar) convertProgressBar.style.width = percent + '%';
        if (convertProgressText) convertProgressText.textContent = '转码进度：' + percent + '%';
      });
      // 转码完成，恢复界面
      document.body.classList.remove('is-converting');
      if (convertProgress) convertProgress.hidden = true;
      if (convertProgressText) convertProgressText.hidden = true;
      if (url) {
        els.convertTip.hidden = true;
        destroyMedia();
        // 转码完成后必须隐藏封面层，否则会覆盖视频画面
        els.posterLayer.hidden = true;
        els.posterImg.hidden = true;
        els.posterEmpty.hidden = true;
        els.video.hidden = false;
        els.video.src = url;
        els.video.play().catch(() => {});
      } else {
        if (convertText) convertText.textContent = '转码失败，请检查视频文件或改用剪映转码为 H.264';
        if (btnConvert) { btnConvert.hidden = false; btnConvert.disabled = false; btnConvert.textContent = '重试转码'; }
      }
    } catch (e) {
      document.body.classList.remove('is-converting');
      if (convertProgress) convertProgress.hidden = true;
      if (convertProgressText) convertProgressText.hidden = true;
      if (convertText) convertText.textContent = '转码失败：' + (e && e.message ? e.message : e);
      if (btnConvert) { btnConvert.hidden = false; btnConvert.disabled = false; }
    }
  }
  async function importCoverTo(ep, file) {
    try {
      await PlayerDB.put('cover_' + ep, file);
      await showCoverOrEmpty(ep);
      alert('封面已设置到第 ' + ep + ' 集');
    } catch (e) {
      alert('封面保存失败：' + e.message);
    }
  }

  /* ---------- 控制栏显示/隐藏 ---------- */
  function showControls() {
    els.controls.classList.add('show');
    els.titleBar.classList.add('show');
    clearTimeout(controlsTimer);
    // 选集展开或更多菜单展开时，不自动隐藏
    const epOpen = els.episodePanel && els.episodePanel.classList.contains('show');
    const moreOpen = els.moreMenu && !els.moreMenu.hidden;
    if (!els.video.paused && !epOpen && !moreOpen) {
      controlsTimer = setTimeout(() => {
        els.controls.classList.remove('show');
        els.titleBar.classList.remove('show');
      }, 2600);
    }
  }
  function hideControls() {
    els.controls.classList.remove('show');
    els.titleBar.classList.remove('show');
  }

  /* ---------- 更新播放按钮状态 ---------- */
  function updatePlayBtn() {
    els.icPause.hidden = els.video.paused;
    els.icPlay.hidden = !els.video.paused;
  }

  /* ---------- 弹幕 ---------- */
  const danmakuTracks = 6;
  const trackBusy = new Array(danmakuTracks).fill(0);
  function sendDanmaku(text) {
    text = String(text || '').trim();
    if (!text) return;
    const layer = els.danmakuLayer;
    if (!layer) return;
    const item = document.createElement('div');
    item.className = 'danmaku-item';
    item.textContent = text;
    const mode = state.danmakuMode || 'scroll';

    if (mode === 'fixed') {
      // 固定弹幕：屏幕中间不动，一直显示不消失
      item.classList.add('fixed');
      item.style.top = '30%';
      item.style.animationDuration = '1s';  // 只做淡入，不淡出
      layer.appendChild(item);
      // 限制最多显示5条固定弹幕，超过则移除最早的
      const fixedItems = layer.querySelectorAll('.danmaku-item.fixed');
      if (fixedItems.length > 5) {
        fixedItems[0].remove();
      }
    } else {
      // 滚动弹幕：从右向左缓慢飘过（速度调慢，10-15秒）
      const now = Date.now();
      let track = 0;
      for (let i = 0; i < danmakuTracks; i++) {
        if (trackBusy[i] < now) { track = i; break; }
      }
      trackBusy[track] = now + 3000;
      const layerH = layer.clientHeight || 300;
      const top = 20 + track * Math.floor((layerH - 60) / danmakuTracks);
      item.style.top = top + 'px';
      item.style.left = '100%';
      const dur = 40 + Math.random() * 20;  // 缓慢飘过：40-60秒
      item.style.animationDuration = dur + 's';
      layer.appendChild(item);
      setTimeout(() => { if (item.parentNode) item.parentNode.removeChild(item); }, dur * 1000 + 200);
    }
  }

  /* ---------- 缓存元素 ---------- */
  function cacheElements() {
    ['playerFrame','video','posterLayer','posterImg','posterEmpty','posterEmptyText','titleBar','titleBarText','titleSeriesName',
     'centerPlay','loading','controls','btnPlay','icPlay','icPause','seek','curTime','durTime',
     'btnNext','btnFull','btnEpToggle','epMask','btnEpClose',
     'btnMore','moreMenu','mmLoop','mmLoopSwitch','mmDanmaku','mmDanmakuSwitch',
     'epList','episodePanel','btnEpSet','btnEpImport','hintBar','videoZoomWrap','posterZoomWrap','btnClearAll',
     'modalSettings','setSeriesName','setEpCount','setEpTitle','setColor','colorPreview','setRatio','setSpeed','setShowPauseIcon','setEpDisplayMode','setDanmakuInput','setDanmakuMode','setLicenseServerEnabled','setLicenseServer','btnSaveSettings','licenseInfo',
     'modalNetwork','netUrl','netEp','netTip','btnNetClear','btnNetSave',
     'modalEpSet','quickEpCount','btnQuickEpSave','fileVideo','fileImage','brandDot','videoStage',
     'convertTip','btnConvert','activateMask','actCode','btnActivate','actMsg','actExp','actRemember',
     'danmakuLayer','danmakuInput','btnDanmakuSend','btnBack','btnTitleFull','vol'].forEach(id => { els[id] = $(id); });
  }

  /* ---------- 初始化 ---------- */
  async function init() {
    loadState();

    // 隐藏 Netlify 免费版徽章（JavaScript 强制隐藏，定时执行确保动态注入的也被隐藏）
    function hideNetlifyBadge() {
      try {
        // 方法1：隐藏所有包含 "Powered by Netlify" 文字的元素
        const allElements = document.querySelectorAll('*');
        allElements.forEach(el => {
          if (el.children.length === 0 && el.textContent && el.textContent.trim().toLowerCase().includes('powered by netlify')) {
            el.style.display = 'none';
            el.style.visibility = 'hidden';
            el.style.opacity = '0';
            if (el.parentElement) {
              el.parentElement.style.display = 'none';
            }
          }
        });
        // 方法2：隐藏所有 href 包含 netlify.com 的元素
        document.querySelectorAll('a[href*="netlify.com"], [class*="netlify"], [id*="netlify"]').forEach(el => {
          el.style.display = 'none';
        });
        // 方法3：隐藏固定在右下角的小元素（Netlify 徽章通常在这个位置）
        document.querySelectorAll('[style*="fixed"], [style*="position:fixed"]').forEach(el => {
          try {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.width < 250 && rect.height > 0 && rect.height < 120 &&
                rect.bottom > window.innerHeight - 150 && rect.right > window.innerWidth - 250) {
              el.style.display = 'none';
            }
          } catch(e) {}
        });
      } catch(e) {}
    }
    hideNetlifyBadge();
    setInterval(hideNetlifyBadge, 500);

    // PWA 环境下强制启用服务端验证，忽略 localStorage 中的旧设置
    // （Electron 有 window.playerAPI，安卓有 window.androidAPI，PWA 都没有）
    const isPWA = !window.playerAPI && !window.androidAPI;
    if (isPWA) {
      state.licenseServerEnabled = true;
      state.licenseServer = '/api';
    }

    // 收集本地已有视频
    const keys = await PlayerDB.getAllKeys();
    keys.forEach(k => { if (typeof k === 'string' && k.startsWith('video_')) localVideos.add(Number(k.slice(6))); });

    // 应用主题色
    applyAccent();

    // 渲染选集
    renderEpisodeList();
    if (els.titleSeriesName) els.titleSeriesName.textContent = state.seriesName;
    els.titleBarText.textContent = '第' + state.currentEp + '集';
    els.setSeriesName.value = state.seriesName;
    els.setEpCount.value = state.totalEpisodes;
    els.setColor.value = state.accentColor;
    els.colorPreview.textContent = state.accentColor;
    els.setRatio.value = state.ratio;
    els.setSpeed.value = String(state.speed);
    if (els.setShowPauseIcon) els.setShowPauseIcon.value = state.showPauseIcon ? '1' : '0';
    if (state.eps[state.currentEp] && state.eps[state.currentEp].title) {
      els.setEpTitle.value = state.eps[state.currentEp].title;
    }
    els.video.playbackRate = state.speed;
    applyRatio();
    // 同步更多菜单中的倍速/比例选中态
    document.querySelectorAll('.mm-speed-item').forEach(x => x.classList.toggle('active', parseFloat(x.dataset.s) === state.speed));
    document.querySelectorAll('.mm-ratio-item').forEach(x => x.classList.toggle('active', x.dataset.r === state.ratio));

    applyDanmakuInputVisibility();
    // 播放当前集
    await playEpisode(state.currentEp);
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    // 播放 / 暂停
    els.btnPlay.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePlay();
    });
    els.centerPlay.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePlay();
    });
    // 不阻止 video click 冒泡：点击视频区域也能触发播放/暂停

    function togglePlay() {
      if (!els.video.src && !currentObjectUrl) {
        return;
      }
      if (els.video.paused) { els.video.play().catch(() => {}); }
      else { els.video.pause(); }
      // 立即切换图标（不等待 play/pause 事件，确保安卓等环境及时更新）
      setTimeout(updatePlayBtn, 50);
    }

    // 视频事件（顶部剧集名条常驻显示，控制条播放时自动隐藏、双击唤出）
    els.video.addEventListener('play', () => {
      els.centerPlay.hidden = true;
      updatePlayBtn(); showControls();
    });
    els.video.addEventListener('pause', () => {
      updatePlayBtn();
      if ((els.video.src || currentObjectUrl) && state.showPauseIcon) els.centerPlay.hidden = false;
      else els.centerPlay.hidden = true;
    });
    els.video.addEventListener('ended', () => {
      els.centerPlay.hidden = false;
      if (els.video.loop) { els.video.play(); }
    });
    els.video.addEventListener('waiting', () => { els.loading.hidden = false; });
    els.video.addEventListener('playing', () => { els.loading.hidden = true; });
    els.video.addEventListener('loadeddata', () => { els.loading.hidden = true; });
    els.video.addEventListener('error', () => {
      els.loading.hidden = true;
      if (!els.video.src) return;
      // 播放失败：电脑版或安卓版有 ffmpeg 转码能力，提供一键转码
      if ((window.playerAPI && window.playerAPI.convertVideo || window.androidAPI && window.androidAPI.supportTranscode) && pendingVideoFile && pendingVideoFile.file) {
        els.convertTip.hidden = false;
        els.posterLayer.hidden = false;
        els.posterImg.hidden = true;
        els.posterEmpty.hidden = true;
        return;
      }
      // 网盘下载的 HEVC 等编码可能无法直接播放 → 提供一键转码
      if ((window.playerAPI || window.androidAPI) && pendingVideoFile && pendingVideoFile.isHevc) {
        els.convertTip.hidden = false;
        els.posterLayer.hidden = false;
        els.posterImg.hidden = true;
        els.posterEmpty.hidden = true;
        return;
      }
      showPosterEmpty('视频加载失败');
    });

    // 双击画面：切换 CSS 全屏（带选集和控制栏，不是视频原生全屏）
    els.videoStage.addEventListener('dblclick', () => {
      toggleFullscreen();
      els.controls.classList.add('show');
      showControls();
    });
    // 单击画面：切换播放/暂停
    let lastClickTime = 0;
    els.videoStage.addEventListener('click', (e) => {
      if (e.target.closest('.more-menu') || e.target.closest('.episode-panel')) return;
      const now = Date.now();
      if (now - lastClickTime < 300) return; // 双击不再触发单击
      lastClickTime = now;
      if (els.video.src || currentObjectUrl) togglePlay();
      else showControls();
    });

    // 进度
    els.video.addEventListener('timeupdate', () => {
      if (isSeeking) return;
      if (els.video.duration) {
        els.seek.value = Math.round(els.video.currentTime / els.video.duration * 1000);
      }
      els.curTime.textContent = fmtTime(els.video.currentTime);
      els.durTime.textContent = fmtTime(els.video.duration);
    });
    els.video.addEventListener('loadedmetadata', () => {
      els.durTime.textContent = fmtTime(els.video.duration);
    });
    els.seek.addEventListener('input', () => {
      isSeeking = true;
      if (els.video.duration) {
        const t = els.seek.value / 1000 * els.video.duration;
        els.curTime.textContent = fmtTime(t);
      }
    });
    els.seek.addEventListener('change', () => {
      if (els.video.duration) els.video.currentTime = els.seek.value / 1000 * els.video.duration;
      isSeeking = false;
    });

    // 更多菜单
    els.btnMore.addEventListener('click', (e) => {
      e.stopPropagation();
      els.moreMenu.hidden = !els.moreMenu.hidden;
      if (!els.moreMenu.hidden) showControls();
    });
    // 点击其他地方关闭更多菜单
    document.addEventListener('click', (e) => {
      if (!els.moreMenu.hidden && !e.target.closest('.more-wrap')) {
        els.moreMenu.hidden = true;
      }
    });
    // 倍速（更多菜单）
    document.querySelectorAll('.mm-speed-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        state.speed = parseFloat(item.dataset.s);
        els.video.playbackRate = state.speed;
        document.querySelectorAll('.mm-speed-item').forEach(x => x.classList.toggle('active', x === item));
        saveState();
      });
    });
    // 比例（更多菜单）
    document.querySelectorAll('.mm-ratio-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        state.ratio = item.dataset.r;
        applyRatio();
        document.querySelectorAll('.mm-ratio-item').forEach(x => x.classList.toggle('active', x === item));
        saveState();
      });
    });
    // 循环（更多菜单）
    els.mmLoop.addEventListener('click', (e) => {
      e.stopPropagation();
      els.video.loop = !els.video.loop;
      els.mmLoopSwitch.classList.toggle('active', els.video.loop);
    });
    // 弹幕显示（更多菜单）
    els.mmDanmaku.addEventListener('click', (e) => {
      e.stopPropagation();
      const on = els.mmDanmakuSwitch.classList.toggle('active');
      els.danmakuLayer.style.display = on ? '' : 'none';
    });
    // 音量（更多菜单）
    els.vol.addEventListener('input', () => {
      els.video.volume = els.vol.value / 100;
    });

    // 下一集
    els.btnNext.addEventListener('click', () => {
      if (state.currentEp < state.totalEpisodes) playEpisode(state.currentEp + 1);
    });

    // 全屏：CSS class 切换（不依赖 Fullscreen API，安卓 WebView 也能用）
    function applyFullscreen(isFs) {
      document.body.classList.toggle('is-fullscreen', isFs);
      // 通知安卓端切换屏幕方向
      try { if (window.androidAPI && window.androidAPI.setFullscreen) window.androidAPI.setFullscreen(isFs); } catch (e) {}
      // 选集面板已在 videoStage 内，无需移动 DOM
      if (isFs) {
        els.episodePanel.classList.remove('show');
        els.epMask.hidden = true;
      }
    }
    function toggleFullscreen() {
      const isFs = !document.body.classList.contains('is-fullscreen');
      applyFullscreen(isFs);
      // 全屏切换后清空控制栏 inline right，让 CSS 的 right 值生效
      setTimeout(() => { if (els.controls) els.controls.style.right = ''; }, 50);
      // iOS 检测：iOS 不支持原生 Fullscreen API，使用 CSS 全屏
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (isIOS) {
        // iOS：添加 ios-fullscreen class，使用 CSS fixed 定位全屏（带选集和控制栏）
        document.body.classList.toggle('ios-fullscreen', isFs);
        // 注意：不调用 webkitEnterFullscreen，避免进入只有画面的原生全屏
        return;
      }
      // 电脑端同时尝试原生全屏（可选，失败不影响 CSS 全屏）
      try {
        if (isFs) {
          if (els.videoStage.requestFullscreen) els.videoStage.requestFullscreen().catch(() => {});
          else if (els.videoStage.webkitRequestFullscreen) els.videoStage.webkitRequestFullscreen();
        } else {
          if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        }
      } catch (e) {}
    }
    els.btnFull.addEventListener('click', toggleFullscreen);
    if (els.btnTitleFull) els.btnTitleFull.addEventListener('click', toggleFullscreen);
    if (els.btnBack) {
      els.btnBack.addEventListener('click', () => applyFullscreen(false));
      els.btnBack.addEventListener('touchstart', (e) => { e.preventDefault(); applyFullscreen(false); }, { passive: false });
    }

    // 原生全屏变化时同步 CSS class（电脑端）
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && document.body.classList.contains('is-fullscreen')) {
        // 用户用 ESC 退出原生全屏，同步退出 CSS 全屏
        applyFullscreen(false);
      }
    });
    document.addEventListener('webkitfullscreenchange', () => {
      if (!document.webkitFullscreenElement && document.body.classList.contains('is-fullscreen')) {
        applyFullscreen(false);
      }
    });

    // 弹幕发送
    function sendDanmakuFromInput() {
      const v = els.danmakuInput.value;
      if (v && v.trim()) {
        sendDanmaku(v.trim());
        els.danmakuInput.value = '';
      }
    }
    if (els.btnDanmakuSend) els.btnDanmakuSend.addEventListener('click', sendDanmakuFromInput);
    if (els.danmakuInput) els.danmakuInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendDanmakuFromInput(); }
    });

    // 控制栏自动隐藏
    els.videoStage.addEventListener('mousemove', showControls);
    els.videoStage.addEventListener('touchstart', () => { showControls(); }, { passive: true });
    // 选集框阻止触摸事件冒泡到 videoStage（全屏时选集框在 videoStage 内，防止触摸选集时弹出控制栏）
    if (els.episodePanel) {
      els.episodePanel.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
      els.episodePanel.addEventListener('mousemove', (e) => { e.stopPropagation(); });
      els.episodePanel.addEventListener('click', (e) => { e.stopPropagation(); });
    }

    // 导入按钮：点击弹出选择菜单（视频/图片）
    const importMenu = document.getElementById('importMenu');
    $('btnImport').addEventListener('click', (e) => {
      e.stopPropagation();
      importMenu.hidden = !importMenu.hidden;
    });
    // 点击页面其他地方关闭菜单
    document.addEventListener('click', (e) => {
      if (!importMenu.hidden && !e.target.closest('#importMenu') && !e.target.closest('#btnImport')) {
        importMenu.hidden = true;
      }
    });
    document.getElementById('impVideo').addEventListener('click', () => {
      importMenu.hidden = true;
      els.fileVideo.click();
    });
    document.getElementById('impImage').addEventListener('click', () => {
      importMenu.hidden = true;
      els.fileImage.click();
    });
    els.btnEpImport.addEventListener('click', () => els.fileVideo.click());

    // 选集面板开关（滑入式 overlay）
    els.btnEpToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleEpisodePanel();
    });
    els.epMask.addEventListener('click', () => closeEpisodePanel());
    els.btnEpClose.addEventListener('click', (e) => {
      e.stopPropagation();
      closeEpisodePanel();
    });
    els.fileVideo.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) importVideoTo(state.currentEp, file);
      e.target.value = '';
    });
    els.fileImage.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) importCoverTo(state.currentEp, file);
      e.target.value = '';
    });

    // 设置
    $('btnSettings').addEventListener('click', openSettings);
    els.btnSaveSettings.addEventListener('click', saveSettings);
    els.setColor.addEventListener('input', () => {
      els.colorPreview.textContent = els.setColor.value;
      document.documentElement.style.setProperty('--accent', els.setColor.value);
      els.playerFrame.style.borderColor = els.setColor.value;
    });
    els.setEpCount.addEventListener('input', () => { /* 预览可略 */ });

    // 快速设置集数
    els.btnEpSet.addEventListener('click', () => {
      // 全屏时打开设置先退出全屏，避免模态框黑色假面
      if (document.body.classList.contains('is-fullscreen')) {
        document.body.classList.remove('is-fullscreen');
      }
      els.quickEpCount.value = state.totalEpisodes;
      els.modalEpSet.hidden = false;
    });
    els.btnQuickEpSave.addEventListener('click', () => {
      const n = Math.max(1, Math.min(999, parseInt(els.quickEpCount.value, 10) || 1));
      state.totalEpisodes = n;
      if (state.currentEp > n) state.currentEp = n;
      renderEpisodeList();
      els.modalEpSet.hidden = false;
      els.modalEpSet.hidden = true;
      saveState();
    });

    // 网盘链接
    $('btnNetwork').addEventListener('click', () => {
      renderNetEpSelect();
      els.netUrl.value = (state.eps[state.currentEp] && state.eps[state.currentEp].remoteUrl) || '';
      els.netEp.value = String(state.currentEp);
      els.modalNetwork.hidden = false;
    });
    els.btnNetSave.addEventListener('click', () => {
      const url = els.netUrl.value.trim();
      const ep = parseInt(els.netEp.value, 10) || state.currentEp;
      if (!url) { alert('请输入视频直链地址'); return; }
      if (!state.eps[ep]) state.eps[ep] = {};
      state.eps[ep].remoteUrl = url;
      localVideos.delete(ep);   // 网盘链接优先
      saveState();
      els.modalNetwork.hidden = true;
      playEpisode(ep);
    });
    els.btnNetClear.addEventListener('click', () => {
      const ep = parseInt(els.netEp.value, 10) || state.currentEp;
      if (state.eps[ep]) delete state.eps[ep].remoteUrl;
      saveState();
      els.modalNetwork.hidden = true;
      playEpisode(ep);
    });

    // 关闭模态框
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => { $(btn.dataset.close).hidden = true; });
    });
    document.querySelectorAll('.modal-mask').forEach(mask => {
      mask.addEventListener('click', (e) => { if (e.target === mask) mask.hidden = true; });
    });

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      if (e.key === 'ArrowRight') { if (els.video.duration) els.video.currentTime = Math.min(els.video.duration, els.video.currentTime + 5); }
      if (e.key === 'ArrowLeft') { if (els.video.duration) els.video.currentTime = Math.max(0, els.video.currentTime - 5); }
      if (e.key === 'f' || e.key === 'F') els.btnFull.click();
    });
  }

  function renderNetEpSelect() {
    els.netEp.innerHTML = '';
    for (let i = 1; i <= state.totalEpisodes; i++) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = '第 ' + i + ' 集' + (i === state.currentEp ? '（当前）' : '');
      els.netEp.appendChild(o);
    }
  }

  function updateLicenseInfo() {
    if (!els.licenseInfo) return;
    if (isActivated) {
      let lic = null;
      try { lic = JSON.parse(localStorage.getItem(LICENSE_KEY) || 'null'); } catch (e) {}
      if (lic && lic.activatedAt) {
        const days = lic.days || 30;
        const expireAt = lic.activatedAt + days * 24 * 3600 * 1000;
        const remainDays = Math.max(0, Math.ceil((expireAt - Date.now()) / (24 * 3600 * 1000)));
        const typeName = days === 1 ? '试用卡' : (days >= 365 ? '年卡' : '月卡');
        els.licenseInfo.className = 'license-info';
        els.licenseInfo.innerHTML = '✅ 已激活（' + typeName + '）<br>剩余 <b>' + remainDays + '</b> 天<br>到期：' + fmtExpDate(expireAt);
      } else {
        els.licenseInfo.className = 'license-info';
        els.licenseInfo.textContent = '✅ 已激活';
      }
    } else {
      els.licenseInfo.className = 'license-info inactive';
      els.licenseInfo.textContent = '❌ 未激活，请输入激活码解锁全部功能';
    }
  }
  function openSettings() {
    els.setSeriesName.value = state.seriesName;
    els.setEpCount.value = state.totalEpisodes;
    els.setColor.value = state.accentColor;
    els.colorPreview.textContent = state.accentColor;
    els.setRatio.value = state.ratio;
    els.setSpeed.value = String(state.speed);
    if (els.setShowPauseIcon) els.setShowPauseIcon.value = state.showPauseIcon ? '1' : '0';
    if (els.setEpDisplayMode) els.setEpDisplayMode.value = state.epDisplayMode || 'full';
    if (els.setDanmakuInput) els.setDanmakuInput.value = state.danmakuInputVisible ? '1' : '0';
    if (els.setDanmakuMode) els.setDanmakuMode.value = state.danmakuMode || 'scroll';
    if (els.setLicenseServerEnabled) els.setLicenseServerEnabled.checked = state.licenseServerEnabled;
    if (els.setLicenseServer) els.setLicenseServer.value = state.licenseServer || '';
    els.setEpTitle.value = (state.eps[state.currentEp] && state.eps[state.currentEp].title) || '';
    updateLicenseInfo();
    els.modalSettings.hidden = false;
  }

  function saveSettings() {
    state.seriesName = els.setSeriesName.value.trim() || '智能播放器';
    state.totalEpisodes = Math.max(1, Math.min(999, parseInt(els.setEpCount.value, 10) || 1));
    state.accentColor = els.setColor.value;
    state.ratio = els.setRatio.value;
    state.speed = parseFloat(els.setSpeed.value) || 1;
    if (els.setEpDisplayMode) state.epDisplayMode = els.setEpDisplayMode.value || 'full';
    if (els.setDanmakuInput) state.danmakuInputVisible = els.setDanmakuInput.value === '1';
    if (els.setDanmakuMode) state.danmakuMode = els.setDanmakuMode.value;
    if (els.setLicenseServerEnabled) state.licenseServerEnabled = els.setLicenseServerEnabled.checked;
    if (els.setLicenseServer) state.licenseServer = els.setLicenseServer.value.trim();
    applyDanmakuInputVisibility();

    if (!state.eps[state.currentEp]) state.eps[state.currentEp] = {};
    const t = els.setEpTitle.value.trim();
    if (t) state.eps[state.currentEp].title = t;
    else delete state.eps[state.currentEp].title;

    if (state.currentEp > state.totalEpisodes) state.currentEp = state.totalEpisodes;

    applyAccent();
    els.video.playbackRate = state.speed;
    applyRatio();
    renderEpisodeList();
    if (els.titleSeriesName) els.titleSeriesName.textContent = state.seriesName;
    const curEpTitle = (state.eps[state.currentEp] && state.eps[state.currentEp].title) || ('第' + state.currentEp + '集');
    els.titleBarText.textContent = curEpTitle;
    // 同步更多菜单中的倍速/比例选中态
    document.querySelectorAll('.mm-speed-item').forEach(x => x.classList.toggle('active', parseFloat(x.dataset.s) === state.speed));
    document.querySelectorAll('.mm-ratio-item').forEach(x => x.classList.toggle('active', x.dataset.r === state.ratio));
    saveState();
    els.modalSettings.hidden = true;
  }

  function applyRatio() {
    els.videoStage.classList.remove('ratio-169', 'ratio-916', 'ratio-43', 'ratio-origin', 'ratio-auto');
    let cls = 'ratio-auto';
    if (state.ratio === '16:9') cls = 'ratio-169';
    else if (state.ratio === '9:16') cls = 'ratio-916';
    else if (state.ratio === '4:3') cls = 'ratio-43';
    else if (state.ratio === 'origin') cls = 'ratio-origin';
    els.videoStage.classList.add(cls);
  }

  function updateLoopBtn() {
    // 循环状态已移至更多菜单开关，此处保留空函数兼容旧调用
  }

  /* ---------- 激活系统（月卡：从激活时间起30天有效） ---------- */
  const LICENSE_KEY = 'fgmm_license_v1';
  const SECRET = 'FGMM-MANJU-2026';
  const LICENSE_DAYS = 30;   // 月卡有效期（天）

  /* 内置5个月卡测试激活码（需先导入服务器才能使用）：
     FGMM-M-0001-E8D1
     FGMM-M-0002-7E68
     FGMM-M-0003-C77B
     FGMM-M-0004-6EFA
     FGMM-M-0005-63DD
  */

  function fnvSigSeq(seq, type) {
    // 新格式：FNV-1a 对 类型|序号|SECRET 求哈希
    let h = 0x811c9dc5;
    const s = (type || 'M') + '|' + (seq || '0000') + '|' + SECRET;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h & 0xffff).toString(16).toUpperCase().padStart(4, '0');
  }
  // 卡类型对应的有效天数
  function licenseDays(type) {
    if (type === 'D') return 1;       // 1天试用卡
    if (type === 'Y') return 365;     // 年卡
    return 30;                          // 月卡（默认）
  }

  function fnvSigOld(expStr, seq) {
    // 旧格式兼容：FNV-1a 对 日期|序号|SECRET 求哈希
    let h = 0x811c9dc5;
    const s = expStr + '|' + (seq || '0000') + '|' + SECRET;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h & 0xffff).toString(16).toUpperCase().padStart(4, '0');
  }

  function parseCode(code) {
    code = String(code || '').trim().toUpperCase();
    // v6 格式：FGMM-类型(D/M/Y)-序号(4位)-校验码(4位hex)
    const mTyped = code.match(/^FGMM-([DMY])-(\d{4})-([0-9A-F]{4})$/);
    if (mTyped) {
      const type = mTyped[1], seq = mTyped[2], sig = mTyped[3];
      if (sig !== fnvSigSeq(seq, type)) return { ok: false, msg: '激活码校验失败，请检查是否输错' };
      return { ok: true, type: type, days: licenseDays(type), msg: '激活成功' };
    }
    // 旧格式兼容：FGMM-序号(4位)-校验码(4位hex) —— 默认月卡30天
    const mNew = code.match(/^FGMM-(\d{4})-([0-9A-F]{4})$/);
    if (mNew) {
      const seq = mNew[1], sig = mNew[2];
      if (sig !== fnvSigSeq(seq, 'M')) return { ok: false, msg: '激活码校验失败，请检查是否输错' };
      return { ok: true, type: 'M', days: 30, msg: '激活成功' };
    }
    // 旧格式兼容：FGMM-日期(8位)-序号(4位)-校验码(4位hex)
    const mOld = code.match(/^FGMM-(\d{8})-(\d{4})-([0-9A-F]{4})$/);
    if (mOld) {
      const expStr = mOld[1], seq = mOld[2], sig = mOld[3];
      if (sig !== fnvSigOld(expStr, seq)) return { ok: false, msg: '激活码校验失败，请检查是否输错' };
      return { ok: true, type: 'M', days: 30, msg: '激活成功' };
    }
    return { ok: false, msg: '激活码格式不正确（如 FGMM-D-0001-XXXX 天卡 / FGMM-M-0001-XXXX 月卡 / FGMM-Y-0001-XXXX 年卡）' };
  }

  function fmtExpDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // 获取设备指纹（方案二：本地设备绑定）
  async function getDeviceFingerprint() {
    try {
      if (window.playerAPI && window.playerAPI.getDeviceFingerprint) {
        return await window.playerAPI.getDeviceFingerprint();
      }
      if (window.androidAPI && window.androidAPI.getDeviceFingerprint) {
        return window.androidAPI.getDeviceFingerprint();
      }
    } catch (e) {}
    // PWA / 浏览器：用 canvas 指纹
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillText('orange-player-fingerprint', 2, 2);
      const data = canvas.toDataURL();
      let hash = 0;
      for (let i = 0; i < data.length; i++) {
        hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0;
      }
      return 'web_' + Math.abs(hash).toString(16);
    } catch (e) { return 'unknown'; }
  }

  // 服务端验证（方案一）
  async function serverActivate(code, deviceFingerprint, days) {
    if (!state.licenseServer || !state.licenseServerEnabled) return { ok: true, skipped: true };
    try {
      // 10秒超时控制
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(state.licenseServer + '/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, deviceFingerprint, days }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') {
        return { ok: false, msg: '连接授权服务器超时（10秒），请检查网络或服务器地址后重试' };
      }
      return { ok: false, msg: '无法连接授权服务器，请检查网络后重试（错误：' + e.message + '）' };
    }
  }

  async function checkActivation() {
    let lic = null;
    // 优先从文件读取（更可靠），其次从 localStorage
    if (window.playerAPI && window.playerAPI.loadLicense) {
      try { lic = await window.playerAPI.loadLicense(); } catch (e) {}
      // 从文件读取后同步保存到 localStorage，确保设置页面能显示剩余时间
      if (lic && lic.code) {
        try { localStorage.setItem(LICENSE_KEY, JSON.stringify(lic)); } catch (e) {}
      }
    }
    if (!lic) {
      try { lic = JSON.parse(localStorage.getItem(LICENSE_KEY) || 'null'); } catch (e) {}
    }
    if (lic && lic.code) {
      if (els.actCode) els.actCode.value = lic.code;
      if (els.actRemember) els.actRemember.checked = true;
      if (lic.activatedAt) {
        const days = lic.days || 30;
        const expireAt = lic.activatedAt + days * 24 * 3600 * 1000;
        const now = Date.now();
        if (now < expireAt) {
          // 方案二：检查设备指纹是否匹配
          if (lic.deviceFingerprint) {
            const currentFp = await getDeviceFingerprint();
            if (currentFp !== lic.deviceFingerprint && currentFp !== 'unknown' && lic.deviceFingerprint !== 'unknown') {
              isActivated = false;
              els.activateMask.hidden = false;
              if (els.actMsg) { els.actMsg.textContent = '该激活码已绑定其他设备，无法在本设备使用。如需更换设备请联系客服。'; els.actMsg.className = 'err'; }
              if (els.actExp) els.actExp.textContent = '设备不匹配';
              return;
            }
          }
          isActivated = true;
          els.activateMask.hidden = true;
          const typeName = days === 1 ? '试用卡' : (days >= 365 ? '年卡' : '月卡');
          const remainDays = Math.ceil((expireAt - now) / (24 * 3600 * 1000));
          if (els.actExp) els.actExp.textContent = '已激活（' + typeName + '），剩余 ' + remainDays + ' 天，到期：' + fmtExpDate(expireAt);
          return;
        }
        isActivated = false;
        els.activateMask.hidden = false;
        if (els.actMsg) { els.actMsg.textContent = '激活码已过期（' + fmtExpDate(expireAt) + ' 到期），请输入新的激活码续期'; els.actMsg.className = 'err'; }
        if (els.actExp) els.actExp.textContent = '未激活';
        return;
      }
      const r = parseCode(lic.code);
      if (r.ok) {
        try {
          lic.activatedAt = Date.now();
          lic.days = r.days;
          localStorage.setItem(LICENSE_KEY, JSON.stringify(lic));
          if (window.playerAPI && window.playerAPI.saveLicense) window.playerAPI.saveLicense(lic);
        } catch (e) {}
        isActivated = true;
        els.activateMask.hidden = true;
        const remainDays = r.days;
        if (els.actExp) els.actExp.textContent = '已激活，剩余 ' + remainDays + ' 天，到期：' + fmtExpDate(Date.now() + r.days * 24 * 3600 * 1000);
        return;
      }
    }
    isActivated = false;
    els.activateMask.hidden = false;
    if (els.actMsg) { els.actMsg.textContent = ''; els.actMsg.className = ''; }
    if (els.actExp) els.actExp.textContent = '未激活';
  }

  async function doActivate() {
    const code = els.actCode.value.trim();
    const now = Date.now();
    // 不带本地识别激活码：不做本地格式校验，直接走服务端验证
    if (!code) {
      els.actMsg.textContent = '请输入激活码';
      els.actMsg.className = 'err';
      return;
    }
    // 获取设备指纹
    const deviceFingerprint = await getDeviceFingerprint();
    // 必须走服务端验证（不带本地识别，完全由服务器决定激活码有效性）
    if (state.licenseServerEnabled && state.licenseServer) {
      els.actMsg.textContent = '正在连接授权服务器…';
      els.actMsg.className = '';
      const serverResult = await serverActivate(code, deviceFingerprint, 30);
      if (!serverResult.ok) {
        els.actMsg.textContent = serverResult.msg || '服务端验证失败，无法激活';
        els.actMsg.className = 'err';
        return;
      }
      // 使用服务端返回的有效期天数（如果服务端返回了的话）
      const days = serverResult.days || 30;
      // 保存激活信息（含设备指纹）
      const licData = { code: code, activatedAt: now, days: days, deviceFingerprint: deviceFingerprint };
      try { localStorage.setItem(LICENSE_KEY, JSON.stringify(licData)); } catch (e) {}
      const remember = els.actRemember ? els.actRemember.checked : true;
      if (window.playerAPI && window.playerAPI.saveLicense) {
        if (remember) window.playerAPI.saveLicense(licData);
        else window.playerAPI.clearLicense();
      }
      isActivated = true;
      els.activateMask.hidden = true;
      els.actMsg.textContent = '';
      const expireAt = now + days * 24 * 3600 * 1000;
      const typeName = days === 1 ? '试用卡' : (days >= 365 ? '年卡' : '月卡');
      const remainDays = Math.ceil((expireAt - Date.now()) / (24 * 3600 * 1000));
      if (els.actExp) els.actExp.textContent = '已激活（' + typeName + '），剩余 ' + remainDays + ' 天，到期：' + fmtExpDate(expireAt);
      // 同步更新设置页面的激活状态
      updateLicenseInfo();
    } else {
      els.actMsg.textContent = '服务端验证未启用，无法激活';
      els.actMsg.className = 'err';
    }
  }

  /* ---------- 启动 ---------- */
  document.addEventListener('DOMContentLoaded', async () => {
    cacheElements();
    bindEvents();
    els.btnConvert.addEventListener('click', () => convertAndPlay());
    els.btnActivate.addEventListener('click', () => doActivate());
    els.actCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') doActivate(); });
    bindV5Features();
    await init();
    await checkActivation();
  });

  /* ========== v5 新功能（极简界面版） ========== */
  function bindV5Features() {
    // --- 一键清除 ---
    if (els.btnClearAll) els.btnClearAll.addEventListener('click', async () => {
      if (!confirm('确定要清除所有导入的视频和图片吗？此操作不可恢复！')) return;
      try {
        const keys = await PlayerDB.getAllKeys();
        for (const k of keys) {
          if (typeof k === 'string' && (k.startsWith('video_') || k.startsWith('cover_'))) {
            await PlayerDB.remove(k);
          }
        }
        localVideos.clear();
        state.eps = {};
        state.currentEp = 1;
        saveState();
        destroyMedia();
        pendingVideoFile = null;
        els.convertTip.hidden = true;
        const ct = document.getElementById('convertText');
        if (ct) ct.textContent = '该视频编码可能不被支持（常见于网盘下载的 HEVC/H.265 视频），播放器可一键转码后播放';
        const cp = document.getElementById('convertProgress');
        if (cp) cp.hidden = true;
        const cpb = document.getElementById('convertProgressBar');
        if (cpb) cpb.style.width = '0%';
        const cpt = document.getElementById('convertProgressText');
        if (cpt) cpt.hidden = true;
        const bc = document.getElementById('btnConvert');
        if (bc) { bc.hidden = false; bc.disabled = false; bc.textContent = '一键转码播放'; }
        document.body.classList.remove('is-converting');
        els.video.style.transform = '';
        renderEpisodeList();
        els.titleBarText.textContent = '第1集';
        if (els.titleSeriesName) els.titleSeriesName.textContent = state.seriesName;
        showPosterEmpty('第 1 集暂无视频');
        document.getElementById('modalSettings').hidden = true;
        alert('已清除所有视频和图片');
      } catch (e) {
        alert('清除失败：' + e.message);
      }
    });

    // --- 视频手势缩放平移（双手缩放、单指移动，不影响播放） ---
    if (els.videoZoomWrap) {
      let pinchStartDist = 0, pinchStartScale = 1;
      let panStartX = 0, panStartY = 0, panStartTx = 0, panStartTy = 0;
      let currentScale = 1, currentTx = 0, currentTy = 0;
      const applyTransform = () => {
        els.video.style.transform = 'translate(' + currentTx + 'px,' + currentTy + 'px) scale(' + currentScale + ')';
      };
      const getDist = (t) => {
        if (t.length < 2) return 0;
        const dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
        return Math.sqrt(dx*dx + dy*dy);
      };
      els.videoZoomWrap.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
          pinchStartDist = getDist(e.touches);
          pinchStartScale = currentScale;
        } else if (e.touches.length === 1) {
          panStartX = e.touches[0].clientX; panStartY = e.touches[0].clientY;
          panStartTx = currentTx; panStartTy = currentTy;
        }
      }, { passive: true });
      els.videoZoomWrap.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && pinchStartDist > 0) {
          e.preventDefault();
          const dist = getDist(e.touches);
          currentScale = Math.max(0.3, Math.min(5, pinchStartScale * (dist / pinchStartDist)));
          applyTransform();
        } else if (e.touches.length === 1) {
          e.preventDefault();
          currentTx = panStartTx + (e.touches[0].clientX - panStartX);
          currentTy = panStartTy + (e.touches[0].clientY - panStartY);
          applyTransform();
        }
      }, { passive: false });
      els.videoZoomWrap.addEventListener('touchend', (e) => {
        if (e.touches.length === 0) pinchStartDist = 0;
      });
      // 双击重置缩放
      let lastTap = 0;
      els.videoZoomWrap.addEventListener('click', (e) => {
        const now = Date.now();
        if (now - lastTap < 300) {
          currentScale = 1; currentTx = 0; currentTy = 0; applyTransform();
        }
        lastTap = now;
      });
    }

    // --- 封面图手势缩放平移（和视频同样逻辑） ---
    if (els.posterZoomWrap) {
      let pPinchStartDist = 0, pPinchStartScale = 1;
      let pPanStartX = 0, pPanStartY = 0, pPanStartTx = 0, pPanStartTy = 0;
      let pScale = 1, pTx = 0, pTy = 0;
      const pApply = () => {
        els.posterImg.style.transform = 'translate(' + pTx + 'px,' + pTy + 'px) scale(' + pScale + ')';
      };
      const pGetDist = (t) => {
        if (t.length < 2) return 0;
        const dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
        return Math.sqrt(dx*dx + dy*dy);
      };
      els.posterZoomWrap.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
          pPinchStartDist = pGetDist(e.touches);
          pPinchStartScale = pScale;
        } else if (e.touches.length === 1) {
          pPanStartX = e.touches[0].clientX; pPanStartY = e.touches[0].clientY;
          pPanStartTx = pTx; pPanStartTy = pTy;
        }
      }, { passive: true });
      els.posterZoomWrap.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && pPinchStartDist > 0) {
          e.preventDefault();
          const dist = pGetDist(e.touches);
          pScale = Math.max(0.3, Math.min(5, pPinchStartScale * (dist / pPinchStartDist)));
          pApply();
        } else if (e.touches.length === 1) {
          e.preventDefault();
          pTx = pPanStartTx + (e.touches[0].clientX - pPanStartX);
          pTy = pPanStartTy + (e.touches[0].clientY - pPanStartY);
          pApply();
        }
      }, { passive: false });
      els.posterZoomWrap.addEventListener('touchend', (e) => {
        if (e.touches.length === 0) pPinchStartDist = 0;
      });
      // 双击重置封面缩放
      let pLastTap = 0;
      els.posterZoomWrap.addEventListener('click', (e) => {
        const now = Date.now();
        if (now - pLastTap < 300) { pScale = 1; pTx = 0; pTy = 0; pApply(); }
        pLastTap = now;
      });
    }

    // --- 鼠标缩放支持（Windows 桌面端：滚轮缩放+拖动平移+双击重置） ---
    function bindMouseZoom(wrapEl, targetEl) {
      let mScale = 1, mTx = 0, mTy = 0;
      let mDragging = false, mStartX = 0, mStartY = 0, mStartTx = 0, mStartTy = 0;
      const mApply = () => { targetEl.style.transform = 'translate(' + mTx + 'px,' + mTy + 'px) scale(' + mScale + ')'; };
      // 滚轮缩放
      wrapEl.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        mScale = Math.max(0.3, Math.min(5, mScale * delta));
        mApply();
      }, { passive: false });
      // 拖动平移（任何缩放比例下都能拖动，包括缩小后）
      wrapEl.addEventListener('mousedown', (e) => {
        mDragging = true;
        mStartX = e.clientX; mStartY = e.clientY;
        mStartTx = mTx; mStartTy = mTy;
        wrapEl.style.cursor = 'grabbing';
      });
      document.addEventListener('mousemove', (e) => {
        if (!mDragging) return;
        mTx = mStartTx + (e.clientX - mStartX);
        mTy = mStartTy + (e.clientY - mStartY);
        mApply();
      });
      document.addEventListener('mouseup', () => {
        if (mDragging) { mDragging = false; wrapEl.style.cursor = ''; }
      });
      // 双击重置
      wrapEl.addEventListener('dblclick', (e) => {
        e.preventDefault();
        mScale = 1; mTx = 0; mTy = 0; mApply();
      });
    }
    if (els.videoZoomWrap && els.video) bindMouseZoom(els.videoZoomWrap, els.video);
    if (els.posterZoomWrap && els.posterImg) bindMouseZoom(els.posterZoomWrap, els.posterImg);
  }
})();
