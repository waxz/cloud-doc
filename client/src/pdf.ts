import './pdf-polyfills';
import workerSrc from './pdf-worker.ts?worker&url';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
export type PDFDocumentProxy = import('pdfjs-dist/legacy/build/pdf.mjs').PDFDocumentProxy;
export type PDFDocumentLoadingTask = import('pdfjs-dist/legacy/build/pdf.mjs').PDFDocumentLoadingTask;

let loaded: Promise<PdfJs> | undefined;

/**
 * The PDF library, fetched the first time a PDF is shown, so a page without one never runs a line of it. This is the
 * "legacy" build, which PDF.js makes for older browsers (it fills in the newer language features the plain build
 * expects: an iPhone on iOS 16 lacks several), and that is what keeps ordinary pages working on older phones.
 */
export function loadPdfjs(): Promise<PdfJs> {
  loaded ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = workerSrc;
    return lib;
  });
  // a failed load (a dropped connection) can be tried again
  loaded.catch(() => {
    loaded = undefined;
  });
  return loaded;
}
