import '@testing-library/jest-dom/vitest';

// jsdom has no ResizeObserver. `cmdk` (behind the timezone combobox) uses one to
// measure its list, so without a stub any test that opens it throws a
// ReferenceError that has nothing to do with the behaviour under test.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom also has no layout, so `scrollIntoView` (cmdk scrolls the highlighted
// item into view as the user types) is missing entirely rather than a no-op.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom has no Pointer Events implementation at all — Radix's `Select` (and any
// other primitive built on pointer capture) calls `hasPointerCapture` /
// `setPointerCapture` / `releasePointerCapture` on every pointer interaction, and
// without these a plain `userEvent.click()` on a trigger throws a TypeError that
// has nothing to do with the behaviour under test.
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false;
}
if (typeof Element.prototype.setPointerCapture !== 'function') {
  Element.prototype.setPointerCapture = () => {};
}
if (typeof Element.prototype.releasePointerCapture !== 'function') {
  Element.prototype.releasePointerCapture = () => {};
}
