(() => {
  if (window.__ehmAC) return;
  window.__ehmAC = true;

  const IS_TOP = window === window.top;
  const KEYS = Object.keys(EHM_DEFAULTS);

  // ---------- iframe -> üst çerçeve: fare konumu aktarımı (tüm çerçeveler) ----------
  addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__ehm !== 'mouse' || typeof d.x !== 'number' || typeof d.y !== 'number') return;
    let off = null;
    for (const f of document.querySelectorAll('iframe,frame')) {
      if (f.contentWindow === e.source) {
        const r = f.getBoundingClientRect();
        off = { x: r.left + f.clientLeft, y: r.top + f.clientTop };
        break;
      }
    }
    if (!off) return;
    const x = d.x + off.x, y = d.y + off.y;
    if (IS_TOP) { S.mouse.x = x; S.mouse.y = y; }
    else parent.postMessage({ __ehm: 'mouse', x, y }, '*');
  });

  // ---------- Alt çerçeveler: sadece fare konumu ve kısayol tuşu iletir ----------
  if (!IS_TOP) {
    let last = 0;
    const fk = { toggleKey: EHM_DEFAULTS.toggleKey, stopKey: EHM_DEFAULTS.stopKey };
    try {
      chrome.storage.local.get(['toggleKey', 'stopKey'], (v) => {
        if (v.toggleKey) fk.toggleKey = v.toggleKey;
        if (v.stopKey) fk.stopKey = v.stopKey;
      });
      chrome.storage.onChanged.addListener((ch) => {
        if (ch.toggleKey) fk.toggleKey = ch.toggleKey.newValue;
        if (ch.stopKey) fk.stopKey = ch.stopKey.newValue;
      });
    } catch (_) {}
    addEventListener('mousemove', (e) => {
      const n = performance.now();
      if (n - last < 30) return;
      last = n;
      parent.postMessage({ __ehm: 'mouse', x: e.clientX, y: e.clientY }, '*');
    }, true);
    addEventListener('keydown', (e) => {
      if (e.code === fk.toggleKey || e.code === fk.stopKey || e.code === 'Enter' || e.code === 'Escape') {
        try { chrome.runtime.sendMessage({ type: 'frame-key', code: e.code }).catch(() => {}); } catch (_) {}
      }
    }, true);
    return;
  }

  // =====================================================================
  //  Üst çerçeve
  // =====================================================================
  const S = {
    running: false,
    runId: 0,
    count: 0,
    points: [],
    cfg: { ...EHM_DEFAULTS },
    mouse: { x: innerWidth / 2, y: innerHeight / 2 },
    picking: false,
    startedAt: 0,
    usingTrusted: false,
    warn: '',
    last: null,
    inj: null
  };
  const PKEY = 'pts:' + location.origin;

  // ---------- Arayüz (shadow DOM) ----------
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      .hud{position:fixed;right:12px;bottom:12px;background:#111c;color:#fff;font:12px/1.4 system-ui,sans-serif;
           padding:8px 12px;border-radius:8px;display:none;backdrop-filter:blur(4px);pointer-events:none}
      .hud b{color:#4ade80}
      .hud b.s{color:#f87171}
      .hud .w{color:#fbbf24}
      .mark{position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:#ef4444cc;
            color:#fff;font:bold 12px/22px system-ui;text-align:center;border:2px solid #fff;pointer-events:none}
      .pick{position:fixed;inset:0;cursor:crosshair;background:#3b82f622;pointer-events:auto;display:none}
      .tip{position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#111e;color:#fff;
           font:13px system-ui;padding:8px 14px;border-radius:8px;display:none;pointer-events:none}
      .rip{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;border:2px solid #22c55e;
           pointer-events:none;animation:rp .45s ease-out forwards}
      @keyframes rp{from{transform:scale(.4);opacity:1}to{transform:scale(2.2);opacity:0}}
    </style>
    <div class="hud" id="hud"></div>
    <div class="tip" id="tip">Nokta eklemek için tıkla • Bitirmek için Enter / Esc / sağ tık</div>
    <div id="marks"></div>
    <div id="fx"></div>
    <div class="pick" id="pick"></div>`;
  document.documentElement.appendChild(host);
  const $ = (id) => root.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- Yardımcılar ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  const rnd = () => Math.random() * 2 - 1;
  const alive = (id) => S.running && S.runId === id;
  const sendBg = (m) => {
    try { return chrome.runtime.sendMessage(m); } catch (e) { return Promise.reject(e); }
  };

  function normalizeCfg(c) {
    const n = (v, min, def) => { v = Number(v); return Number.isFinite(v) ? Math.max(min, v) : def; };
    c.interval = n(c.interval, 1, 100);
    c.jitter = n(c.jitter, 0, 0);
    c.jitterPx = n(c.jitterPx, 0, 0);
    c.maxClicks = Math.floor(n(c.maxClicks, 1, 100));
    c.maxSeconds = n(c.maxSeconds, 0, 0);
    c.cycleDelay = n(c.cycleDelay, 0, 0);
    c.startDelay = n(c.startDelay, 0, 0);
    return c;
  }

  // ---------- Noktalar ----------
  function cssPath(el) {
    if (!(el instanceof Element)) return null;
    const uniq = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch (_) { return false; } };
    if (el.id && uniq('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 8) {
      if (cur.id && uniq('#' + CSS.escape(cur.id))) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      let part = cur.tagName.toLowerCase();
      const par = cur.parentElement;
      if (par) {
        const same = Array.from(par.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = par;
    }
    const sel = parts.join(' > ');
    try { return document.querySelector(sel) === el && uniq(sel) ? sel : null; } catch (_) { return null; }
  }

  function elementAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el === host ? null : el;
  }

  function makePoint(x, y) {
    const p = { px: x + scrollX, py: y + scrollY, delay: null, button: null, repeat: 1 };
    const el = elementAt(x, y);
    if (el && el !== document.documentElement && el !== document.body) {
      const sel = cssPath(el);
      const r = el.getBoundingClientRect();
      if (sel && r.width > 0 && r.height > 0) {
        p.sel = sel;
        p.fx = (x - r.left) / r.width;
        p.fy = (y - r.top) / r.height;
      }
    }
    return p;
  }

  // Noktayı görünüm penceresi koordinatına çevirir. Öğe bulunursa ona göre, bulunamazsa sayfa koordinatına göre.
  function resolve(p, scroll) {
    if (p.sel) {
      let el = null;
      try { el = document.querySelector(p.sel); } catch (_) {}
      if (el) {
        let r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          let x = r.left + p.fx * r.width, y = r.top + p.fy * r.height;
          if (scroll && (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)) {
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            r = el.getBoundingClientRect();
            x = r.left + p.fx * r.width;
            y = r.top + p.fy * r.height;
          }
          return { x, y };
        }
      }
    }
    return { x: p.px - scrollX, y: p.py - scrollY };
  }

  const validPoint = (p) => p && typeof p === 'object' && Number.isFinite(p.px) && Number.isFinite(p.py);
  function cleanPoint(p) {
    const o = {
      px: p.px, py: p.py,
      delay: p.delay == null ? null : Math.max(0, Number(p.delay) || 0),
      button: ['left', 'right', 'double'].includes(p.button) ? p.button : null,
      repeat: Math.max(1, Math.floor(Number(p.repeat) || 1))
    };
    if (typeof p.sel === 'string' && Number.isFinite(p.fx) && Number.isFinite(p.fy)) { o.sel = p.sel; o.fx = p.fx; o.fy = p.fy; }
    return o;
  }
  function sanitizePatch(patch) {
    const out = {};
    if (!patch) return out;
    if ('delay' in patch) out.delay = patch.delay == null ? null : Math.max(0, Number(patch.delay) || 0);
    if ('button' in patch) out.button = ['left', 'right', 'double'].includes(patch.button) ? patch.button : null;
    if ('repeat' in patch) out.repeat = Math.max(1, Math.floor(Number(patch.repeat) || 1));
    return out;
  }

  let persistTimer = 0;
  function persistPoints() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try { chrome.storage.local.set({ [PKEY]: S.points }); } catch (_) {}
    }, 200);
  }
  function renderMarks() {
    const parts = [];
    S.points.forEach((p, i) => {
      const pos = resolve(p, false);
      if (pos.x < 0 || pos.y < 0 || pos.x > innerWidth || pos.y > innerHeight) return;
      parts.push(`<div class="mark" style="left:${pos.x}px;top:${pos.y}px">${i + 1}</div>`);
    });
    $('marks').innerHTML = parts.join('');
  }
  function changed() { renderMarks(); persistPoints(); }

  let rafPending = false;
  const scheduleMarks = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; renderMarks(); });
  };
  addEventListener('scroll', scheduleMarks, true);
  addEventListener('resize', scheduleMarks);

  // ---------- HUD ----------
  let hudAt = 0;
  function renderHud(force) {
    const h = $('hud');
    const now = Date.now();
    if (!force && now - hudAt < 100) return;
    hudAt = now;
    const warn = S.warn ? `<br><span class="w">${esc(S.warn)}</span>` : '';
    if (S.running) {
      const secs = Math.max((now - (S.startedAt || now)) / 1000, 0.001);
      const total = S.cfg.unlimited ? '∞' : S.cfg.maxClicks;
      h.style.display = 'block';
      h.innerHTML = `<b>● Çalışıyor</b>${S.usingTrusted ? ' · gerçek tıklama' : ''} &nbsp; ${S.count} / ${total} &nbsp; (${(S.count / secs).toFixed(1)}/sn)` +
        `<br>Durdur: ${esc(S.cfg.stopKey)} veya ${esc(S.cfg.toggleKey)}${warn}`;
    } else if (S.last && now - S.last.at < 3000) {
      const label = S.last.reason === 'done' ? 'Bitti' : S.last.reason === 'error' ? 'Hata' : 'Durdu';
      h.style.display = 'block';
      h.innerHTML = `<b class="s">■ ${label}</b> &nbsp; ${S.last.count} tıklama${warn}`;
      setTimeout(() => renderHud(true), 3100);
    } else {
      h.style.display = 'none';
    }
  }

  function ripple(x, y) {
    const d = document.createElement('div');
    d.className = 'rip';
    d.style.left = x + 'px';
    d.style.top = y + 'px';
    $('fx').appendChild(d);
    setTimeout(() => d.remove(), 450);
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; g.gain.value = 0.08;
      o.start();
      setTimeout(() => { try { o.stop(); ctx.close(); } catch (_) {} }, 180);
    } catch (_) {}
  }

  // ---------- Tıklama ----------
  function deepElementAt(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // Simüle (isTrusted=false) tıklama
  function fireClick(x, y, button) {
    const el = deepElementAt(x, y);
    if (!el || el === host) return;
    const right = button === 'right';
    const PE = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    const base = { bubbles: true, cancelable: true, composed: true, view: window,
                   clientX: x, clientY: y, screenX: x + screenX, screenY: y + screenY };
    const b = right ? 2 : 0;
    const down = { ...base, button: b, buttons: right ? 2 : 1 };
    const up = { ...base, button: b, buttons: 0 };
    const move = { ...base, button: 0, buttons: 0 };
    const ptr = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const fire = (type, init, C) => el.dispatchEvent(new (C || MouseEvent)(type, init));

    fire('pointerover', { ...move, ...ptr }, PE);
    fire('mouseover', move);
    fire('pointermove', { ...move, ...ptr }, PE);
    fire('mousemove', move);

    const rounds = button === 'double' ? 2 : 1;
    for (let i = 1; i <= rounds; i++) {
      fire('pointerdown', { ...down, ...ptr, detail: i }, PE);
      fire('mousedown', { ...down, detail: i });
      if (i === 1 && typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch (_) {} }
      fire('pointerup', { ...up, ...ptr, detail: i }, PE);
      fire('mouseup', { ...up, detail: i });
      if (right) {
        fire('contextmenu', { ...up, detail: i });
        fire('auxclick', { ...up, detail: i });
      } else {
        fire('click', { ...up, detail: i });
      }
    }
    if (button === 'double') fire('dblclick', { ...up, detail: 2 });
  }

  async function doClick(pos, button) {
    S.inj = { x: pos.x, y: pos.y };
    if (S.usingTrusted) {
      const r = await sendBg({ type: 'dbg-click', x: pos.x, y: pos.y, button });
      if (!r || !r.ok) throw new Error((r && r.error) || 'Tıklama gönderilemedi');
    } else {
      fireClick(pos.x, pos.y, button);
    }
    if (S.cfg.ripple && S.cfg.interval >= 40) ripple(pos.x, pos.y);
    S.count++;
  }

  function withJitter(pos) {
    const j = Number(S.cfg.jitterPx) || 0;
    if (!j) return pos;
    return {
      x: Math.min(innerWidth - 1, Math.max(0, pos.x + rnd() * j)),
      y: Math.min(innerHeight - 1, Math.max(0, pos.y + rnd() * j))
    };
  }
  const waitMs = (base) => sleep(Math.max(1, Number(base) + (S.cfg.jitter ? rnd() * S.cfg.jitter : 0)));
  function limitHit() {
    const c = S.cfg;
    if (!c.unlimited && S.count >= c.maxClicks) return true;
    if (c.maxSeconds > 0 && Date.now() - S.startedAt >= c.maxSeconds * 1000) return true;
    return false;
  }

  async function loop(id) {
    if (S.cfg.startDelay > 0) await sleep(S.cfg.startDelay);
    if (!alive(id)) return;
    S.startedAt = Date.now();
    let reason = 'done';
    try {
      outer: while (alive(id)) {
        if (S.cfg.mode === 'multi') {
          const pts = S.points.slice();
          if (!pts.length) { S.warn = 'Nokta yok'; reason = 'error'; break; }
          for (const p of pts) {
            const reps = Math.max(1, Number(p.repeat) || 1);
            for (let k = 0; k < reps; k++) {
              if (!alive(id)) return;
              await doClick(withJitter(resolve(p, true)), p.button || S.cfg.button);
              if (limitHit()) break outer;
              const lastRep = k === reps - 1;
              await waitMs(lastRep && p.delay != null ? p.delay : S.cfg.interval);
            }
          }
          if (S.cfg.cycleDelay > 0) await sleep(S.cfg.cycleDelay);
        } else {
          await doClick(withJitter({ x: S.mouse.x, y: S.mouse.y }), S.cfg.button);
          if (limitHit()) break;
          await waitMs(S.cfg.interval);
        }
        renderHud();
      }
    } catch (e) {
      S.warn = 'Hata: ' + ((e && e.message) || e);
      reason = 'error';
    }
    if (S.runId === id) stop(reason);
  }

  async function start(cfg) {
    if (S.running) return;
    if (cfg) for (const k of KEYS) if (k in cfg) S.cfg[k] = cfg[k];
    normalizeCfg(S.cfg);
    if (S.cfg.mode === 'multi' && !S.points.length) {
      S.warn = 'Önce en az bir nokta seç';
      S.last = { reason: 'error', count: 0, at: Date.now() };
      renderHud(true);
      return;
    }
    S.running = true;
    S.count = 0;
    S.warn = '';
    S.last = null;
    S.usingTrusted = false;
    S.startedAt = 0;
    const id = ++S.runId;
    if (S.cfg.trusted) {
      let ok = false;
      try {
        const r = await sendBg({ type: 'dbg-attach' });
        ok = !!(r && r.ok);
        if (!ok) S.warn = 'Gerçek tıklama açılamadı, simüle ediliyor: ' + ((r && r.error) || '');
      } catch (e) {
        S.warn = 'Gerçek tıklama açılamadı, simüle ediliyor: ' + ((e && e.message) || e);
      }
      if (S.runId !== id) {            // bağlanırken durduruldu
        if (ok) sendBg({ type: 'dbg-detach' }).catch(() => {});
        return;
      }
      S.usingTrusted = ok;
    }
    renderHud(true);
    loop(id);
  }

  function stop(reason) {
    if (!S.running) return;
    reason = reason || 'user';
    const wasTrusted = S.usingTrusted;
    S.running = false;
    S.runId++;
    S.usingTrusted = false;
    if (wasTrusted) sendBg({ type: 'dbg-detach' }).catch(() => {});
    if (reason === 'done' && S.cfg.beep) beep();
    setTimeout(() => { if (!S.running) S.inj = null; }, 300);
    S.last = { reason, count: S.count, at: Date.now() };
    renderHud(true);
  }

  // ---------- Nokta seçme ----------
  function startPick() {
    if (S.running) stop('user');
    S.picking = true;
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); window.focus(); } catch (_) {}
    $('pick').style.display = 'block';
    $('tip').style.display = 'block';
  }
  function endPick() {
    S.picking = false;
    $('pick').style.display = 'none';
    $('tip').style.display = 'none';
  }
  $('pick').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const pk = $('pick');
    pk.style.display = 'none';
    const p = makePoint(e.clientX, e.clientY);
    pk.style.display = 'block';
    S.points.push(p);
    changed();
  });
  $('pick').addEventListener('contextmenu', (e) => { e.preventDefault(); endPick(); });

  // ---------- Fare konumu & kısayollar ----------
  // Kendi gönderdiğimiz (konum sapmalı) fare olayları imleç konumunu kaydırmasın
  addEventListener('mousemove', (e) => {
    const j = S.inj;
    if (j && Math.abs(e.clientX - j.x) < 1 && Math.abs(e.clientY - j.y) < 1) return;
    S.mouse.x = e.clientX;
    S.mouse.y = e.clientY;
  }, true);

  function handleKey(code, e) {
    const block = () => { if (e) { e.preventDefault(); e.stopPropagation(); } };
    if (S.picking) {
      if (code === 'Escape' || code === 'Enter') { block(); endPick(); return true; }
      return false;
    }
    if (e) {
      const t = e.target;
      const typing = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
      if (typing && !/^(F\d+|Escape)$/.test(code)) return false;
    }
    if (code === S.cfg.toggleKey) {
      block();
      if (e && e.repeat) return true;
      S.running ? stop('user') : start();
      return true;
    }
    if (S.running && code === S.cfg.stopKey) { block(); stop('user'); return true; }
    return false;
  }
  addEventListener('keydown', (e) => { handleKey(e.code, e); }, true);

  // ---------- Ayarlar ve noktalar (kalıcı) ----------
  try {
    chrome.storage.local.get([...KEYS, PKEY], (v) => {
      for (const k of KEYS) if (v[k] !== undefined) S.cfg[k] = v[k];
      if (Array.isArray(v[PKEY])) { S.points = v[PKEY].filter(validPoint).map(cleanPoint); renderMarks(); }
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      for (const k of KEYS) if (ch[k]) S.cfg[k] = ch[k].newValue;
    });
  } catch (_) {}

  // ---------- Popup / arka plan ile iletişim ----------
  function snapshot() {
    return { running: S.running, count: S.count, warn: S.warn, trusted: S.usingTrusted, points: S.points };
  }
  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    switch (msg.type) {
      case 'start': start(msg.cfg); break;
      case 'stop': stop('user'); break;
      case 'toggle': S.running ? stop('user') : start(msg.cfg); break;
      case 'pick': startPick(); break;
      case 'clear': S.points = []; changed(); break;
      case 'undo': S.points.pop(); changed(); break;
      case 'removePoint': S.points.splice(msg.i, 1); changed(); break;
      case 'updatePoint': {
        const p = S.points[msg.i];
        if (p) { Object.assign(p, sanitizePatch(msg.patch)); changed(); }
        break;
      }
      case 'setPoints':
        S.points = Array.isArray(msg.points) ? msg.points.filter(validPoint).map(cleanPoint) : [];
        changed();
        break;
      case 'key': handleKey(msg.code, null); break;
      case 'dbg-detached':
        if (S.running && S.usingTrusted) { S.warn = 'Hata ayıklama bağlantısı kapatıldı'; stop('error'); }
        break;
      case 'status': break;
    }
    send(snapshot());
    return true;
  });
})();
