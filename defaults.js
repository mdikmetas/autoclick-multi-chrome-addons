// Tüm betikler (arka plan, içerik, popup) için tek varsayılan ayar kaynağı.
globalThis.EHM_DEFAULTS = {
  mode: 'cursor',      // cursor | multi
  trusted: false,      // gerçek tıklama (chrome.debugger)
  button: 'left',      // left | right | double
  interval: 100,       // ms
  jitter: 0,           // ± ms rastgelelik
  jitterPx: 0,         // ± piksel konum sapması
  maxClicks: 100,
  unlimited: false,
  maxSeconds: 0,       // 0 = kapalı
  cycleDelay: 0,       // multi modda tur sonu ek bekleme (ms)
  startDelay: 0,       // başlamadan önce bekleme (ms)
  beep: false,
  ripple: true,
  toggleKey: 'F8',
  stopKey: 'Escape'
};
