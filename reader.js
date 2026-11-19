'use strict';

const $ = id => document.getElementById(id);
const imageTypes = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'], ['gif', 'image/gif'], ['avif', 'image/avif'], ['bmp', 'image/bmp'],
]);
const archiveName = /\.(zip|cbz)$/i;
const sorter = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
const maxPageBytes = 96 * 1024 * 1024;
const storageKey = 'lector-manga/v1';

function storedSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && Array.isArray(saved.bookmarks)) return saved;
  } catch {}
  return { direction: 'rtl', zoom: 'fit', bookmarks: [] };
}

const settings = storedSettings();
$('direction').value = settings.direction === 'ltr' ? 'ltr' : 'rtl';
if (Array.from($('zoom').options).some(option => option.value === settings.zoom)) $('zoom').value = settings.zoom;

let chapter = null;
let position = 0;
let importNumber = 0;
let pageRequest = null;
let objectURL = '';
let noticeTimer;
let dragDepth = 0;

function storeSettings() {
  settings.direction = $('direction').value;
  settings.zoom = $('zoom').value;
  try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch {}
}

function rememberPosition() {
  settings.bookmarks = [[chapter.key, position], ...settings.bookmarks.filter(([key]) => key !== chapter.key)].slice(0, 60);
  storeSettings();
}

function notice(message, persistent = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').hidden = !message;
  if (message && !persistent) noticeTimer = setTimeout(() => notice(''), 6500);
}

function fileType(path) {
  const parts = path.replaceAll('\\', '/').split('/');
  if (parts.some(part => part.startsWith('.') || part === '__MACOSX')) return '';
  return imageTypes.get(parts.at(-1).split('.').at(-1).toLowerCase()) || '';
}

function orderedPages(pages) {
  pages.sort((a, b) => sorter.compare(a.name, b.name) || a.name.localeCompare(b.name));
  if (!pages.length) throw Error('No encontré imágenes de manga en esos archivos.');
  return pages;
}

async function extractPage(entry, type, signal) {
  if (entry.encrypted) throw Error('Esta página pertenece a un ZIP protegido con contraseña.');
  if (entry.uncompressedSize > maxPageBytes) throw Error('Esta imagen supera 96 MiB.');
  const chunks = [];
  let bytes = 0;
  const output = new WritableStream({
    write(chunk) {
      bytes += chunk.byteLength;
      if (bytes > maxPageBytes) throw Error('Esta imagen supera 96 MiB.');
      chunks.push(chunk);
    },
  });
  await entry.getData(output, { signal, checkSignature: true, useWebWorkers: false });
  return new Blob(chunks, { type });
}

async function archiveChapter(file) {
  const { ZipReader, BlobReader } = globalThis.zip;
  const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false });
  try {
    const pages = [];
    for await (const entry of reader.getEntriesGenerator()) {
      if (entry.directory) continue;
      const type = fileType(entry.filename);
      if (!type) continue;
      pages.push({ name: entry.filename, load: signal => extractPage(entry, type, signal) });
    }
    return {
      title: file.name.replace(archiveName, ''),
      key: JSON.stringify(['zip', file.name, file.size]),
      pages: orderedPages(pages),
      close: () => reader.close(),
    };
  } catch (error) {
    await reader.close();
    if (error.message === 'No encontré imágenes de manga en esos archivos.') throw error;
    throw Error('El ZIP o CBZ no se pudo abrir. Comprueba que el archivo esté completo.', { cause: error });
  }
}

function imageChapter(files, folderName) {
  const pages = orderedPages(files.flatMap(file => {
    const name = file.webkitRelativePath || file.name;
    if (!fileType(name)) return [];
    return [{
      name,
      size: file.size,
      load() {
        if (file.size > maxPageBytes) throw Error('Esta imagen supera 96 MiB.');
        const mime = fileType(name);
        return file.type === mime ? file : file.slice(0, file.size, mime);
      },
    }];
  }));
  const title = folderName || (pages.length === 1 ? pages[0].name : 'Imágenes seleccionadas');
  const identity = [pages[0], pages.at(-1)].map(({ name, size }) => [name, size]);
  return { title, key: JSON.stringify(['images', title, pages.length, identity]), pages };
}

async function openChapter(files, fromFolder = false) {
  if (!files.length) return;
  const request = ++importNumber;
  notice('Abriendo capítulo…', true);
  try {
    const archives = files.filter(file => archiveName.test(file.name));
    if (!fromFolder && archives.length && files.length !== 1) throw Error('Abre un ZIP o CBZ a la vez.');
    const source = !fromFolder && archives.length
      ? await archiveChapter(archives[0])
      : imageChapter(files, fromFolder ? files[0].webkitRelativePath.split('/')[0] : '');
    if (request !== importNumber) {
      await source.close?.();
      return;
    }
    stopPage();
    const previous = chapter;
    chapter = source;
    void previous?.close?.().catch(() => {});
    const title = $('chapter-title');
    title.textContent = chapter.title;
    title.title = chapter.title;
    document.title = chapter.title + ' · Lector Manga';
    $('empty').hidden = true;
    $('reader').hidden = false;
    $('top-file-controls').hidden = false;
    $('stage').focus({ preventScroll: true });
    const saved = settings.bookmarks.find(([key]) => key === chapter.key)?.[1];
    notice('');
    void showPage(Number.isInteger(saved) ? saved : 0);
  } catch (error) {
    if (request === importNumber) notice(error.message);
  }
}

function stopPage() {
  pageRequest?.abort();
  pageRequest = null;
  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = '';
  $('page-image').removeAttribute('src');
  $('page-image').hidden = true;
}

function pageMessage(text) {
  $('page-message').textContent = text;
  $('page-message').hidden = !text;
}

function updateNavigation() {
  const total = chapter.pages.length;
  $('previous').disabled = position === 0;
  $('next').disabled = position + 1 === total;
  $('progress').max = total;
  $('progress').value = position + 1;
  $('progress').setAttribute('aria-valuetext', `Página ${position + 1} de ${total}`);
  $('page-number').max = total;
  $('page-number').value = position + 1;
  $('page-count').textContent = `de ${total}`;
}

async function showPage(index) {
  if (!chapter || !Number.isInteger(index)) return;
  stopPage();
  position = Math.max(0, Math.min(chapter.pages.length - 1, index));
  updateNavigation();
  const entry = chapter.pages[position];
  const request = pageRequest = new AbortController();
  pageMessage('Cargando página…');
  let pendingURL = '';
  try {
    const blob = await entry.load(request.signal);
    request.signal.throwIfAborted();
    pendingURL = URL.createObjectURL(blob);
    const decoded = new Image();
    decoded.src = pendingURL;
    await decoded.decode();
    request.signal.throwIfAborted();
    const image = $('page-image');
    image.src = pendingURL;
    objectURL = pendingURL;
    pendingURL = '';
    const width = decoded.naturalWidth;
    const height = decoded.naturalHeight;
    image.width = width;
    image.height = height;
    image.alt = `Página ${position + 1}`;
    image.hidden = false;
    pageMessage('');
    fitPage(width, height);
    const stage = $('stage');
    stage.scrollTop = 0;
    stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2);
    rememberPosition();
  } catch (error) {
    if (!request.signal.aborted) {
      const message = error.name === 'EncodingError' ? 'El navegador no pudo leer esta imagen.' : error.message;
      pageMessage(`Página ${position + 1} · ${message}`);
    }
  } finally {
    if (pendingURL) URL.revokeObjectURL(pendingURL);
  }
}

function fitPage(width = Number($('page-image').getAttribute('width')), height = Number($('page-image').getAttribute('height'))) {
  const image = $('page-image');
  const stage = $('stage');
  if (image.hidden || !width || !height) return;
  const choice = $('zoom').value;
  const widthRatio = Math.max(1, stage.clientWidth - 20) / width;
  const heightRatio = Math.max(1, stage.clientHeight - 20) / height;
  const ratio = choice === 'fit' ? Math.min(widthRatio, heightRatio) : choice === 'width' ? widthRatio : Number(choice) / 100;
  image.style.width = `${Math.round(width * ratio)}px`;
  image.style.height = 'auto';
}

function step(delta) {
  const target = position + delta;
  if (chapter && target >= 0 && target < chapter.pages.length) void showPage(target);
}

async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    notice('El navegador no pudo entrar en pantalla completa.');
  }
}

for (const button of ['top-files', 'empty-files']) $(button).addEventListener('click', () => $('files').click());
for (const button of ['top-folder', 'empty-folder']) $(button).addEventListener('click', () => $('folder').click());
for (const input of ['files', 'folder']) $(input).addEventListener('change', event => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  void openChapter(files, input === 'folder');
});
$('previous').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$('progress').addEventListener('change', event => void showPage(Number(event.target.value) - 1));
$('jump').addEventListener('submit', event => {
  event.preventDefault();
  void showPage($('page-number').valueAsNumber - 1);
});
function updateDirection() {
  $('paging').dataset.direction = $('direction').value;
}
$('direction').addEventListener('change', () => { updateDirection(); storeSettings(); });
$('zoom').addEventListener('change', () => { fitPage(); storeSettings(); });
$('fullscreen').addEventListener('click', fullscreen);
$('fullscreen').disabled = !document.fullscreenEnabled;
document.addEventListener('fullscreenchange', () => {
  $('fullscreen').textContent = document.fullscreenElement ? 'Salir de pantalla completa' : 'Pantalla completa';
});
new ResizeObserver(() => fitPage()).observe($('stage'));
updateDirection();

document.addEventListener('keydown', event => {
  if (!chapter || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.target.closest?.('input, select, textarea, button, [contenteditable]')) return;
  const rtl = $('direction').value === 'rtl';
  switch (event.key) {
    case 'ArrowLeft': step(rtl ? 1 : -1); break;
    case 'ArrowRight': step(rtl ? -1 : 1); break;
    case 'PageUp': step(-1); break;
    case 'PageDown': step(1); break;
    case 'Home': void showPage(0); break;
    case 'End': void showPage(chapter.pages.length - 1); break;
    case 'f': case 'F': void fullscreen(); break;
    default: return;
  }
  event.preventDefault();
});

function isFileDrag(event) {
  return event.dataTransfer?.types.includes('Files');
}
document.addEventListener('dragenter', event => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth++;
  $('drop-overlay').hidden = false;
});
document.addEventListener('dragover', event => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop-overlay').hidden = true;
});
document.addEventListener('drop', event => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  void openChapter(Array.from(event.dataTransfer.files));
});
