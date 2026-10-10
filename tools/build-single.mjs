// Assemble l'appli en un seul fichier HTML (ouvrable directement, sans serveur).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [root, out] = process.argv.slice(2);
const read = (f) => readFileSync(join(root, f), 'utf8');
const strip = (src) => src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '').replace(/^export\s+/gm, '');
let main = strip(read('js/main.js'));
const worklet = read('js/capture-worklet.js');
main = main.replace("audioCtx.audioWorklet.addModule('js/capture-worklet.js')",
  "audioCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' })))");
if (!main.includes('WORKLET_SRC')) throw new Error('worklet non remplacé');
const js = [`const WORKLET_SRC = ${JSON.stringify(worklet)};`, ...['js/tuning.js', 'js/pitch.js', 'js/unison.js'].map((f) => strip(read(f))), main].join('\n');
let html = read('index.html');
html = html.replace('<link rel="stylesheet" href="style.css">', `<style>\n${read('style.css')}</style>`);
html = html.replace('<script type="module" src="js/main.js"></script>', `<script type="module">\n${js.replace(/<\/script/g, '<\\/script')}\n</script>`);
writeFileSync(out, html);
console.log(out, (html.length / 1024).toFixed(0) + ' Ko');
