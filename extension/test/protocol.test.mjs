// 控制台路径白名单：扩展只把站内路径交给控制台
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { outputFiles } = await build({
  stdin: { contents: "export { safeConsolePath } from './src/shared/protocol';", resolveDir: root, loader: 'ts' },
  bundle: true,
  write: false,
  format: 'esm',
  define: { __SERVER_URL__: '"http://127.0.0.1:3000"', __DEV__: 'true' },
});
const { safeConsolePath } = await import(`data:text/javascript,${encodeURIComponent(outputFiles[0].text)}`);

test('safeConsolePath 只放行站内路径', () => {
  assert.equal(safeConsolePath('/credits'), '/credits');
  assert.equal(safeConsolePath('/tasks?taskId=12'), '/tasks?taskId=12');
  assert.equal(safeConsolePath('/records/abc-123'), '/records/abc-123');
  for (const bad of ['//evil.example', 'https://evil.example', 'javascript:alert(1)', '/a b', '/x#y', '', 'credits', '/\\evil']) {
    assert.equal(safeConsolePath(bad), '/', bad);
  }
});
