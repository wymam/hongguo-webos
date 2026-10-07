(function () {
  // PM retest: the long-press card menu.
  //   1. opening it must put the ring ON the menu (not leave it on the card),
  //   2. Down must walk the stacked rows,
  //   3. closing it must hand the ring back to the card it came from —
  //      previously focus died with the menu's own id and the next arrow press
  //      dumped the viewer on the rail.
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function key(k, code) {
    var init = { key: k, keyCode: code, which: code, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init));
  }
  const DOWN = 40, UP = 38, LEFT = 37;
  function cur() {
    var el = document.querySelector('.focused');
    return el ? el.getAttribute('data-focus-id') : null;
  }
  function curText() {
    var el = document.querySelector('.focused');
    return el ? (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24) : null;
  }
  function snap(tag) { out.steps.push(tag + '=' + cur() + '(' + curText() + ')'); }

  function ensureClean() {
    function step(n) {
      if (!document.querySelector('.player-root') || n > 8) return sleep(1000);
      window.dispatchEvent(new CustomEvent('tv-back'));
      return sleep(900).then(function () { return step(n + 1); });
    }
    return step(0);
  }

  return ensureClean().then(function () {
    // Park on a real card so we can prove the ring comes back to it.
    var nav = document.querySelector('[data-focus-id="sidebar-1-0"]'); // 推荐
    if (nav) nav.click();
    return sleep(2800);
  }).then(function () {
    key('ArrowRight', 39);
    return sleep(1600);
  }).then(function () {
    out.beforeMenu = cur();
    snap('onCard');
    // Open the menu. A synthetic detail is safe: only 关闭 is exercised, so no
    // favourite/history write happens.
    window.dispatchEvent(new CustomEvent('card-menu', {
      detail: { id: 'probe-menu', title: 'probe' }
    }));
    return sleep(700);
  }).then(function () {
    snap('menuOpened');
    out.menuExists = !!document.querySelector('.cardmenu');
    out.ringOnMenu = !!cur() && String(cur()).indexOf('menu-') === 0;
    key('ArrowDown', DOWN);
    return sleep(380);
  }).then(function () {
    snap('afterDown1');
    key('ArrowDown', DOWN);
    return sleep(380);
  }).then(function () {
    snap('afterDown2');
    out.walkedToClose = cur() === 'menu-2-0';
    // Left must NOT escape through the scrim to the rail while the menu is up.
    key('ArrowLeft', LEFT);
    return sleep(380);
  }).then(function () {
    snap('afterLeft');
    out.leftStaysInMenu = !!cur() && String(cur()).indexOf('menu-') === 0;
    return sleep(200);
  }).then(function () {
    // Close it (Enter on 关闭) and see where the ring lands.
    var close = document.querySelector('[data-focus-id="menu-2-0"]');
    if (close) close.click();
    return sleep(800);
  }).then(function () {
    snap('afterClose');
    out.menuGone = !document.querySelector('.cardmenu');
    out.ringBackOnCard = !!cur() && String(cur()).indexOf('content-') === 0;
    out.returnedToSameCard = cur() === out.beforeMenu;
    out.ok = out.ringOnMenu && out.walkedToClose && out.leftStaysInMenu
      && out.menuGone && out.ringBackOnCard;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
