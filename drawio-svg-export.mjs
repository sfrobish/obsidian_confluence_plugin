import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const inputPath = process.argv[2] || path.join(__dirname, 'examples', 'sample.drawio');
const outputPath = process.argv[3] || path.join(__dirname, 'output.svg');

const source = fs.readFileSync(inputPath, 'utf8');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

const { window } = dom;
const { document } = window;

Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
Object.defineProperty(globalThis, 'location', { value: window.location, configurable: true });
Object.defineProperty(globalThis, 'DOMParser', { value: window.DOMParser, configurable: true });
Object.defineProperty(globalThis, 'XMLSerializer', { value: window.XMLSerializer, configurable: true });
Object.defineProperty(globalThis, 'MutationObserver', { value: window.MutationObserver, configurable: true });
Object.defineProperty(globalThis, 'ResizeObserver', { value: window.ResizeObserver, configurable: true });
Object.defineProperty(globalThis, 'getComputedStyle', { value: window.getComputedStyle.bind(window), configurable: true });
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: (cb) => setTimeout(cb, 0), configurable: true });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: (id) => clearTimeout(id), configurable: true });
Object.defineProperty(globalThis, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }), configurable: true });
Object.defineProperty(globalThis, 'TextEncoder', { value: TextEncoder, configurable: true });
Object.defineProperty(globalThis, 'Blob', { value: Blob, configurable: true });
Object.defineProperty(globalThis, 'FormData', { value: FormData, configurable: true });
Object.defineProperty(globalThis, 'Request', { value: Request, configurable: true });
Object.defineProperty(globalThis, 'fetch', { value: globalThis.fetch, configurable: true });
Object.defineProperty(globalThis, 'URL', { value: URL, configurable: true });
Object.defineProperty(globalThis, 'innerWidth', { value: 1200, configurable: true, writable: true });
Object.defineProperty(globalThis, 'innerHeight', { value: 900, configurable: true, writable: true });
Object.defineProperty(globalThis, 'isLocalStorage', { value: false, configurable: true, writable: true });
Object.defineProperty(globalThis, 'mxClient', { value: { IS_SVG: true, IS_NS: true, IS_GC: false, IS_SF: false, IS_MT: false, IS_CHROMEAPP: false, IS_ANDROID: false, IS_IOS: false, IS_WIN: false, IS_MAC: false, IS_LINUX: false }, configurable: true });
Object.defineProperty(globalThis, 'mxLog', { value: { warn() {}, debug() {}, info() {} }, configurable: true });
Object.defineProperty(globalThis, 'mxLanguageMap', { value: { en: 'English' }, configurable: true });
Object.defineProperty(globalThis, 'mxLanguages', { value: ['en'], configurable: true });
Object.defineProperty(globalThis, 'mxLanguage', { value: 'en', configurable: true });

globalThis.urlParams = { configure: '0', dev: '0', windows: '0', embed: '0', chrome: '1' };
window.mxLanguageMap = globalThis.mxLanguageMap;
window.mxLanguages = globalThis.mxLanguages;
window.mxLanguage = globalThis.mxLanguage;
globalThis.DRAWIO_BASE_URL = 'https://app.diagrams.net';
globalThis.RESOURCES_PATH = 'resources';
globalThis.RESOURCE_BASE = 'resources/dia';
globalThis.DRAWIO_SERVER_URL = 'http://localhost/';

require('./assets/viewer-static.min.cjs');

if (!window.GraphViewer || !window.mxUtils) {
  throw new Error('Draw.io viewer did not initialize. Check the viewer bundle and global setup.');
}

const host = document.createElement('div');
host.style.position = 'absolute';
host.style.left = '-99999px';
host.style.top = '0';
host.style.width = '1200px';
host.style.height = '900px';
host.style.visibility = 'hidden';
host.style.pointerEvents = 'none';
host.style.overflow = 'hidden';
document.body.appendChild(host);

const xmlDoc = window.mxUtils.parseXml(source);
const viewer = new window.GraphViewer(host, xmlDoc.documentElement, {
  toolbar: '',
  nav: 0,
  resize: 0,
  border: 0,
  autoFit: true,
  autoCrop: true,
  autoOrigin: true,
  center: false,
  responsive: false,
  title: '',
});

const started = Date.now();
let svg = host.querySelector('svg') || (viewer.graph && typeof viewer.graph.getSvg === 'function' ? viewer.graph.getSvg() : null);
while (!svg && Date.now() - started < 30000) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  svg = host.querySelector('svg') || (viewer.graph && typeof viewer.graph.getSvg === 'function' ? viewer.graph.getSvg() : null);
}

if (!svg || svg.nodeName.toLowerCase() !== 'svg') {
  throw new Error('No SVG output was generated from the draw.io file.');
}

if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
if (!svg.getAttribute('xmlns:xlink')) svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

const xml = new window.XMLSerializer().serializeToString(svg);
const outDir = path.dirname(outputPath);
if (outDir) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outputPath, xml, 'utf8');

if (viewer && typeof viewer.destroy === 'function') viewer.destroy();
host.remove();

console.log(`Wrote SVG to ${outputPath}`);
