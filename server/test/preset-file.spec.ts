import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PRESETS_DIR, loadPresetDir, parsePresetFile } from '../src/adapters/preset-file';

const config = `
    config:
      version: 1
      pics: { selectors: ['#paper img'], type: img, multiple: true }
      scoreMode: input
      scoreInput: { selectors: ['#score'] }
      scoreButtons: { selectors: [], clickType: click }
      submit: { selectors: ['#submit'], clickType: click }
      examTitle: { selectors: ['.exam'] }
      questionNo: { selectors: ['.qno'] }
      nextTimeoutMs: 8000
      submitDelayMs: 300`;

describe('预设 YAML 文件', () => {
  it('解析并规范化 hostPattern', () => {
    const list = parsePresetFile(`presets:\n  - name: 示例\n    hostPattern: https://www.Example.com/x\n    pathPattern: /mark${config}`, 't.yaml');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: '示例', hostPattern: 'example.com', pathPattern: '/mark', note: '' });
    expect(list[0].config.pics.selectors).toEqual(['#paper img']);
  });

  it('空文件或空列表返回空', () => {
    expect(parsePresetFile('', 'a.yaml')).toEqual([]);
    expect(parsePresetFile('presets: []', 'a.yaml')).toEqual([]);
  });

  it('不合法的配置报出文件和条目', () => {
    expect(() => parsePresetFile('presets:\n  - name: 坏的\n    hostPattern: a.com\n    config: { version: 1 }', 'bad.yaml')).toThrow(
      /bad\.yaml 第 1 条（坏的）：缺少答卷图片选择器/,
    );
    expect(() => parsePresetFile(`presets:\n  - name: x\n    hostPattern: 'a b'${config}`, 'bad.yaml')).toThrow(/hostPattern 不合法/);
    expect(() => parsePresetFile('presets: {}', 'bad.yaml')).toThrow(/presets 必须是数组/);
  });

  it('读取目录下所有 yaml，目录不存在时为空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eg-presets-'));
    writeFileSync(join(dir, 'b.yml'), `presets:\n  - name: B\n    hostPattern: b.com${config}`);
    writeFileSync(join(dir, 'a.yaml'), `presets:\n  - name: A\n    hostPattern: a.com${config}`);
    writeFileSync(join(dir, 'ignore.txt'), 'x');
    expect(loadPresetDir(dir).map((p) => p.name)).toEqual(['A', 'B']);
    expect(loadPresetDir(join(dir, 'missing'))).toEqual([]);
  });

  it('仓库自带的预设文件合法', () => {
    expect(() => loadPresetDir(DEFAULT_PRESETS_DIR)).not.toThrow();
  });
});
