import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceService, type TraceInput } from '../src/trace/trace.service';
import type { AppConfig } from '../src/config';

/**
 * trace 必须记「评分当时真正用的模型」，而不是落盘那一刻从方案里重新读到的配置。
 * 线上场景：评分还没结束，管理员在控制台改了同一个方案。
 */
describe('trace 的模型快照', () => {
  const task = {
    id: 1,
    platformHost: 'p.example',
    examTitle: '期中',
    questionNo: '1',
    subject: '语文',
    questionType: '其他',
    maxScore: 6,
    scoreStep: 1,
    questionText: '题干',
    referenceAnswer: '',
    rubric: '',
  } as unknown as TraceInput['task'];

  const make = (dir: string) => {
    const cfg = { saveTraces: true, traceDir: dir } as unknown as AppConfig;
    // 落盘时方案已经被改成 new-model：快照应当仍然胜出
    const profiles = { config: () => ({ name: 'new-model', temperature: 0.9, maxTokens: 999, reasoningEffort: 'high' }) };
    return new TraceService(cfg, profiles as never);
  };

  it('优先用调用方传入的快照，而不是落盘时重读的配置', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eg-trace-'));
    await make(dir).save({
      recordId: 7,
      task,
      imageDataUrl: 'data:image/png;base64,' + 'A'.repeat(200),
      sha256: 'a'.repeat(64),
      prompt: 'prompt',
      modelProfile: 'default',
      modelSnapshot: { name: 'old-model', temperature: 0.1, maxTokens: 8000, reasoningEffort: 'none' },
      attempts: 1,
      latencyMs: 10,
    });
    const json = readdirSync(dir).find((f) => f.endsWith('.json'))!;
    const trace = JSON.parse(readFileSync(join(dir, json), 'utf8')) as { modelConfig: Record<string, unknown> };
    expect(trace.modelConfig).toMatchObject({
      profile: 'default',
      name: 'old-model',
      temperature: 0.1,
      maxTokens: 8000,
      reasoningEffort: 'none',
    });
  });

  it('没有快照时退回当前方案配置', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eg-trace-'));
    await make(dir).save({
      recordId: 8,
      task,
      imageDataUrl: 'data:image/png;base64,' + 'A'.repeat(200),
      sha256: 'b'.repeat(64),
      prompt: 'prompt',
      attempts: 1,
      latencyMs: 10,
    });
    const json = readdirSync(dir).find((f) => f.endsWith('.json'))!;
    const trace = JSON.parse(readFileSync(join(dir, json), 'utf8')) as { modelConfig: Record<string, unknown> };
    expect(trace.modelConfig).toMatchObject({ name: 'new-model', reasoningEffort: 'high' });
  });
});
