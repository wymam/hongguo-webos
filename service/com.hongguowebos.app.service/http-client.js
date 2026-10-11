// Minimal axios-compatible HTTP client for the vendored red-berry signing
// layer, backed by Node's own http/https. Shipping real axios inside an .ipk
// would add ~1.5MB of dependencies for four call sites, and webOS services
// have no npm install at runtime.
//
// Surface used by the vendored source is deliberately small:
//   axios(url, { headers, timeout, responseType: 'text'|'arraybuffer' })
//   axios.post(url, body, { headers, timeout, responseType: 'text' })
//
// Resolves to { status, statusText, headers, data } exactly like axios.
// Rejects with an Error carrying .code / .status for the callers' try/catch.
'use strict';

var http = require('http');
var https = require('https');
var URL = require('url').URL;

// webOS sets a restrictive default; keep sockets warm between the many
// sequential segment fetches during playback.
var agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 6, keepAliveMsecs: 15000 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 6, keepAliveMsecs: 15000 })
};

function toBuffer(data) {
  if (data == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  return Buffer.from(String(data), 'utf8');
}

// ---------- transient pre-connect retry ----------
//
// On the owner's network the TV's resolver intermittently fails for hostnames
// that resolve fine seconds before and after (measured: one `DNS lookup
// failed` / ENOTFOUND in 182 media requests). The layers above retry their own
// operations, but every one of them bottoms out HERE — so a blip during any
// single attempt still propagates as an error unless this layer is persistent
// too. Retrying at the source turns "one attempt in twenty dies" into "one
// attempt in many thousand dies".
//
// Only PRE-CONNECT failures are retried: DNS resolution and connection
// establishment. At that point the request provably never reached the server
// (nothing was sent, nothing was processed), so a retry is safe for ANY method
// — including the signed POSTs this service makes. Errors after bytes have
// been written (ECONNRESET on response, response timeout) are NOT retried
// here: the caller knows its own semantics and can decide.
var RETRYABLE_PRE_CONNECT = /^E(NOTFOUND|AI_AGAIN|CONNREFUSED|HOSTUNREACH|NETUNREACH|ADDRNOTAVAIL)$/;
var MAX_RETRIES = 2;
var RETRY_DELAY_MS = [250, 700];

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function request(options) {
  return attemptRequest(options, 0);
}

function attemptRequest(options, attempt) {
  return doRequest(options).catch(function (err) {
    var code = (err && err.code) || '';
    if (!RETRYABLE_PRE_CONNECT.test(code) || attempt >= MAX_RETRIES) throw err;
    return sleep(RETRY_DELAY_MS[attempt] || 700).then(function () {
      return attemptRequest(options, attempt + 1);
    });
  });
}

function doRequest(options) {
  var url = options.url;
  var method = (options.method || 'GET').toUpperCase();
  var headers = options.headers || {};
  var timeout = options.timeout || 20000;
  var responseType = options.responseType || 'text';
  var body = options.data != null ? toBuffer(options.data) : null;

  return new Promise(function (resolve, reject) {
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(new Error('Invalid URL: ' + String(url).slice(0, 120)));
      return;
    }

    var isHttps = parsed.protocol === 'https:';
    var transport = isHttps ? https : http;

    var finalHeaders = {};
    var key;
    for (key in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, key) && headers[key] != null) {
        finalHeaders[key] = headers[key];
      }
    }
    if (body && finalHeaders['Content-Length'] == null) {
      finalHeaders['Content-Length'] = String(body.length);
    }
    finalHeaders.Host = parsed.host;

    var reqOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method,
      headers: finalHeaders,
      agent: agents[parsed.protocol],
      // Upstream TLS is a normal public chain; webOS service has its own roots
      rejectUnauthorized: true
    };

    var settled = false;
    function fail(err) {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch (e) { /* already gone */ }
      reject(err);
    }

    var req = transport.request(reqOptions, function (res) {
      var chunks = [];
      var size = 0;
      res.on('data', function (chunk) {
        // Cap in-flight buffering: segment fetches are 1MiB, lookups are small.
        size += chunk.length;
        if (size > 32 * 1024 * 1024) {
          fail(new Error('Response too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', fail);
      res.on('end', function () {
        if (settled) return;
        settled = true;
        var raw = Buffer.concat(chunks);
        var data;
        if (responseType === 'arraybuffer') {
          // Hand back a real ArrayBuffer-like view, matching axios.
          data = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
        } else {
          data = raw.toString('utf8');
        }
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: res.headers,
          data: data,
          config: options
        });
      });
    });

    req.setTimeout(timeout, function () {
      var err = new Error('timeout of ' + timeout + 'ms exceeded');
      err.code = 'ECONNABORTED';
      fail(err);
    });

    req.on('error', function (err) {
      // Normalise the shape axios callers expect; never leak signed headers.
      if (err && err.code === 'ENOTFOUND') err.message = 'DNS lookup failed';
      fail(err);
    });

    if (body) req.write(body);
    req.end();
  });
}

function axios(url, config) {
  config = config || {};
  return request({
    url: url,
    method: config.method || 'GET',
    headers: config.headers,
    data: config.data != null ? config.data : config.body,
    timeout: config.timeout,
    responseType: config.responseType
  });
}

axios.get = function (url, config) {
  config = config || {};
  config.method = 'GET';
  return axios(url, config);
};

axios.post = function (url, data, config) {
  config = config || {};
  config.method = 'POST';
  config.data = data;
  return axios(url, config);
};

axios.request = request;
axios.agents = agents;

module.exports = axios;
