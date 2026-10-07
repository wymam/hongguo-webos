// Performance flags.
//
// The reference project used this as an A/B switchboard for experiments on
// real hardware. This client keeps only the switches that still earn their
// keep, defaulting to the values that project measured as best:
//
//   scrollDirect   - drive grid scrolling from the focus system instead of
//                    React state. Measured there as the difference between
//                    29ms and >90ms p95 input latency with 100+ cards.
//   prefetchThumbs - warm the next row's thumbnails while the user rests.
//
// Both default on. The override hook exists so a future on-device experiment
// does not require a code change.

const DEFAULTS = {
  scrollDirect: true,
  prefetchThumbs: true
};

const overrides = {};

export function perfFlag(name) {
  if (Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name];
  return Object.prototype.hasOwnProperty.call(DEFAULTS, name) ? DEFAULTS[name] : false;
}

export function setPerfFlag(name, value) {
  overrides[name] = !!value;
}

// Player sessions are bandwidth- and CPU-heavy on a TV; thumbnail prefetching
// must stand down while one is active.
let heavyWork = 0;

export function beginHeavyWork() {
  heavyWork++;
}

export function endHeavyWork() {
  heavyWork = Math.max(0, heavyWork - 1);
}

export function canPrefetch() {
  return heavyWork === 0;
}

if (typeof window !== 'undefined') {
  window.__hongguoPerf = { perfFlag, setPerfFlag, canPrefetch };
}
