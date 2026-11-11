import { cp, mkdir, rm, writeFile } from 'node:fs/promises';

const output = new URL('../_site/', import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(new URL('test/', output), { recursive: true });

for (const path of [
  'index.html',
  'styles.css',
  'app.js',
  'po-parser.js',
  'dist',
  'test/sample.po',
]) {
  await cp(new URL(`../${path}`, import.meta.url), new URL(path, output), {
    recursive: true,
  });
}
await writeFile(new URL('.nojekyll', output), '');
console.log('GitHub Pages files prepared in _site/');
