// Frontend ⇄ Luna service bridge.
//
// The browser side of a webOS app has NO direct network access to the signed
// red-berry APIs — that all lives in the JS service. So every data call here
// is a Luna request, and video is a plain <video> pointed at the service's
// loopback media proxy.
//
// Outside the TV (dev in a browser) `window.webOS.service` is absent. We then
// fall back to a dev bridge on 127.0.0.1:9529 if one is running, and otherwise
// fail with a clear message rather than showing a mystery empty screen.

const SERVICE_ID = 'com.hongguowebos.app.service';
const SERVICE_URI = `luna://${SERVICE_ID}/`;
const DEV_BRIDGE = 'http://127.0.0.1:9529';

// The service picks 7655 and walks upward if it is taken; this is the first
// candidate and matches ping.mediaPort when the port was free.
const MEDIA_PORT_FALLBACK = 7655;

let mediaPort = MEDIA_PORT_FALLBACK;
let mediaPortKnown = false;

export function hasLunaService() {
  return !!(window.webOS && window.webOS.service && window.PalmServiceBridge);
}

// ---------- Luna transport ----------

function lunaCall(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!hasLunaService()) {
      reject(new Error('LUNA_UNAVAILABLE'));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('请求超时'));
    }, timeoutMs);

    let request;
    try {
      request = window.webOS.service.request(SERVICE_URI, {
        method,
        parameters: params,
        onSuccess: (res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (res && res.returnValue === false) {
            const err = new Error(res.errorText || '服务返回失败');
            err.code = res.errorCode || 'SERVICE_ERROR';
            reject(err);
            return;
          }
          resolve(res);
        },
        onFailure: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error((err && (err.errorText || err.message)) || '服务不可用'));
        }
      });
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    }
  });
}

// Wrap a call so SDUI-facing code can always `.catch` without caring whether
// we are on a TV or in a dev browser.
function call(method, params, timeoutMs) {
  return lunaCall(method, params, timeoutMs);
}

// ---------- dev bridge (browser only) ----------

export function isDevMode() {
  return !hasLunaService();
}

async function devCall(method, params) {
  const res = await fetch(`${DEV_BRIDGE}/luna/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {})
  });
  if (!res.ok) throw new Error(`dev bridge HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.returnValue === false) {
    const err = new Error(data.errorText || 'dev bridge error');
    err.code = data.errorCode || 'SERVICE_ERROR';
    throw err;
  }
  return data;
}

function invoke(method, params, timeoutMs) {
  if (hasLunaService()) return call(method, params, timeoutMs);
  return devCall(method, params);
}

// ---------- public API ----------

// Prime the media port so video URLs are correct before the first play.
export async function probeService() {
  try {
    const res = await invoke('ping', {});
    if (res && res.mediaPort) {
      mediaPort = res.mediaPort;
      mediaPortKnown = true;
    }
    return { ok: true, info: res };
  } catch (e) {
    return { ok: false, error: e };
  }
}

export function getMediaPort() {
  return mediaPort;
}

export async function getHome() {
  return invoke('getHome', {}, 30000);
}

// `minItems` exists because upstream paginates at 24 — barely three rows — so a
// "page" was over before the viewer had scrolled. The service keeps pulling the
// following pages until the screen holds a real list (>= 50).
export async function getCategory(key, page = 1, genre = '', minItems = 50) {
  return invoke('getCategory', { key, page, genre, minItems }, 45000);
}

// Portrait/landscape for a batch of series, read from the video itself.
//
// `entries` is [{ seriesId, episodeId }]. Returns [{ seriesId, episodeId,
// width, height }]; anything unreadable is simply absent from the result.
// Never throws for a partial failure: a missing badge is cosmetic, a rejected
// promise would take the whole grid with it.
export async function getAspects(entries) {
  if (!entries || !entries.length) return { items: [], probed: 0 };
  try {
    // 8 lanes, not 3. A cold probe (first visit to a page) pays a full resolve
    // + range per episode; at 3 lanes a 24-item batch took ~40s, so a 72-card
    // page was still filling badges a minute after it opened — which reads as
    // "some cards tagged, some not". The probe is a small range read, so the
    // extra parallelism is cheap next to the wait.
    return await invoke('getAspects', { entries, concurrency: 12 }, 60000);
  } catch (e) {
    return { items: [], probed: 0, error: (e && e.message) || String(e) };
  }
}

export async function getSearch(keyword, page = 1) {
  return invoke('getSearch', { keyword, page }, 30000);
}

export async function getDetail(id) {
  return invoke('getDetail', { id: String(id) }, 30000);
}

export async function getDiagnostics() {
  return invoke('getDiagnostics', {}, 20000);
}

// ---------- 播放性能诊断 ----------
export async function benchMedia(episodeId) {
  return invoke('benchMedia', { episodeId: String(episodeId) }, 120000);
}

// ---------- 扫码登录 ----------
export async function qrStart() {
  return invoke('qrStart', {}, 20000);
}
export async function qrPoll(token) {
  return invoke('qrPoll', { token: String(token) }, 15000);
}
export async function qrFinalize(redirectUrl) {
  return invoke('qrFinalize', { redirectUrl: String(redirectUrl || '') }, 20000);
}
export async function qrStatus() {
  return invoke('qrStatus', {}, 15000);
}
export async function qrLogout() {
  return invoke('qrLogout', {}, 10000);
}

// The URL the TV player consumes. Range requests are handled by the service.
export function mediaUrl(episodeId) {
  return `http://127.0.0.1:${mediaPort}/media/${episodeId}`;
}

// ---------- test hooks ----------
if (typeof window !== 'undefined') {
  window.__hongguoApi = {
    hasLunaService,
    isDevMode,
    probeService,
    getHome,
    getCategory,
    getSearch,
    getDetail,
    getAspects,
    getDiagnostics,
    benchMedia,
    qrStart,
    qrPoll,
    qrFinalize,
    qrStatus,
    qrLogout,
    mediaUrl,
    getMediaPort
  };
}
