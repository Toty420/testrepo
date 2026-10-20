// node build.mjs → index.html (standalone document) and dist/svara-artifact.html (artifact fragment).
// Inlines src/styles.css and the three classic scripts (engine, ai, app — in that order) into
// src/template.html. The output makes no external requests.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

const template = read('src/template.html');
const css = read('src/styles.css');
const scripts = ['src/engine.js', 'src/ai.js', 'src/app.js'].map((p) => {
  const code = read(p);
  // A literal "</script" inside a script would end the inline tag early.
  if (/<\/script/i.test(code)) throw new Error(`${p} contains "</script"; escape it before inlining`);
  return `<script>\n${code.trim()}\n</script>`;
});

for (const marker of ['<!-- STYLES -->', '<!-- BODY -->', '<!-- SCRIPTS -->']) {
  if (template.split(marker).length !== 2) throw new Error(`template must contain ${marker} exactly once`);
}

const filled = template
  .replace('<!-- STYLES -->', () => `<style>\n${css.trim()}\n</style>`)
  .replace('<!-- SCRIPTS -->', () => scripts.join('\n'));
const [head, body] = filled.split('<!-- BODY -->').map((s) => s.trim());

// Artifact fragment: no doctype/html/head/body; starts with <title> and the viewport-fit meta.
const fragment = `${head}\n${body}\n`;
if (!fragment.startsWith('<title>Свара</title>\n<meta name="claude:viewport-fit-sides" content="cover">')) {
  throw new Error('the fragment must start with <title>Свара</title> and the viewport-fit meta');
}
if (/<(!doctype|html|head|body)[\s>]/i.test(fragment)) throw new Error('the fragment must not contain document tags');

// Standalone page: the same content in a full document. The small reset mirrors the artifact
// host skeleton (safe-area padding on :root, zero body margin, [hidden] really hides).
const skeleton = [
  ':root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}',
  'body{margin:0}',
  '[hidden]{display:none!important}',
].join('');
const standalone = `<!doctype html>
<html lang="bg">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#000000">
<style>${skeleton}</style>
${head}
</head>
<body>
${body}
</body>
</html>
`;

const external = /(?:src|href)\s*=\s*["'](?:https?:)?\/\//i;
for (const [name, html] of [['index.html', standalone], ['dist/svara-artifact.html', fragment]]) {
  if (external.test(html)) throw new Error(`${name} would make an external request`);
}

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'index.html'), standalone);
writeFileSync(join(root, 'dist/svara-artifact.html'), fragment);
const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(1)} KB`;
console.log(`index.html ${kb(standalone)} · dist/svara-artifact.html ${kb(fragment)}`);
