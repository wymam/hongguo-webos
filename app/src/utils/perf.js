// Press-to-paint latency markers.
//
// The focus system calls `markAfterPaint(label, t0)` at the moment focus is
// moved; this measures the time until the resulting frame has actually been
// painted (settled over two rAFs) and keeps a small rolling window.
//
// Why it matters: the reference project measured a jump from 29ms to >90ms p95
// when scroll offset was pushed through React state instead of mutated
// directly. This counter is how that regression would be caught on real
// hardware, where no devtools are available.
//
// Cost when nobody is looking: one entry appended to a bounded array, and two
// rAF callbacks. No layout thrash, no allocation per frame beyond one object.

const MAX_SAMPLES = 200;

const samples = [];
let enabled = true;

// A rolling summary is cheaper to display than the raw list.
const stats = { count: 0, last: 0, max: 0, total: 0 };

function now() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

export function markAfterPaint(label, t0) {
  if (!enabled || !t0) return;
  // Two rAFs: the first fires before the paint triggered by this frame's
  // mutations, the second after it has landed.
  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);

  raf(() => {
    raf(() => {
      const delta = now() - t0;
      stats.count += 1;
      stats.last = delta;
      stats.total += delta;
      if (delta > stats.max) stats.max = delta;
      samples.push({ label, ms: Math.round(delta * 10) / 10, at: Date.now() });
      while (samples.length > MAX_SAMPLES) samples.shift();
    });
  });
}

// p95 over the retained window — the number that actually tracks perceived lag.
export function getLatencyStats() {
  if (!samples.length) {
    return { count: 0, last: 0, max: 0, avg: 0, p95: 0 };
  }
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    count: samples.length,
    last: Math.round(stats.last * 10) / 10,
    max: Math.round(stats.max * 10) / 10,
    avg: Math.round((stats.total / stats.count) * 10) / 10,
    p95: sorted[idx]
  };
}

export function getLatencySamples() {
  return samples.slice();
}

export function resetLatencyStats() {
  samples.length = 0;
  stats.count = 0;
  stats.last = 0;
  stats.max = 0;
  stats.total = 0;
}

export function setLatencyEnabled(value) {
  enabled = !!value;
}

if (typeof window !== 'undefined') {
  window.__hongguoLatency = {
    markAfterPaint,
    getLatencyStats,
    getLatencySamples,
    resetLatencyStats,
    setLatencyEnabled
  };
}
