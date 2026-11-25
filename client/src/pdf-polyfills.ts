/**
 * The one newer function PDF.js's legacy build still expects the browser to have. Safari has Promise.withResolvers from 17.4;
 * an iPhone on iOS 16 doesn't, and PDF.js uses it in the page and in its worker. (The legacy build fills in the others itself.)
 * This file is loaded by both, before any PDF code runs.
 */
// (typed loosely: the project's type library is older than the function)
const P = Promise as unknown as { withResolvers?: () => { promise: Promise<unknown>; resolve: (v?: unknown) => void; reject: (e?: unknown) => void } };
if (typeof P.withResolvers !== 'function') {
  P.withResolvers = function withResolvers() {
    let resolve!: (v?: unknown) => void;
    let reject!: (e?: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

export {};
