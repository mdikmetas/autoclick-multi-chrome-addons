const D = EHM_DEFAULTS;
const $ = (id) => document.getElementById(id);
const FIELDS = ['mode', 'trusted', 'button', 'interval', 'jitter', 'jitterPx', 'startDelay', 'cycleDelay',
                'maxClicks', 'unlimited', 'maxSeconds', 'beep', 'ripple'];
let cfg = { ...D };
let renderedPoints = -1;

const say = (t) => { $('msg').textContent = t || ''; };
const pickFields = (c) => { const o = {}; for (const f of FIELDS) o[f] = c[f]; return o; };

function readCfg() {
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') cfg[f] = el.checked;
    else if (el.type === 'number') cfg[f] = Math.max(Number(el.min) || 0, Number(el.value) || 0);
    else cfg[f] = el.value;
  }
  return cfg;
}
function updateDim() {
  const multi = cfg.mode === 'multi';
  $('multiBox').classList.toggle('dis', !multi);
  $('cycleRow').classList.toggle('dis', !multi);
  $('cursorBox').style.display = multi ? 'none' : 'block';
  $('maxRow').classList.toggle('dis', !!cfg.unlimited);
}
function applyUI() {
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') el.checked = !!cfg[f]; else el.value = cfg[f];
  }
  $('toggleKey').value = cfg.toggleKey;
  $('stopKey').value = cfg.stopKey;
  updateDim();
}
function save() {
  readCfg();
  chrome.storage.local.set(pickFields(cfg));
  updateDim();
}

// ---------- Sekme ile iletişim ----------
async function send(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || /^(chrome|edge|about|chrome-extension|devtools|view-source):/.test(tab.url || '')) {
    $('warn').textContent = 'Bu sayfada çalışmaz (chrome:// vb.). Normal bir web sayfası aç.';
    return null;
  }
  const opts = { frameId: 0 };
  try {
    return await chrome.tabs.sendMessage(tab.id, msg, opts);
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['defaults.js', 'content.js'] });
      return await chrome.tabs.sendMessage(tab.id, msg, opts);
    } catch (e2) {
      $('warn').textContent = 'Sayfaya erişilemedi (sayfayı yenilemeyi dene): ' + e2.message;
      return null;
    }
  }
}

// ---------- Nokta listesi ----------
function renderList(points) {
  const box = $('plist');
  box.textContent = '';
  renderedPoints = points.length;
  if (!points.length) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.textContent = 'Henüz nokta yok.';
    box.appendChild(h);
    return;
  }
  points.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'prow';
    row.innerHTML =
      `<b>${i + 1}</b>` +
      '<input type="number" class="d" min="0" step="10" placeholder="genel">' +
      '<select class="b"><option value="">genel</option><option value="left">sol</option><option value="right">sağ</option><option value="double">çift</option></select>' +
      '<input type="number" class="r" min="1" step="1">' +
      '<button class="x" title="Sil">✕</button>';
    const d = row.querySelector('.d'), b = row.querySelector('.b'), r = row.querySelector('.r');
    d.value = p.delay == null ? '' : p.delay;
    b.value = p.button || '';
    r.value = p.repeat || 1;
    d.onchange = () => send({ type: 'updatePoint', i, patch: { delay: d.value === '' ? null : Math.max(0, Number(d.value) || 0) } });
    b.onchange = () => send({ type: 'updatePoint', i, patch: { button: b.value || null } });
    r.onchange = () => { r.value = Math.max(1, Math.floor(Number(r.value) || 1)); send({ type: 'updatePoint', i, patch: { repeat: Number(r.value) } }); };
    row.querySelector('.x').onclick = async () => showState(await send({ type: 'removePoint', i }), true);
    box.appendChild(row);
  });
}

function showState(s, forceList) {
  if (!s) return;
  $('warn').textContent = s.warn || '';
  $('state').textContent = s.running ? 'Çalışıyor' : 'Durdu';
  $('state').classList.toggle('on', s.running);
  $('counter').textContent = 'Tıklama: ' + s.count + (s.trusted ? ' (gerçek tıklama)' : '');
  if (forceList || s.points.length !== renderedPoints) renderList(s.points);
}

// ---------- Profiller ----------
async function getProfiles() { return (await chrome.storage.local.get('profiles')).profiles || []; }
function renderProfiles(list, sel) {
  const s = $('profSel');
  s.textContent = '';
  for (const p of list) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.name;
    s.appendChild(o);
  }
  if (sel) s.value = sel;
}
async function setProfiles(list, sel) {
  await chrome.storage.local.set({ profiles: list });
  renderProfiles(list, sel);
}
function cleanImportedCfg(c) {
  const o = {};
  if (!c || typeof c !== 'object') return o;
  for (const f of FIELDS) if (f in c && typeof c[f] === typeof D[f]) o[f] = c[f];
  return o;
}

// ---------- Başlangıç ----------
(async () => {
  cfg = { ...D, ...(await chrome.storage.local.get(Object.keys(D))) };
  applyUI();
  renderProfiles(await getProfiles());

  for (const f of FIELDS) {
    $(f).addEventListener('input', save);
    $(f).addEventListener('change', () => { save(); applyUI(); });
  }
  for (const id of ['toggleKey', 'stopKey']) {
    $(id).addEventListener('keydown', (e) => {
      e.preventDefault();
      cfg[id] = e.code;
      chrome.storage.local.set({ [id]: e.code });
      $(id).value = e.code;
    });
  }

  $('start').onclick = async () => {
    readCfg();
    await chrome.storage.local.set(pickFields(cfg));
    const s = await send({ type: 'start', cfg });
    showState(s);
    if (s && !(cfg.mode === 'multi' && !s.points.length)) window.close(); // sayfaya odak dönsün
  };
  $('stop').onclick = async () => showState(await send({ type: 'stop' }));
  $('pick').onclick = async () => { const s = await send({ type: 'pick' }); if (s) window.close(); };
  $('undo').onclick = async () => showState(await send({ type: 'undo' }), true);
  $('clear').onclick = async () => showState(await send({ type: 'clear' }), true);

  $('profSave').onclick = async () => {
    const name = ($('profName').value.trim() || $('profSel').value || '').slice(0, 40);
    if (!name) return say('Profil adı yaz.');
    const st = await send({ type: 'status' });
    if (!st) return;
    readCfg();
    const list = await getProfiles();
    const item = { name, cfg: pickFields(cfg), points: st.points, saved: Date.now() };
    const i = list.findIndex((p) => p.name === name);
    if (i >= 0) list[i] = item; else list.push(item);
    await setProfiles(list, name);
    $('profName').value = '';
    say('Profil kaydedildi: ' + name);
  };
  $('profLoad').onclick = async () => {
    const p = (await getProfiles()).find((x) => x.name === $('profSel').value);
    if (!p) return say('Önce bir profil seç.');
    Object.assign(cfg, cleanImportedCfg(p.cfg));
    await chrome.storage.local.set(pickFields(cfg));
    applyUI();
    showState(await send({ type: 'setPoints', points: p.points || [] }), true);
    say('Yüklendi: ' + p.name);
  };
  $('profDel').onclick = async () => {
    const name = $('profSel').value;
    if (!name) return;
    await setProfiles((await getProfiles()).filter((p) => p.name !== name));
    say('Silindi: ' + name);
  };
  $('profExport').onclick = async () => {
    const blob = new Blob([JSON.stringify({ ehm: 1, profiles: await getProfiles() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ehm-autoclicker-profiller.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('profImport').onclick = () => $('profFile').click();
  $('profFile').onchange = async () => {
    const f = $('profFile').files[0];
    $('profFile').value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const incoming = Array.isArray(data.profiles) ? data.profiles : [];
      const list = await getProfiles();
      let n = 0;
      for (const p of incoming) {
        if (!p || typeof p.name !== 'string' || !p.name.trim() || !Array.isArray(p.points)) continue;
        const item = { name: p.name.trim().slice(0, 40), cfg: cleanImportedCfg(p.cfg), points: p.points.slice(0, 500), saved: Date.now() };
        const i = list.findIndex((x) => x.name === item.name);
        if (i >= 0) list[i] = item; else list.push(item);
        n++;
      }
      await setProfiles(list);
      say(n + ' profil içe aktarıldı.');
    } catch (e) {
      say('Geçersiz dosya.');
    }
  };

  showState(await send({ type: 'status' }), true);
  setInterval(async () => showState(await send({ type: 'status' })), 500);
})();
