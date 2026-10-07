// Local (pure) check for the batch pager's windowing rule.
//
// Owner's rule (round 23, second pass):
//   "16页序号完全可以全部展现出来，超过16页再在前面有缩略"
//   -> up to 16 batches: show EVERY number, no ellipsis
//   -> past 16:        collapse the HEAD (ellipsis after 1), keep the viewer's
//                      neighbourhood and the tail whole
//
// Three zones: {1}, {around current}, {tail}. Zones that touch merge, so the
// ellipsis count is 0, 1 or 2 — never more, and the entry count is bounded.
//
// This mirrors `windowBatches` from CategoryPage.jsx. It is duplicated here
// rather than imported because the app is JSX and this check must stay
// dependency-free; the contract is small and pinned by the assertions below.
//
// Usage: node tools/local-pager-window.js

'use strict';

const PAGER_FULL_MAX = 16;
const PAGER_WINDOW_TAIL = 9;
const PAGER_WINDOW_NEI = 2;
const MAX_ENTRIES = 1 + (2 * PAGER_WINDOW_NEI + 1) + PAGER_WINDOW_TAIL + 2; // 17

function windowBatches(current, total) {
  const nums = [];
  if (total <= PAGER_FULL_MAX) {
    for (let n = 1; n <= total; n++) nums.push(n);
  } else {
    const tailFrom = Math.max(2, total - PAGER_WINDOW_TAIL + 1);
    const keep = new Set([1]);
    for (let n = tailFrom; n <= total; n++) keep.add(n);

    const nFrom = Math.max(2, current - PAGER_WINDOW_NEI);
    const nTo = Math.min(total, current + PAGER_WINDOW_NEI);
    for (let n = nFrom; n <= Math.min(nTo, tailFrom - 1); n++) keep.add(n);

    const sorted = Array.from(keep).sort((a, b) => a - b);
    sorted.forEach((n, i, arr) => {
      if (i && n - arr[i - 1] > 1) nums.push(null);
      nums.push(n);
    });
  }
  let slot = 0;
  return nums.map((n) => (n === null ? null : { n, slot: slot++ }));
}

function render(list) {
  return list.map((it) => (it === null ? '…' : it.n)).join(' ');
}
function numbersOf(list) {
  return list.filter((it) => it !== null).map((it) => it.n);
}
function slotsOf(list) {
  return list.filter((it) => it !== null).map((it) => it.slot);
}
function gapsOf(list) {
  return list.filter((it) => it === null).length;
}

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok: !!ok, detail });
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 1. Up to 16: every number, no ellipsis at all.
for (const total of [1, 2, 7, 12, 15, 16]) {
  const list = windowBatches(1, total);
  const nums = numbersOf(list);
  check(
    `total=${total} shows all ${total} numbers, no gap`,
    gapsOf(list) === 0 && nums.length === total && nums[0] === 1 && nums[nums.length - 1] === total,
    render(list)
  );
  const slots = slotsOf(list);
  check(`total=${total} slots are contiguous 0..${total - 1}`,
    slots.every((s, i) => s === i), JSON.stringify(slots));
}

// 2. At 17 the windowing starts, and the ellipsis is at the FRONT.
{
  const list = windowBatches(1, 17);
  const nums = numbersOf(list);
  check('total=17 keeps 1', nums[0] === 1, render(list));
  check('total=17 keeps the last', nums[nums.length - 1] === 17, render(list));
  check('total=17 gap sits at the front (index 1 or later, never last)',
    list[list.length - 1] !== null && gapsOf(list) >= 1, render(list));
  check('total=17 fits one line (<= 17 entries)', list.length <= MAX_ENTRIES, render(list));
}

// 3. Tail must always be complete, whoever the viewer is.
for (const total of [17, 24, 40, 100, 250, 999]) {
  const tailStart = total - PAGER_WINDOW_TAIL + 1;
  for (const current of [1, 2, 5, Math.ceil(total / 2), total - 3, total - 1, total]) {
    const list = windowBatches(current, total);
    const nums = numbersOf(list);
    const tail = nums.filter((n) => n >= tailStart);
    assert(tail.length === PAGER_WINDOW_TAIL,
      `total=${total} cur=${current}: tail incomplete (${tail.length}/${PAGER_WINDOW_TAIL})`);
  }
}
check('tail stays complete across 6 totals x 7 currents', true, `${PAGER_WINDOW_TAIL} numbers always`);

// 4. The viewer's batch is always on screen, and the run is always one line.
for (const total of [17, 24, 40, 100, 250, 999]) {
  for (const current of [1, 2, 5, Math.ceil(total / 2), total - 3, total - 1, total]) {
    const list = windowBatches(current, total);
    const nums = numbersOf(list);
    assert(nums.indexOf(current) >= 0, `total=${total} cur=${current}: current not shown`);
    assert(gapsOf(list) <= 2, `total=${total} cur=${current}: ${gapsOf(list)} gaps`);
    assert(list.length <= MAX_ENTRIES, `total=${total} cur=${current}: ${list.length} entries > ${MAX_ENTRIES}`);
    assert(nums[0] === 1, `total=${total} cur=${current}: lost 1`);
    assert(nums[nums.length - 1] === total, `total=${total} cur=${current}: lost the end`);
    assert(nums.every((n, i) => i === 0 || n > nums[i - 1]), `total=${total} cur=${current}: not increasing`);
    const slots = slotsOf(list);
    assert(slots.every((s, i) => s === i), `total=${total} cur=${current}: slots not contiguous`);
  }
}
check('current visible, <=2 gaps, <=17 entries, contiguous slots',
  true, '6 totals x 7 currents');

// 5. Zebra case: viewer near the TAIL must not spawn a second ellipsis.
for (const total of [17, 24, 40, 100]) {
  for (const current of [total - 3, total - 1, total]) {
    const list = windowBatches(current, total);
    assert(gapsOf(list) === 1,
      `total=${total} cur=${current}: expected ONE gap, got ${gapsOf(list)} (${render(list)})`);
  }
}
check('viewer inside the tail -> exactly one ellipsis', true, 'zones merged');

// 6. Zebra case: viewer at the head shows 2..3 before the ellipsis.
{
  const list = windowBatches(1, 40);
  const nums = numbersOf(list);
  check('total=40 cur=1 shows 1 2 3 then the tail',
    nums[0] === 1 && nums[1] === 2 && nums[2] === 3 && gapsOf(list) === 1, render(list));
}

let failed = 0;
console.log('--- pager windowing ---');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}   [${r.detail}]`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exitCode = 1;
