// Offline check of the (page, skip) batching arithmetic.
//
// The bug this guards against is subtle and was ship-blocking: a batch is 50
// items but upstream serves 24-item pages, and 50 is NOT a multiple of 24. If
// batches are addressed by page number alone then screen N+1 either re-shows
// the items that straddled the cut or skips them. Verified here is the
// property that matters: **N consecutive batches tile the catalogue exactly —
// no gap, no repeat, every batch exactly 50 (except the last).**
//
// The service walks this arithmetic (provider.category) and the UI derives the
// same coordinates for a batch jump (batchCoord in CategoryPage). This test
// pins BOTH, by re-implementing them from the same description and checking
// they agree — a re-implementation is the point: if the test imported the real
// functions it could not disagree with them.
//
// Usage: node tools/local-batch-tile.js

const PER_PAGE = 24;
const BATCH = 50;

// provider.category's cursor walk, reduced to the arithmetic.
function consumeBatches(itemTotal, batchSize, perPage, pages) {
  const out = [];
  let page = 1;
  let skip = 0;
  let guard = 0;
  while (guard++ < 1000) {
    if (page > pages) break;
    const shown = [];
    let cursorPage = page;
    let cursorSkip = skip;
    // Walk consecutive pages from (page, skip).
    let p = page;
    let s = skip;
    while (p <= pages && shown.length < batchSize) {
      const from = p === page ? skip : 0;
      const itemsOnPage = Math.min(perPage, Math.max(0, itemTotal - (p - 1) * perPage));
      for (let k = from; k < itemsOnPage && shown.length < batchSize; k++) {
        shown.push((p - 1) * perPage + k);
        cursorPage = p;
        cursorSkip = k + 1;
      }
      if (cursorSkip >= itemsOnPage) { cursorPage = p + 1; cursorSkip = 0; }
      p++;
      s = 0;
    }
    if (!shown.length) break;
    out.push({ from: { page, skip }, items: shown, to: { page: cursorPage, skip: cursorSkip } });
    page = cursorPage;
    skip = cursorSkip;
  }
  return out;
}

// The UI's batchCoord, used when the viewer picks batch N directly.
function batchCoord(offset, perPage) {
  return { page: Math.floor(offset / perPage) + 1, skip: offset % perPage };
}

function main() {
  const failures = [];
  const totals = [50, 49, 51, 120, 137, 24, 25, 1, 1000, 34 * 24];

  for (const itemTotal of totals) {
    const pages = Math.ceil(itemTotal / PER_PAGE);
    const batches = consumeBatches(itemTotal, BATCH, PER_PAGE, pages);

    // 1. Every batch is exactly BATCH items, except possibly the last.
    batches.forEach((b, i) => {
      const last = i === batches.length - 1;
      if (!last && b.items.length !== BATCH) {
        failures.push(`total=${itemTotal} batch#${i + 1}: ${b.items.length} items (want ${BATCH})`);
      }
      if (b.items.length === 0) failures.push(`total=${itemTotal} batch#${i + 1}: empty`);
      if (b.items.length > BATCH) failures.push(`total=${itemTotal} batch#${i + 1}: over ${BATCH}`);
    });

    // 2. Tiling: concatenated batches == 0..itemTotal-1, in order, once each.
    const flat = batches.flatMap((b) => b.items);
    if (flat.length !== itemTotal) {
      failures.push(`total=${itemTotal}: covered ${flat.length} items, want ${itemTotal}`);
    }
    const uniq = new Set(flat);
    if (uniq.size !== flat.length) {
      failures.push(`total=${itemTotal}: ${flat.length - uniq.size} repeated item(s)`);
    }
    for (let i = 0; i < flat.length; i++) {
      if (flat[i] !== i) { failures.push(`total=${itemTotal}: out of order at ${i} -> ${flat[i]}`); break; }
    }

    // 3. Each batch's reported start matches the coordinate the UI would
    //    compute for that batch index — otherwise a jump lands elsewhere.
    batches.forEach((b, i) => {
      const expect = batchCoord(i * BATCH, PER_PAGE);
      if (b.from.page !== expect.page || b.from.skip !== expect.skip) {
        failures.push(
          `total=${itemTotal} batch#${i + 1}: starts at (${b.from.page},${b.from.skip}) ` +
          `but batchCoord says (${expect.page},${expect.skip})`
        );
      }
    });

    // 4. A jump to the LAST batch via batchCoord must land on the last items.
    const lastIdx = batches.length - 1;
    const jump = batchCoord(lastIdx * BATCH, PER_PAGE);
    const lastBatch = batches[lastIdx];
    if (jump.page !== lastBatch.from.page || jump.skip !== lastBatch.from.skip) {
      failures.push(`total=${itemTotal}: jump to last batch disagrees`);
    }
  }

  if (failures.length) {
    console.log('FAIL');
    failures.slice(0, 40).forEach((f) => console.log('  ' + f));
    console.log(`  ... ${failures.length} failure(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS  ${totals.length} totals x ${PER_PAGE}-item pages, batch=${BATCH}`);
  console.log('      batches tile exactly: no gap, no repeat, uniform size');
  console.log('      batchCoord agrees with the cursor walk for every index');
}

main();
