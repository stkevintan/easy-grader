import type { AdapterConfig } from './adapter-config';

export interface BuiltinPreset {
  name: string;
  hostPattern: string;
  pathPattern: string;
  config: AdapterConfig;
  note: string;
  /** 演示页预设，可通过 SEED_DEMO_PRESET=false 关闭 */
  demo?: boolean;
}

const base = {
  version: 1 as const,
  confirm: { selectors: [] },
  nextTimeoutMs: 8000,
  submitDelayMs: 300,
};

/**
 * 内置预设。真实平台没有放在这里：选择器必须对着真实页面验证，
 * 未经验证的配置只会制造“看起来能用”的假象。真实平台请用扩展里的「点选适配」生成，
 * 管理员可在后台把验证过的私有预设改成公共预设。
 */
const DEMO_PRESETS: BuiltinPreset[] = [
  {
    name: '本地演示：输入框给分',
    hostPattern: 'localhost',
    // /demo/ 与 /demo/index.html 都命中；buttons 页的路径片段更长，会优先匹配到下一个预设
    pathPattern: '/demo/',
    demo: true,
    note: '服务端自带的模拟阅卷页 /demo/index.html',
    config: {
      ...base,
      pics: { selectors: ['#answer-canvas'], type: 'canvas', multiple: false },
      scoreMode: 'input',
      scoreInput: { selectors: ['#score-input'] },
      scoreButtons: { selectors: [], clickType: 'click' },
      submit: { selectors: ['#submit-btn'], clickType: 'click' },
      examTitle: { selectors: ['#exam-title'] },
      questionNo: { selectors: ['#question-no'] },
      maxScore: { selectors: ['#max-score'], regex: '(\\d+(?:\\.\\d+)?)' },
    },
  },
  {
    name: '本地演示：分数按钮给分',
    hostPattern: 'localhost',
    pathPattern: '/demo/buttons',
    demo: true,
    note: '服务端自带的模拟阅卷页 /demo/buttons.html，图片为跨域 <img>，打分板为按钮',
    config: {
      ...base,
      pics: { selectors: ['.paper img.answer'], type: 'img', multiple: true },
      scoreMode: 'buttons',
      scoreInput: { selectors: [] },
      scoreButtons: { selectors: ['.score-board button'], clickType: 'click' },
      submit: { selectors: [], clickType: 'click' },
      examTitle: { selectors: ['.header .exam'] },
      questionNo: { selectors: ['.header .qno'] },
      maxScore: { selectors: ['.header .full'], regex: '(\\d+(?:\\.\\d+)?)' },
    },
  },
];

/** 演示页通过 localhost 和 127.0.0.1 都可能访问，各写一份 */
export const BUILTIN_PRESETS: BuiltinPreset[] = DEMO_PRESETS.flatMap((p) => [
  p,
  { ...p, hostPattern: '127.0.0.1', name: `${p.name}（127.0.0.1）` },
]);
