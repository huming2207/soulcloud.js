/**
 * Test setup for the web package: happy-dom globals + React Testing
 * Library prerequisites. Loaded via `bun test --preload`.
 */
import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost/" });

// --- inject happy-dom globals before any app module is imported ---
const g = globalThis as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "HTMLElement",
  "SVGElement",
  "Element",
  "Node",
  "NodeList",
  "HTMLCollection",
  "DOMTokenList",
  "CSSStyleDeclaration",
  "ShadowRoot",
  "NamedNodeMap",
  "TreeWalker",
  "NodeFilter",
  "DOMParser",
  "XMLSerializer",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "CustomEvent",
  "MutationObserver",
  "DocumentFragment",
  "DocumentType",
  "Text",
  "Comment",
  "Attr",
  "Range",
  "DOMRect",
  "DOMRectReadOnly",
  "EventTarget",
  "File",
  "Blob",
  "FormData",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "Headers",
  "Request",
  "Response",
  "fetch",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "history",
  "location",
]) {
  if (!(key in g)) {
    g[key] = (window as unknown as Record<string, unknown>)[key];
  }
}
// navigator: bun ships one without `language`; always use happy-dom's
Object.defineProperty(g, "navigator", {
  value: window.navigator,
  configurable: true,
  writable: true,
});
if (!window.navigator.language) {
  Object.defineProperty(window.navigator, "language", {
    value: "en-US",
    configurable: true,
  });
}

// --- MUI / Data Grid prerequisites ---
if (!g.matchMedia) {
  g.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!g.scrollTo) {
  g.scrollTo = () => {};
}

// React 19 + Testing Library require the act environment flag
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Auto-cleanup between tests: unmounting every rendered component also
// cancels in-flight async work (e.g. a delayed WS reconnect IIFE from the
// previous test), which would otherwise leak into the next test's
// assertions under slow CI scheduling.
import { cleanup } from "@testing-library/react";
import { afterEach } from "bun:test";
afterEach(() => cleanup());

// clipboard is not implemented by happy-dom
const nav = window.navigator as unknown as Navigator & { clipboard?: Clipboard };
if (!nav.clipboard) {
  Object.defineProperty(nav, "clipboard", {
    value: {
      writeText: async () => {},
      readText: async () => "",
    },
    configurable: true,
  });
}

// happy-dom's navigator may lack `language`
if (!window.navigator.language) {
  Object.defineProperty(window.navigator, "language", {
    value: "en-US",
    configurable: true,
  });
}