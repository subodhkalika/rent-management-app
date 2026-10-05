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
