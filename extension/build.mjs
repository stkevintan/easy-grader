// 构建扩展。
//
//   pnpm build        发布版：服务端固定为 SERVER_URL（默认 https://grader.flyfly.top），
//                     不能在界面上修改，也不带本机演示页的权限和内容脚本
//   pnpm build:dev    开发版：默认连 http://127.0.0.1:3000，popup 设置里可以改服务端地址
//
//   SERVER_URL=https://staging.example.com pnpm build   换一个固定服务端打发布包
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = import.meta.dirname;
const dev = process.argv.includes('--dev');
const dist = resolve(root, process.env.OUT_DIR || (dev ? 'dist-dev' : 'dist'));

const PROD_SERVER = 'https://grader.flyfly.top';
const DEV_SERVER = 'http://127.0.0.1:3000';
const serverUrl = new URL(process.env.SERVER_URL || (dev ? DEV_SERVER : PROD_SERVER)).origin;
if (!dev && new URL(serverUrl).protocol !== 'https:') {
  throw new Error(`发布版的服务端必须是 https：${serverUrl}`);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: {
    background: 'src/background.ts',
    content: 'src/content/main.ts',
    insert: 'src/insert.ts',
    popup: 'src/popup.ts',
  },
  bundle: true,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  // 发布版压缩并去掉 sourcemap；__DEV__ 为 false 的分支会被当作死代码删除
  minify: !dev,
  sourcemap: dev ? 'linked' : false,
  target: 'chrome110',
  format: 'iife',
  outdir: dist,
  logLevel: 'info',
  define: {
    __DEV__: JSON.stringify(dev),
    __SERVER_URL__: JSON.stringify(serverUrl),
  },
});

// 图标（16/32/48/128）随扩展一起打包，manifest 里引用 icons/*.png
cpSync(resolve(root, 'icons'), resolve(dist, 'icons'), { recursive: true });

// manifest：发布版只申请线上服务端的主机权限，去掉本机演示页相关配置
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
if (dev) {
  manifest.name += '（开发版）';
} else {
  manifest.host_permissions = [`${serverUrl}/*`, 'https://xiaoxianai.cn/*', 'https://www.xiaoxianai.cn/*'];
  manifest.content_scripts = [
    { matches: ['https://xiaoxianai.cn/*', 'https://www.xiaoxianai.cn/*'], js: ['content.js'], run_at: 'document_idle' },
    { matches: ['https://xiaoxianai.cn/*', 'https://www.xiaoxianai.cn/*'], js: ['insert.js'], run_at: 'document_start', world: 'MAIN' },
  ];
}
writeFileSync(resolve(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// popup.html 里 <!--DEV-ONLY-->…<!--/DEV-ONLY--> 之间的内容（服务端地址输入框的挂载点）只给开发版
let popupHtml = readFileSync(resolve(root, 'popup.html'), 'utf8');
popupHtml = dev
  ? popupHtml.replace(/<!--\/?DEV-ONLY-->/g, '')
  : popupHtml.replace(/<!--DEV-ONLY-->[\s\S]*?<!--\/DEV-ONLY-->/g, '');
writeFileSync(resolve(dist, 'popup.html'), popupHtml);

console.log(`${dev ? '开发版' : '发布版'}已构建：${dist}`);
console.log(`  服务端：${serverUrl}${dev ? '（可在 popup 设置里修改）' : '（固定，不可修改）'}`);
