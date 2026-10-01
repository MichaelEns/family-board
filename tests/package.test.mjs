import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const json = (file) => JSON.parse(read(file));

function pngSize(file) {
  const bytes = fs.readFileSync(path.join(ROOT, file));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('PWA shell is complete and precached', () => {
  const manifest = json('manifest.webmanifest');
  assert.equal(manifest.start_url, '/family-board/');
  for (const file of ['index.html', 'styles.css', 'app.js', 'manifest.webmanifest']) {
    assert.match(read('sw.js'), new RegExp(file.replace('.', '\\.')));
  }
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(ROOT, icon.src.replace('/family-board/', ''))));
  }
});

test('Alexa package enables APL and the widget data store', () => {
  const skill = json('alexa/skill-package/skill.json');
  const interfaces = skill.manifest.apis.custom.interfaces;
  assert.ok(interfaces.some((item) => item.type === 'ALEXA_PRESENTATION_APL'));
  assert.ok(interfaces.some((item) => item.type === 'ALEXA_DATA_STORE'));
  assert.ok(interfaces.some((item) => item.type === 'ALEXA_DATASTORE_PACKAGEMANAGER'));
  const widget = json(
    'alexa/skill-package/dataStorePackages/FamilyBoardSummary/manifest.json',
  );
  assert.equal(widget.manifest.id, 'FamilyBoardSummary');
  const document = json(
    'alexa/skill-package/dataStorePackages/FamilyBoardSummary/documents/document.json',
  );
  assert.equal(document.extensions[0].uri, 'alexaext:datastore:10');
});

test('Alexa gallery graphics have required dimensions', () => {
  assert.deepEqual(
    pngSize('alexa/widget-icon-450.png'),
    { width: 450, height: 450 },
  );
  assert.deepEqual(
    pngSize('alexa/widget-preview-328x552.png'),
    { width: 328, height: 552 },
  );
});

test('the browser sends household data only to the board worker', () => {
  const source = read('app.js');
  const urls = [...source.matchAll(/https?:\/\/[^\s"'`)]+/g)]
    .map((match) => match[0]);
  assert.deepEqual(urls, ['https://family-board-sync.michaelens.workers.dev']);
});
