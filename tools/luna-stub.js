// Shared Luna-bridge stub for offline frontend checks.
//
// Stubs at the `PalmServiceBridge` level, NOT at `webOS.service` level: the real
// webOSTV.js wraps that class and calls `.call(uri, json)` with an
// `onservicecallback`, so stubbing higher up would skip webOSTV.js's own logic
// entirely (and, as an earlier attempt showed, makes it throw
// "this.bridge.call is not a function").
//
// Returns real strings so it can be injected verbatim into a <script> tag.

const banner = (i) => ({
  id: `b${i}`,
  title: ['总裁的替身新娘', '重生之都市战神', '千金归来', '闪婚老公竟是首富'][i] || `推荐 ${i}`,
  cover: '',
  description: '一段跌宕起伏的故事，从意外的相遇开始，命运由此改写。',
  tags: '都市 逆袭 甜宠',
  badge: '热播'
});

const TITLES = [
  '首辅娇娘', '聚宝仙盆之崛起', '我在古代当首富', '重生之嫡女归来',
  '无敌从签到开始', '九天剑帝', '都市医仙', '绝世武魂'
];

const card = (i) => ({
  id: String(7691228619774905368n + BigInt(i)),
  title: TITLES[i % 8] + (i >= 8 ? ` 第${Math.floor(i / 8) + 1}季` : ''),
  cover: '',
  badge: `全 ${60 + i * 7} 集`,
  tags: ['都市', '玄幻', '逆袭', '甜宠'][i % 4],
  episodeCount: 60 + i * 7
});

function buildStub() {
  const home = {
    returnValue: true,
    banners: Array.from({ length: 4 }, (_, i) => banner(i)),
    sections: [
      { key: 's1', title: '为你推荐', items: Array.from({ length: 9 }, (_, i) => card(i)) },
      { key: 's2', title: '热播短剧', items: Array.from({ length: 9 }, (_, i) => card(i + 9)) },
      { key: 's3', title: '高分必看', items: Array.from({ length: 9 }, (_, i) => card(i + 18)) }
    ]
  };

  const category = {
    returnValue: true,
    key: 'real', name: '真人剧', page: 1,
    items: Array.from({ length: 24 }, (_, i) => card(i)),
    filters: [{
      id: 'genre', name: '题材', items: [
        { id: 'urban', name: '都市' }, { id: 'xuanhuan', name: '玄幻' },
        { id: 'sweet', name: '甜宠' }, { id: 'counter', name: '逆袭' }
      ]
    }],
    pagination: { page: 1, totalPages: 34, total: 800 }
  };

  const detail = {
    returnValue: true,
    id: '7691228619774905368',
    title: '首辅娇娘',
    cover: '',
    rating: '9.2',
    episodeCount: 222,
    badge: '完结',
    tags: '古装 甜宠 逆袭 权谋',
    description: '前世被算计致死，今生她携医术与谋略归来，一步步走到权倾朝野的位置。',
    episodes: Array.from({ length: 222 }, (_, i) => ({
      id: String(7691249364097829913n + BigInt(i)),
      number: i + 1,
      title: `第${i + 1}集`
    }))
  };

  // Frozen so the injected JSON cannot be reinterpreted as live code.
  return `
(function () {
  var PORT = 7655;
  var FIXTURES = ${JSON.stringify({ home, category, detail })};
  var HANDLERS = {
    ping: function () {
      return { returnValue: true, service: 'com.hongguowebos.app.service', node: 'v16.20.2',
               mediaPort: PORT, upstream: { upstream: 'ok', crypto: 'sm3: pure-JS shim installed' } };
    },
    getHome: function () { return FIXTURES.home; },
    getCategory: function () { return FIXTURES.category; },
    getDetail: function () { return FIXTURES.detail; },
    getSearch: function () {
      return { returnValue: false, errorCode: 'SEARCH_UNAVAILABLE',
               errorText: '搜索暂不可用（上游已限制该接口）' };
    },
    getDiagnostics: function () {
      return { returnValue: true, service: 'com.hongguowebos.app.service', node: 'v16.20.2',
               mediaPort: PORT,
               upstream: { upstream: 'ok', crypto: 'sm3: pure-JS shim installed (runtime has no native SM3)' },
               media: { served: 128, bytes: 134217728, errors: 0 }, recentErrors: [] };
    }
  };

  var CALLS = [];
  window.PalmServiceBridge = function () {
    var self = this;
    this.onservicecallback = null;
    this.call = function (uri, payload) {
      var method = String(uri).split('/').pop();
      var params = {};
      try { params = JSON.parse(payload || '{}'); } catch (e) {}
      CALLS.push({ uri: uri, method: method, params: params });
      setTimeout(function () {
        var fn = HANDLERS[method];
        var out = fn ? fn(params)
                     : { returnValue: false, errorCode: 'NO_METHOD', errorText: 'no such method: ' + method };
        if (self.onservicecallback) self.onservicecallback(JSON.stringify(out));
      }, 20);
    };
    this.cancel = function () { self.onservicecallback = null; };
  };
  window.__lunaCalls = CALLS;

  window.PalmSystem = window.PalmSystem || {
    deviceInfo: JSON.stringify({
      modelName: 'OLED55C1', platformVersion: '6.4.0',
      platformVersionMajor: 6, platformVersionMinor: 4, platformVersionDot: 0,
      screenWidth: 1920, screenHeight: 1080
    }),
    identifier: 'com.hongguowebos.app 1.0.0',
    platformBack: function () { window.__backPressed = (window.__backPressed || 0) + 1; }
  };
  window.Mojo = window.Mojo || { relaunch: function () {} };
})();
`;
}

module.exports = { buildStub, card, banner, TITLES };
