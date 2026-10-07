'use strict';
// 红果短剧扫码登录（用「抖音 / 番茄小说 App」扫码），复用官网同源 passport 接口。
//
// 实测接口（2026-10，与番茄小说官网同源，aid 必须 2503）：
//   GET /passport/web/get_qrcode/      -> { data: { token, qrcode(base64 PNG), expire_time } }
//   GET /passport/web/check_qrconnect/ -> { data: { status, redirect_url, error_code } }
//     status: new=等待扫码, scan=已扫码, confirm/success=已确认（返回 redirect_url）
// 确认后跟随 redirect_url 捕获 Set-Cookie，再用 /api/user/info/v2 校验登录态。
//
// Cookie 按域名存内存并落盘，供后续「播放记录云同步」复用。

var https = require('https');
var http = require('http');
var fs = require('fs');
var URL = require('url').URL;

var HOST = 'https://hongguoduanju.com';
var NEXT_URL = HOST + '/';
var PASSPORT_QUERY =
  'aid=2503&app_name=novelapp&version_code=57700&device_platform=web&channel=novel' +
  '&sdk_version=1.6.1&passport_sdk_version=2.0.0&new_user=0';

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------- cookie jar ----------
// domain -> { name: value }。TV 重启后从文件恢复，避免每次开机都扫码。
var cookies = {};
var AUTH_FILE = '/media/internal/hongguo_auth.json';

function loadCookies() {
  try {
    var raw = fs.readFileSync(AUTH_FILE, 'utf8');
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') cookies = parsed;
  } catch (e) {
    cookies = {};
  }
}

function saveCookies() {
  try { fs.writeFileSync(AUTH_FILE, JSON.stringify(cookies)); } catch (e) { /* 只读目录时降级为内存态 */ }
}

function cookieHeader(url) {
  var host;
  try { host = new URL(url).hostname; } catch (e) { return ''; }
  var parts = [];
  for (var domain in cookies) {
    if (host === domain || host.indexOf('.' + domain) >= 0 && host.slice(-domain.length - 1) === '.' + domain) {
      var m = cookies[domain];
      for (var name in m) parts.push(name + '=' + m[name]);
    }
  }
  return parts.join('; ');
}

function setCookies(setCookieHeaders, url) {
  if (!setCookieHeaders) return;
  var host;
  try { host = new URL(url).hostname; } catch (e) { return; }
  var arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (var i = 0; i < arr.length; i++) {
    var sc = String(arr[i]);
    var first = sc.split(';')[0].trim();
    var eq = first.indexOf('=');
    if (eq <= 0) continue;
    var name = first.slice(0, eq).trim();
    var value = first.slice(eq + 1).trim();
    var domain = host;
    var parts = sc.split(';');
    for (var j = 1; j < parts.length; j++) {
      var kv = parts[j].trim();
      var k = kv.split('=')[0].trim().toLowerCase();
      var v = kv.split('=').slice(1).join('=').trim();
      if (k === 'domain' && v) domain = v.replace(/^\./, '').toLowerCase();
    }
    if (!cookies[domain]) cookies[domain] = {};
    cookies[domain][name] = value;
  }
  saveCookies();
}

function clearCookies() {
  cookies = {};
  try { fs.unlinkSync(AUTH_FILE); } catch (e) { /* ignore */ }
}

// ---------- HTTP GET（带 cookie + 手动重定向） ----------
function get(url, opts, redirects) {
  opts = opts || {};
  redirects = redirects || 0;
  if (redirects > 10) return Promise.reject(new Error('重定向过多'));
  return new Promise(function (resolve, reject) {
    var parsed;
    try { parsed = new URL(url); } catch (e) { reject(new Error('无效 URL')); return; }
    var isHttps = parsed.protocol === 'https:';
    var headers = {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Host': parsed.host
    };
    if (opts.referer) headers.Referer = opts.referer;
    if (opts.origin) headers.Origin = opts.origin;
    var ck = cookieHeader(url);
    if (ck) headers.Cookie = ck;

    var transport = isHttps ? https : http;
    var req = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: headers
    }, function (res) {
      setCookies(res.headers['set-cookie'], url);
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var status = res.statusCode;
        var body = Buffer.concat(chunks).toString('utf8');
        if (status >= 300 && status < 400 && res.headers.location) {
          var loc = new URL(res.headers.location, url).toString();
          resolve(get(loc, opts, redirects + 1));
          return;
        }
        resolve({ status: status, headers: res.headers, body: body, url: url });
      });
    });
    req.setTimeout(20000, function () { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function getJson(url, opts) {
  return get(url, opts).then(function (resp) {
    var j = null;
    try { j = JSON.parse(resp.body); } catch (e) { /* non-JSON */ }
    return { resp: resp, json: j };
  });
}

// ---------- 登录流程 ----------
function qrStart() {
  var url = HOST + '/passport/web/get_qrcode/?next=' + encodeURIComponent(NEXT_URL) + '&' + PASSPORT_QUERY;
  return getJson(url, { referer: HOST + '/', origin: HOST }).then(function (r) {
    var d = (r.json && (r.json.data || r.json)) || {};
    if (!d.token) throw new Error('获取二维码失败：缺少 token');
    return {
      token: String(d.token),
      qrcode: String(d.qrcode || ''),
      expireTime: Number(d.expire_time || 0),
      webName: String(d.web_name || '')
    };
  });
}

function qrPoll(token) {
  var url = HOST + '/passport/web/check_qrconnect/?next=' + encodeURIComponent(NEXT_URL) +
    '&token=' + encodeURIComponent(token) + '&' + PASSPORT_QUERY;
  return getJson(url, { referer: HOST + '/', origin: HOST }).then(function (r) {
    var d = (r.json && (r.json.data || r.json)) || {};
    return {
      status: String(d.status || ''),
      redirectUrl: String(d.redirect_url || d.redirectUrl || d.url || d.next_url || ''),
      errorCode: Number(d.error_code || (r.json && r.json.error_code) || 0)
    };
  });
}

// 扫码确认后，跟随跳转捕获会话 cookie，再校验登录态，返回用户信息。
function qrFinalize(redirectUrl) {
  var urls = [redirectUrl, NEXT_URL];
  var seq = Promise.resolve();
  urls.forEach(function (u) {
    if (!u) return;
    seq = seq.then(function () {
      return get(u, { referer: HOST + '/', origin: HOST }).catch(function () { return null; });
    });
  });
  return seq.then(function () { return qrUserInfo(); });
}

// 校验登录态并返回用户信息（未登录返回 null）。
function qrUserInfo() {
  return getJson(HOST + '/api/user/info/v2', { referer: HOST + '/', origin: HOST }).then(function (r) {
    var j = r.json;
    // 不同后端结构略有差异，尽量宽容解析。
    var d = (j && (j.data || j.user || j.user_info)) || j || {};
    var id = d.id || d.user_id || d.uid || '';
    var name = d.name || d.nickname || d.user_name || d.nick_name || '';
    if (!id && !name) return null;
    return {
      id: String(id),
      name: String(name),
      avatar: String(d.avatar || d.avatar_url || d.icon || ''),
      isVip: !!(d.is_vip || d.vip || d.isVip)
    };
  }).catch(function () { return null; });
}

function qrStatus() {
  return qrUserInfo().then(function (user) {
    return { loggedIn: !!user, user: user };
  });
}

function qrLogout() {
  clearCookies();
  return { ok: true };
}

// 供「播放记录云同步」复用同一份 cookie。
function cookieStringFor(url) {
  return cookieHeader(url);
}

loadCookies();

module.exports = {
  qrStart: qrStart,
  qrPoll: qrPoll,
  qrFinalize: qrFinalize,
  qrStatus: qrStatus,
  qrLogout: qrLogout,
  qrUserInfo: qrUserInfo,
  cookieStringFor: cookieStringFor,
  get: get,
  getJson: getJson,
  HOST: HOST
};
