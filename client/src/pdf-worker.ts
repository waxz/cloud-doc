// PDF.js's worker, with the small polyfill in front of it (imports run in order: the polyfill first).
import './pdf-polyfills';
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
