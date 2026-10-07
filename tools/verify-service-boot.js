// Boot the service exactly the way the webOS runtime would, with only
// `webos-service` stubbed, and assert that every Luna method the frontend
// calls is actually registered.
//
// This is the closest we can get to "does the .ipk's service start on a TV"
// without a TV. It catches the failures that a static review misses: a bad
// relative require after packaging, a vendor file that will not parse, a
// missing module in the shipped tree.

const path = require('path');
const Module = require('module');

const SVC_DIR = path.join(__dirname, '..', 'service', 'com.hongguowebos.app.service');

const registered = new Map();
let serviceName = null;

function ServiceStub(name) {
  serviceName = name;
}
ServiceStub.prototype.register = function (uri, fn) { registered.set(uri, fn); };
ServiceStub.prototype.subscribe = function () { return { on() {}, removeAllListeners() {} }; };
ServiceStub.prototype.call = function () {};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'webos-service') return ServiceStub;
  return origLoad.apply(this, arguments);
};

let failed = 0;
const ok = (cond, label, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};

try {
  require(path.join(SVC_DIR, 'service.js'));
  ok(true, 'service.js evaluates from the packaged layout');
} catch (e) {
  ok(false, 'service.js evaluates from the packaged layout', e.message);
  console.log(e.stack.split('\n').slice(0, 8).join('\n'));
}

console.log(`\nservice name: ${serviceName}`);

// The frontend's client.js calls exactly these. Note the health check is
// registered as `ping`; `probeService()` is only the frontend FUNCTION name,
// so `probe` is deliberately not in this list.
const EXPECTED = ['ping', 'getHome', 'getCategory', 'getSearch', 'getDetail', 'getDiagnostics', 'shutdown'];
console.log('\nregistered Luna methods:');
for (const [uri] of registered) console.log('  ' + uri);

console.log('');
for (const m of EXPECTED) {
  const hit = [...registered.keys()].some((u) => u === m || u.endsWith('/' + m) || u.endsWith('.' + m));
  ok(hit, `method registered: ${m}`);
}

ok(registered.size >= EXPECTED.length, 'all expected methods present', `${registered.size} registered`);

console.log(`\n${failed === 0 ? 'SERVICE BOOT GREEN' : `SERVICE BOOT FAILED (${failed})`}`);
// The service keeps timers and a listening socket; exit explicitly.
process.exit(failed ? 1 : 0);
