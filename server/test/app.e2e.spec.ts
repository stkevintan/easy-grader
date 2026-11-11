import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { Repository } from 'typeorm';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { loadConfig } from '../src/config';
import { configureApp, isAllowedOrigin } from '../src/main';
import { ManagementUnit, User } from '../src/entities';
import { buildOcrPrompt, buildPrompt, extractJson, isBlankOcr, ModelOutputError, ModelService, parseVerdict, snapScore } from '../src/judge/model.service';
import { pickGoldExamples } from '../src/judge/gold.service';
import { hostMatches, normalizeHostPattern } from '../src/adapters/adapter-config';
import { UnitService } from '../src/unit.service';

/** 一张 1x1 透明 PNG 太小（<100 字节会被拒），这里拼一张足够大的合法 data URL */
function fakePng(seed: string): string {
  const header = Buffer.from('89504e470d0a1a0a', 'hex');
  const body = Buffer.alloc(400, seed);
  return 'data:image/png;base64,' + Buffer.concat([header, body]).toString('base64');
}

const ADMIN = { username: 'admin', password: 'admin-password-1' };

describe('Easy Grader server (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let adminToken: string;
  let userToken: string;
  let userId: number;
  let activeUnitId: number;

  beforeAll(async () => {
    const cfg = loadConfig({
      DB_PATH: ':memory:',
      ADMIN_USERNAME: ADMIN.username,
      ADMIN_PASSWORD: ADMIN.password,
      INITIAL_CREDITS: '3',
      RATE_LIMIT_DEFAULT: '10000',
      RATE_LIMIT_AUTH: '10000',
      RATE_LIMIT_JUDGE: '10000',
    } as NodeJS.ProcessEnv);
    process.env.RATE_LIMIT_AUTH = '10000';
    process.env.RATE_LIMIT_JUDGE = '10000';
    const mod = await Test.createTestingModule({ imports: [AppModule.forRoot(cfg)] }).compile();
    app = mod.createNestApplication({ logger: false });
    configureApp(app, cfg);
    await app.init();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app?.close();
  });

  const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'x-unit-id': String(activeUnitId) });

  it('health 不需要登录', async () => {
    const r = await http.get('/api/health').expect(200);
    expect(r.body).toMatchObject({ ok: true, model: 'mock', allowRegister: true });
    expect(r.body.version).toBe(require('../package.json').version);
  });


  it('未登录访问受保护接口返回 401', async () => {
    await http.get('/api/auth/me').expect(401);
    await http.get('/api/tasks').set(auth('garbage')).expect(401);
  });

  it('管理员自动创建并能登录', async () => {
    const r = await http.post('/api/auth/login').send(ADMIN).expect(200);
    adminToken = r.body.token;
    expect(r.body.user.role).toBe('admin');
  });

  it('注册赠送额度，用户名唯一，校验密码长度', async () => {
    await http.post('/api/auth/register').send({ username: 'teacher', password: 'short', inviteToken: 'invalid-token' }).expect(400);
    const unit = await http.post('/api/admin/units').set(auth(adminToken)).send({ name: '测试邀请单元' }).expect(201);
    const invite = await http.post('/api/admin/invites').set(auth(adminToken)).send({ unitId: unit.body.id, count: 1, maxUses: 1, credits: 3, expiresAt: new Date(Date.now() + 86400000).toISOString() }).expect(201);
    const r = await http.post('/api/auth/register').send({ username: 'teacher', password: 'password-123', inviteToken: invite.body.tokens[0].token }).expect(201);
    userToken = r.body.token;
    userId = r.body.user.id;
    activeUnitId = unit.body.id;
    expect(r.body.user.credits).toBe(3);
    await http.post('/api/auth/register').send({ username: 'teacher', password: 'password-123', inviteToken: invite.body.tokens[0].token }).expect(409);
    const invite2 = await http.post('/api/admin/invites').set(auth(adminToken)).send({ unitId: unit.body.id, count: 1, maxUses: 1, credits: 20, expiresAt: new Date(Date.now() + 86400000).toISOString() }).expect(201);
    await http.post('/api/auth/register').send({ username: '王老师', password: 'password-123', inviteToken: invite2.body.tokens[0].token }).expect(201);
  });

  it('错误密码 401；多余字段被拒', async () => {
    await http.post('/api/auth/login').send({ username: 'teacher', password: 'wrong-pass' }).expect(401);
    await http.post('/api/auth/login').send({ username: 'nobody', password: 'wrong-pass' }).expect(401);
    await http.post('/api/auth/login').send({ username: 'teacher', password: 'password-123', role: 'admin' }).expect(400);
  });

  it('普通用户不能访问管理接口', async () => {
    await http.get('/api/admin/users').set(auth(userToken)).expect(403);
  });

  it('演示页适配预设已写入并可按 host+path 解析', async () => {
    const r = await http.get('/api/adapters/resolve').query({ host: 'localhost:3000', path: '/demo/index.html' }).set(auth(userToken)).expect(200);
    expect(r.body.preset?.config.scoreMode).toBe('input');
    const b = await http.get('/api/adapters/resolve').query({ host: 'localhost', path: '/demo/buttons.html' }).set(auth(userToken)).expect(200);
    expect(b.body.preset?.config.scoreMode).toBe('buttons');
    const none = await http.get('/api/adapters/resolve').query({ host: 'example.com', path: '/' }).set(auth(userToken)).expect(200);
    expect(none.body.preset).toBeNull();
  });

  it('用户保存私有预设，优先于公共预设，配置非法会被拒', async () => {
    const config = {
      version: 1,
      pics: { selectors: ['#x'], type: 'img', multiple: false },
      scoreMode: 'input',
      scoreInput: { selectors: ['#s'] },
      scoreButtons: { selectors: [], clickType: 'click' },
      submit: { selectors: ['#go'], clickType: 'click' },
      examTitle: { selectors: [], fixed: '期中' },
      questionNo: { selectors: ['#q'] },
      nextTimeoutMs: 5000,
      submitDelayMs: 0,
    };
    await http.post('/api/adapters/mine').set(auth(userToken)).send({ name: 'bad', hostPattern: 'a.com', config: { ...config, scoreMode: 'x' } }).expect(400);
    await http.post('/api/adapters/mine').set(auth(userToken)).send({ name: 'mine', hostPattern: 'https://www.XiaoXianAI.cn/abc', config }).expect(201);
    const r = await http.get('/api/adapters/resolve').query({ host: 'mark.xiaoxianai.cn', path: '/' }).set(auth(userToken)).expect(200);
    expect(r.body.preset.name).toBe('mine');
    expect(r.body.preset.hostPattern).toBe('xiaoxianai.cn');
    // 别的用户看不到
    const other = await http.post('/api/auth/login').send({ username: '王老师', password: 'password-123' }).expect(200);
    const o = await http.get('/api/adapters/resolve').query({ host: 'mark.xiaoxianai.cn', path: '/' }).set(auth(other.body.token)).expect(200);
    expect(o.body.preset).toBeNull();
  });

  let taskId: number;

  it('任务按 平台+考试+题号 upsert，可 lookup', async () => {
    const body = { platformHost: 'localhost', examTitle: '期中考试', questionNo: '17', subject: '语文', maxScore: 6, questionText: '概括文章内容', rubric: '每点 2 分' };
    const a = await http.put('/api/tasks').set(auth(userToken)).send(body).expect(200);
    const b = await http.put('/api/tasks').set(auth(userToken)).send({ ...body, maxScore: 8 }).expect(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.maxScore).toBe(8);
    taskId = a.body.id;
    const l = await http.get('/api/tasks/lookup').query({ platformHost: 'localhost', examTitle: '期中考试', questionNo: '17' }).set(auth(userToken)).expect(200);
    expect(l.body.task.id).toBe(taskId);
    await http.put('/api/tasks').set(auth(userToken)).send({ ...body, subject: '火星语' }).expect(400);
  });

  it('评分扣 1 次；同一张图重复请求走缓存不扣费；分数按步长取整且不超满分', async () => {
    const img = fakePng('a');
    const r1 = await http.post('/api/judge').set(auth(userToken)).send({ taskId, image: img }).expect(200);
    expect(r1.body.cached).toBe(false);
    expect(r1.body.balance).toBe(2);
    expect(r1.body.score).toBeGreaterThanOrEqual(0);
    expect(r1.body.score).toBeLessThanOrEqual(8);
    expect(Number.isInteger(r1.body.score)).toBe(true);
    const r2 = await http.post('/api/judge').set(auth(userToken)).send({ taskId, image: img }).expect(200);
    expect(r2.body.cached).toBe(true);
    expect(r2.body.recordId).toBe(r1.body.recordId);
    expect(r2.body.balance).toBe(2);
  });

  it('并发同一张图只扣一次', async () => {
    const img = fakePng('b');
    const rs = await Promise.all([1, 2, 3].map(() => http.post('/api/judge').set(auth(userToken)).send({ taskId, image: img })));
    rs.forEach((r) => expect(r.status).toBe(200));
    expect(new Set(rs.map((r) => r.body.recordId)).size).toBe(1);
    const me = await http.get('/api/auth/me').set(auth(userToken)).expect(200);
    expect(me.body.credits).toBe(1);
  });

  it('额度用完返回 400，不产生负余额', async () => {
    await http.post('/api/judge').set(auth(userToken)).send({ taskId, image: fakePng('c') }).expect(200);
    const r = await http.post('/api/judge').set(auth(userToken)).send({ taskId, image: fakePng('d') }).expect(400);
    expect(r.body.message).toContain('次数不足');
    const me = await http.get('/api/auth/me').set(auth(userToken)).expect(200);
    expect(me.body.credits).toBe(0);
  });

  it('非法图片被拒；不能给别人的任务评分', async () => {
    await http.post('/api/judge').set(auth(userToken)).send({ taskId, image: 'data:image/gif;base64,AAAA' }).expect(400);
    const other = await http.post('/api/auth/login').send({ username: '王老师', password: 'password-123' }).expect(200);
    await http.post('/api/judge').set({ ...auth(other.body.token), 'x-unit-id': String(activeUnitId) }).send({ taskId, image: fakePng('e') }).expect(200);
  });

  it('确认分数；超过满分被拒', async () => {
    const recs = await http.get('/api/records').query({ taskId }).set(auth(userToken)).expect(200);
    const id = recs.body.items.find((r: any) => r.status === 'done').id;
    await http.post(`/api/records/${id}/confirm`).set(auth(userToken)).send({ finalScore: 99 }).expect(400);
    await http.post(`/api/records/${id}/confirm`).set(auth(userToken)).send({ finalScore: 5, autoSubmitted: false }).expect(200);
    const tasks = await http.get('/api/tasks').set(auth(userToken)).expect(200);
    expect(tasks.body[0]).toMatchObject({ judged: 4, confirmed: 1 });
  });

  let code: string;

  it('管理员生成兑换码，用户兑换一次，重复兑换被拒，用完被拒', async () => {
    const r = await http.post('/api/admin/codes').set(auth(adminToken)).send({ count: 2, credits: 10, maxUses: 1, note: '测试' }).expect(201);
    expect(r.body.codes).toHaveLength(2);
    code = r.body.codes[0];
    expect(code).toMatch(/^EG-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    // 小写、无连字符也能兑换
    const red = await http.post('/api/billing/redeem').set(auth(userToken)).send({ code: code.toLowerCase().replace(/-/g, '') }).expect(200);
    expect(red.body).toEqual({ credits: 10, balance: 10 });
    await http.post('/api/billing/redeem').set(auth(userToken)).send({ code }).expect(400);
    const other = await http.post('/api/auth/login').send({ username: '王老师', password: 'password-123' }).expect(200);
    const used = await http.post('/api/billing/redeem').set(auth(other.body.token)).send({ code }).expect(400);
    expect(used.body.message).toContain('用完');
    await http.post('/api/billing/redeem').set(auth(other.body.token)).send({ code: 'EG-XXXX-XXXX' }).expect(400);
  });

  it('停用的兑换码不能用', async () => {
    const list = await http.get('/api/admin/codes').set(auth(adminToken)).expect(200);
    const c2 = list.body.items.find((c: any) => c.code !== code);
    await http.patch(`/api/admin/codes/${c2.id}`).set(auth(adminToken)).send({ disabled: true }).expect(200);
    await http.post('/api/billing/redeem').set(auth(userToken)).send({ code: c2.code }).expect(400);
  });

  it('流水完整：注册+3、评分-1x3、兑换+10', async () => {
    const r = await http.get('/api/billing/ledger').set(auth(userToken)).expect(200);
    expect(r.body.balance).toBe(10);
    const reasons = r.body.items.map((i: any) => `${i.reason}:${i.delta}`).reverse();
    expect(reasons).toEqual(['register:3', 'judge:-1', 'judge:-1', 'judge:-1', 'redeem:10']);
    expect(r.body.items[0].balanceAfter).toBe(10);
  });

  it('管理员调额度：不能扣成负数', async () => {
    await http.post(`/api/admin/users/${userId}/credits`).set(auth(adminToken)).send({ delta: -1000 }).expect(400);
    const r = await http.post(`/api/admin/users/${userId}/credits`).set(auth(adminToken)).send({ delta: 5, note: '补偿' }).expect(200);
    expect(r.body.balance).toBe(15);
  });

  it('停用用户后旧 token 立即失效；重置密码后旧 token 失效', async () => {
    await http.patch(`/api/admin/users/${userId}`).set(auth(adminToken)).send({ disabled: true }).expect(200);
    await http.get('/api/auth/me').set(auth(userToken)).expect(401);
    await http.post('/api/auth/login').send({ username: 'teacher', password: 'password-123' }).expect(403);
    await http.patch(`/api/admin/users/${userId}`).set(auth(adminToken)).send({ disabled: false }).expect(200);
    const r = await http.post('/api/auth/login').send({ username: 'teacher', password: 'password-123' }).expect(200);
    const changed = await http.post('/api/auth/password').set(auth(r.body.token)).send({ oldPassword: 'password-123', newPassword: 'password-456' }).expect(200);
    await http.get('/api/auth/me').set(auth(r.body.token)).expect(401);
    await http.get('/api/auth/me').set(auth(changed.body.token)).expect(200);
  });

  it('管理员不能停用自己', async () => {
    const me = await http.get('/api/auth/me').set(auth(adminToken)).expect(200);
    await http.patch(`/api/admin/users/${me.body.id}`).set(auth(adminToken)).send({ disabled: true }).expect(400);
  });

  it('管理统计、记录、预设管理', async () => {
    const s = await http.get('/api/admin/stats').set(auth(adminToken)).expect(200);
    expect(s.body).toMatchObject({ users: 3, records: 4, confirmed: 1 });
    expect(s.body.daily.length).toBeGreaterThan(0);
    const recs = await http.get('/api/admin/records').query({ q: '期中' }).set(auth(adminToken)).expect(200);
    expect(recs.body.total).toBe(4);
    expect(recs.body.items.map((x: any) => x.username)).toContain('teacher');
    const presets = await http.get('/api/admin/presets').set(auth(adminToken)).expect(200);
    const mine = presets.body.find((p: any) => p.name === 'mine');
    const pub = await http.patch(`/api/admin/presets/${mine.id}`).set(auth(adminToken)).send({ scope: 'public' }).expect(200);
    expect(pub.body).toMatchObject({ scope: 'public', ownerId: null });
    // 公开后其他用户也能解析到
    const other = await http.post('/api/auth/login').send({ username: '王老师', password: 'password-123' }).expect(200);
    const o = await http.get('/api/adapters/resolve').query({ host: 'xiaoxianai.cn', path: '/' }).set(auth(other.body.token)).expect(200);
    expect(o.body.preset?.name).toBe('mine');
  });

  it('删除任务连带删除记录', async () => {
    const r = await http.post('/api/auth/login').send({ username: 'teacher', password: 'password-456' }).expect(200);
    await http.delete(`/api/tasks/${taskId}`).set({ ...auth(r.body.token), 'x-unit-id': String(activeUnitId) }).expect(200);
    const recs = await http.get('/api/records').set({ ...auth(r.body.token), 'x-unit-id': String(activeUnitId) }).expect(200);
    expect(recs.body.total).toBe(0);
  });
});

describe('模型失败时退还次数', () => {
  let app: INestApplication;
  afterAll(() => app?.close());

  it('模型输出无法解析 -> 502，余额不变，记录为 failed', async () => {
    const cfg = loadConfig({ DB_PATH: ':memory:', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin-password-1', INITIAL_CREDITS: '2' } as NodeJS.ProcessEnv);
    const mod = await Test.createTestingModule({ imports: [AppModule.forRoot(cfg)] })
      .overrideProvider(ModelService)
      .useValue({
        isConfigured: true,
        grade: async () => {
          throw new ModelOutputError('模型回复不是 JSON');
        },
      })
      .compile();
    app = mod.createNestApplication({ logger: false });
    configureApp(app, cfg);
    await app.init();
    const http = request(app.getHttpServer());
    const admin = await http.post('/api/auth/login').send(ADMIN).expect(200);
    const unit = await http.post('/api/admin/units').set({ authorization: `Bearer ${admin.body.token}` }).send({ name: `测试单元-${Date.now()}-${Math.random()}` }).expect(201);
    const invite = await http.post('/api/admin/invites').set({ authorization: `Bearer ${admin.body.token}` }).send({ unitId: unit.body.id, count: 1, credits: 20, expiresAt: new Date(Date.now() + 86400000).toISOString() }).expect(201);
    const reg = await http.post('/api/auth/register').send({ username: 'user1', password: 'password-123', inviteToken: invite.body.tokens[0].token }).expect(201);
    const h = { authorization: `Bearer ${reg.body.token}`, 'x-unit-id': String(unit.body.id) };
    const t = await http.put('/api/tasks').set(h).send({ platformHost: 'x', examTitle: 'e', questionNo: '1', subject: '语文', maxScore: 5 }).expect(200);
    const r = await http.post('/api/judge').set(h).send({ taskId: t.body.id, image: fakePng('z') }).expect(502);
    expect(r.body.message).toContain('不扣次数');
    const me = await http.get('/api/auth/me').set(h).expect(200);
    expect(me.body.credits).toBe(20);
    const recs = await http.get('/api/records').set(h).expect(200);
    expect(recs.body.items[0]).toMatchObject({ status: 'failed', charged: false });
    const led = await http.get('/api/billing/ledger').set(h).expect(200);
    expect(led.body.items.map((i: any) => i.reason)).toEqual(['refund', 'judge', 'register']);
  });
});

describe('OpenAI 兼容模型接入', () => {
  let app: INestApplication;
  let fake: import('node:http').Server;
  const seen: any[] = [];
  let reply = '';
  /** 两阶段评分里第一阶段（纯转录）的回复 */
  let ocrReply = '作者思念外婆';
  let status = 200;
  let delayMs = 0;
  const traceDir = mkdtempSync(join(tmpdir(), 'easy-grader-traces-'));

  beforeAll(async () => {
    const http = await import('node:http');
    fake = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        seen.push({ url: req.url, auth: req.headers.authorization, body: parsed });
        setTimeout(() => {
          if (res.destroyed) return;
          const content = String(parsed.messages[0].content[0].text);
          const isOcr = content.includes('逐字转录');
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(
            status === 200
              ? JSON.stringify({
                  model: 'qwen-vl-test',
                  choices: [
                    {
                      message: {
                        content: isOcr ? ocrReply : reply,
                        reasoning_content: isOcr ? '逐字看图像。' : '先识别答卷文字，再逐点对照评分标准。',
                      },
                    },
                  ],
                })
              : '{"error":"boom"}',
          );
        }, delayMs);
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const port = (fake.address() as import('node:net').AddressInfo).port;
    const cfg = loadConfig({
      DB_PATH: ':memory:',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin-password-1',
      INITIAL_CREDITS: '5',
      MODEL_BASE_URL: `http://127.0.0.1:${port}/v1/`,
      MODEL_API_KEY: 'sk-test',
      MODEL_NAME: 'qwen-vl-max',
      MODEL_RETRY_DELAY_MS: '0',
      MODEL_TIMEOUT_MS: '200',
      SAVE_TRACES: 'true',
      TRACE_DIR: traceDir,
      GOLD_ENABLED: 'true',
      GOLD_MAX_EXAMPLES: '4',
      MODEL_SAMPLE_COUNT: '3',
      SCORE_WITH_IMAGE: 'false',
    } as NodeJS.ProcessEnv);
    const mod = await Test.createTestingModule({ imports: [AppModule.forRoot(cfg)] }).compile();
    app = mod.createNestApplication({ logger: false });
    configureApp(app, cfg);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    fake?.close();
  });

  it('请求格式正确；解析代码块里的 JSON；分数按步长取整；上游失败退还次数', async () => {
    const http = request(app.getHttpServer());
    const admin = await http.post('/api/auth/login').send(ADMIN).expect(200);
    const unit = await http.post('/api/admin/units').set({ authorization: `Bearer ${admin.body.token}` }).send({ name: `测试单元-${Date.now()}-${Math.random()}` }).expect(201);
    const invite = await http.post('/api/admin/invites').set({ authorization: `Bearer ${admin.body.token}` }).send({ unitId: unit.body.id, count: 1, credits: 20, expiresAt: new Date(Date.now() + 86400000).toISOString() }).expect(201);
    const reg = await http.post('/api/auth/register').send({ username: 'model_user', password: 'password-123', inviteToken: invite.body.tokens[0].token }).expect(201);
    const h = { authorization: `Bearer ${reg.body.token}`, 'x-unit-id': String(unit.body.id) };
    const t = await http
      .put('/api/tasks')
      .set(h)
      .send({ platformHost: 'x', examTitle: '期中', questionNo: '17', subject: '语文', maxScore: 6, scoreStep: 0.5, referenceAnswer: '思念外婆', rubric: '每点 3 分' })
      .expect(200);

    reply = '好的，评分如下：\n```json\n{"score": 4.3, "confidence": 0.82, "ocr_text": "作者思念外婆", "points": [{"rubric": "①", "level": "full", "delta": 2, "quote": "思念外婆"}, {"rubric": "②", "level": "full", "delta": 2, "quote": "作者思念"}], "reasons": ["答出思念外婆 +3", "未答乡村生活 -2"], "comment": "要点不全"}\n```';
    const img = fakePng('m');
    const r = await http.post('/api/judge').set(h).send({ taskId: t.body.id, image: img }).expect(200);
    // 分数由逐点 delta 相加得到（2 + 2），不再采用模型自己写的 score
    expect(r.body).toMatchObject({ score: 4, confidence: 0.82, ocrText: '作者思念外婆', model: 'qwen-vl-test', balance: 19 });
    expect(r.body.reasons).toHaveLength(2);
    // 三次采样结果一致，面板不需要提示不一致
    expect(r.body.samples).toEqual([4, 4, 4]);
    expect(r.body.scoreSpread).toBe(0);

    // trace：题目、两阶段提示词、图片、模型原始输出（含思考过程）和解析结果都落盘
    const traceFiles = readdirSync(traceDir);
    const traceJson = traceFiles.find((f) => f.endsWith('.json'));
    expect(traceJson).toBeTruthy();
    const trace = JSON.parse(readFileSync(join(traceDir, traceJson!), 'utf8'));
    expect(trace.task).toMatchObject({ questionNo: '17', maxScore: 6 });
    expect(trace.version).toBe(2); // trace 文件结构版本
    expect(trace.promptVersion).toBe(3); // 提示词/解析规则版本
    expect(trace.prompt).toContain('满分：6 分');
    expect(trace.prompt).toContain('【评分标准的读法】');
    expect(trace.prompt).toContain('【已转录的答卷文字】\n作者思念外婆');
    expect(trace.ocr).toMatchObject({ text: '作者思念外婆', attempts: 1 });
    expect(trace.ocr.prompt).toContain('逐字转录');
    expect(trace.ocr.prompt).not.toContain('评分标准');
    expect(trace.response.reasoning).toContain('先识别答卷');
    expect(trace.response.content).toContain('"points"');
    expect(trace.verdict).toMatchObject({ score: 4, confidence: 0.82, ocrText: '作者思念外婆' });
    expect(trace.attempts).toBe(4); // 1 次转录 + 3 次采样
    expect(trace.samples).toHaveLength(3);
    expect(trace.samples.map((s: any) => s.score)).toEqual([4, 4, 4]);
    expect(trace.samples[0].points[0]).toMatchObject({ rubric: '①', delta: 2, verified: true });
    expect(traceFiles.some((f) => f.endsWith('.png'))).toBe(true);

    // 第一次请求是纯转录：提示词里没有题目和评分标准，带图片
    const ocrCall = seen[0];
    expect(ocrCall.url).toBe('/v1/chat/completions');
    expect(ocrCall.auth).toBe('Bearer sk-test');
    expect(ocrCall.body.model).toBe('qwen-vl-max');
    expect(ocrCall.body.messages[0].content[0].text).toContain('逐字转录');
    expect(ocrCall.body.messages[0].content[0].text).not.toContain('【评分标准】');
    expect(ocrCall.body.messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: img } });

    // 第二次请求拿固定转录 + 评分标准打分；SCORE_WITH_IMAGE=false 时不带图片
    const call = seen[1];
    expect(call.body.messages[0].content[0].text).toContain('满分：6 分');
    expect(call.body.messages[0].content[0].text).toContain('作者思念外婆');
    expect(call.body.messages[0].content[0].text).not.toContain('先逐字识别答卷内容');
    expect(call.body.messages[0].content).toHaveLength(1);

    // 上游 500：可重试，默认重试 2 次（共 3 次请求）后返回 503，退还次数
    status = 500;
    const before = seen.length;
    await http.post('/api/judge').set(h).send({ taskId: t.body.id, image: fakePng('n') }).expect(503);
    expect(seen.length - before).toBe(3);
    const me = await http.get('/api/auth/me').set(h).expect(200);
    expect(me.body.credits).toBe(19);
    status = 200;

    // 超时也可重试：上游一直不响应，尝试 3 次后返回 503，退还次数
    delayMs = 1000;
    const beforeTimeout = seen.length;
    await http.post('/api/judge').set(h).send({ taskId: t.body.id, image: fakePng('t') }).expect(503);
    expect(seen.length - beforeTimeout).toBe(3);
    delayMs = 0;
    expect((await http.get('/api/auth/me').set(h)).body.credits).toBe(19);

    // 模型乱回：502，退还次数
    reply = '我无法判断这份答卷';
    await http.post('/api/judge').set(h).send({ taskId: t.body.id, image: fakePng('o') }).expect(502);
    expect((await http.get('/api/auth/me').set(h)).body.credits).toBe(19);

    // health 显示真实模型名
    expect((await http.get('/api/health')).body.model).toBe('qwen-vl-max');
  });

  it('自动学习：老师确认的分数进入后续提示词，自动提交的不算示例', async () => {
    const http = request(app.getHttpServer());
    const admin = await http.post('/api/auth/login').send(ADMIN).expect(200);
    const unit = await http.post('/api/admin/units').set({ authorization: `Bearer ${admin.body.token}` }).send({ name: `测试单元-${Date.now()}-${Math.random()}` }).expect(201);
    const invite = await http.post('/api/admin/invites').set({ authorization: `Bearer ${admin.body.token}` }).send({ unitId: unit.body.id, count: 1, credits: 20, expiresAt: new Date(Date.now() + 86400000).toISOString() }).expect(201);
    const reg = await http.post('/api/auth/register').send({ username: 'gold_user', password: 'password-123', inviteToken: invite.body.tokens[0].token }).expect(201);
    const h = { authorization: `Bearer ${reg.body.token}`, 'x-unit-id': String(unit.body.id) };
    const t = await http
      .put('/api/tasks')
      .set(h)
      .send({ platformHost: 'gold.example', examTitle: '月考', questionNo: '9', subject: '语文', maxScore: 6, rubric: '答出三点得满分' })
      .expect(200);

    ocrReply = '答案甲：强化关键核心技术攻关';
    reply = '```json\n{"score": 3, "confidence": 0.8, "ocr_text": "答案甲：强化关键核心技术攻关", "reasons": [], "comment": ""}\n```';
    const a = await http.post('/api/judge').set(h).send({ taskId: t.body.id, image: fakePng('ga') }).expect(200);
    await http.post(`/api/records/${a.body.recordId}/confirm`).set(h).send({ finalScore: 5, autoSubmitted: false }).expect(200);

    // 下一条评分的提示词里应该带上「答案甲 → 5 分」
    ocrReply = '答案乙：种业振兴行动';
    reply = '```json\n{"score": 2, "confidence": 0.8, "ocr_text": "答案乙", "reasons": [], "comment": ""}\n```';
    const b = await http.post('/api/judge').set(h).send({ taskId: t.body.id, image: fakePng('gb') }).expect(200);
    const promptB = seen[seen.length - 1].body.messages[0].content[0].text as string;
    expect(promptB).toContain('【老师已确认的评分示例】');
    expect(promptB).toContain('示例1（5 分）：答案甲');
    // 答案乙只作为当前答卷的转录出现一次，没有被当成示例
    expect((promptB.match(/答案乙/g) ?? []).length).toBe(1);

    // 自动提交的记录 finalScore 只是模型自己的分，不能当示例
    await http.post(`/api/records/${b.body.recordId}/confirm`).set(h).send({ finalScore: 1, autoSubmitted: true }).expect(200);
    ocrReply = '答案丙：数字农业建设';
    reply = '```json\n{"score": 1, "confidence": 0.8, "ocr_text": "答案丙", "reasons": [], "comment": ""}\n```';
    await http.post('/api/judge').set(h).send({ taskId: t.body.id, image: fakePng('gc') }).expect(200);
    const promptC = seen[seen.length - 1].body.messages[0].content[0].text as string;
    expect(promptC).toContain('示例1（5 分）：答案甲');
    expect(promptC).not.toContain('答案乙');

    // trace 里记下用了哪些示例，便于离线评测时排除泄漏样本
    const jsonFiles = readdirSync(traceDir).filter((f) => f.endsWith('.json'));
    const traceB = jsonFiles
      .map((f) => JSON.parse(readFileSync(join(traceDir, f), 'utf8')))
      .find((x) => x.recordId === b.body.recordId);
    expect(traceB.goldExamples).toEqual([{ recordId: a.body.recordId, score: 5 }]);
  });

  it('空白答卷：只调用一次转录，直接 0 分', async () => {
    const http = request(app.getHttpServer());
    const admin = await http.post('/api/auth/login').send(ADMIN).expect(200);
    const unit = await http.post('/api/admin/units').set({ authorization: `Bearer ${admin.body.token}` }).send({ name: `测试单元-${Date.now()}-${Math.random()}` }).expect(201);
    const invite = await http.post('/api/admin/invites').set({ authorization: `Bearer ${admin.body.token}` }).send({ unitId: unit.body.id, count: 1, credits: 20, expiresAt: new Date(Date.now() + 86400000).toISOString() }).expect(201);
    const reg = await http.post('/api/auth/register').send({ username: 'blank_user', password: 'password-123', inviteToken: invite.body.tokens[0].token }).expect(201);
    const h = { authorization: `Bearer ${reg.body.token}`, 'x-unit-id': String(unit.body.id) };
    const t = await http
      .put('/api/tasks')
      .set(h)
      .send({ platformHost: 'blank.example', examTitle: '月考', questionNo: '2', subject: '语文', maxScore: 6, rubric: '每点 2 分' })
      .expect(200);

    ocrReply = '（空白）';
    const before = seen.length;
    const r = await http.post('/api/judge').set(h).send({ taskId: t.body.id, image: fakePng('blank') }).expect(200);
    expect(seen.length - before).toBe(1); // 识别为空白，不再调用评分
    expect(r.body).toMatchObject({ score: 0, confidence: 0.2, ocrText: '（空白）' });
    expect((await http.get('/api/auth/me').set(h)).body.credits).toBe(19);
    ocrReply = '作者思念外婆';
  });
});

describe('限流', () => {
  let app: INestApplication;
  afterAll(() => app?.close());

  it('登录接口超过 RATE_LIMIT_AUTH 返回 429，不影响 health', async () => {
    const cfg = loadConfig({ DB_PATH: ':memory:', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin-password-1', RATE_LIMIT_AUTH: '3' } as NodeJS.ProcessEnv);
    const mod = await Test.createTestingModule({ imports: [AppModule.forRoot(cfg)] }).compile();
    app = mod.createNestApplication({ logger: false });
    configureApp(app, cfg);
    await app.init();
    const http = request(app.getHttpServer());
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await http.post('/api/auth/login').send({ username: 'x', password: 'y' })).status);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    await http.get('/api/health').expect(200);
  });
});

describe('纯函数', () => {
  it('snapScore', () => {
    expect(snapScore(5.4, 10, 1)).toBe(5);
    expect(snapScore(5.3, 10, 0.5)).toBe(5.5);
    expect(snapScore(12, 10, 1)).toBe(10);
    expect(snapScore(-1, 10, 1)).toBe(0);
    expect(() => snapScore(NaN, 10, 1)).toThrow();
  });

  it('extractJson / parseVerdict 兼容代码块与百分制置信度', () => {
    expect(extractJson('好的：\n```json\n{"score": 4}\n```')).toEqual({ score: 4 });
    const v = parseVerdict('结果 {"score":"3.6","confidence":85,"reasons":["a",1,"b"],"ocr_text":"x"}', { maxScore: 6, scoreStep: 1 }, 'm');
    expect(v).toMatchObject({ score: 4, confidence: 0.85, reasons: ['a', 'b'], ocrText: 'x', model: 'm' });
    expect(() => extractJson('没有 json')).toThrow();
  });

  it('pickGoldExamples：跳过空识别，按分数轮转覆盖不同分数段', () => {
    const rows = [
      { id: 1, finalScore: 6, ocrText: 'a' },
      { id: 2, finalScore: 6, ocrText: 'b' },
      { id: 3, finalScore: 2, ocrText: '' }, // 没有识别文字，跳过
      { id: 4, finalScore: 4, ocrText: 'c' },
      { id: 5, finalScore: null, ocrText: 'd' },
      { id: 6, finalScore: 6, ocrText: 'e' },
    ];
    expect(pickGoldExamples(rows, 3)).toEqual([
      { recordId: 4, score: 4, ocrText: 'c' },
      { recordId: 1, score: 6, ocrText: 'a' },
      { recordId: 2, score: 6, ocrText: 'b' },
    ]);
    expect(pickGoldExamples(rows, 0)).toEqual([]);
  });

  it('isBlankOcr 与转录提示词', () => {
    expect(isBlankOcr('（空白）')).toBe(true);
    expect(isBlankOcr('  \n ')).toBe(true);
    expect(isBlankOcr('①强化关键核心技术攻关')).toBe(false);
    // 转录阶段不能出现评分标准，否则模型又会按得分点补全
    expect(buildOcrPrompt()).not.toContain('评分标准');
  });

  it('评分提示词说明要点句和典型事例的计分方式', () => {
    const task = {
      subject: '语文',
      maxScore: 6,
      scoreStep: 1,
      questionType: '',
      questionText: '',
      referenceAnswer: '',
      rubric: '①强化关键核心技术自主攻关。如杂交水稻的研发实践。',
    } as unknown as Parameters<typeof buildPrompt>[0];
    const prompt = buildPrompt(task, [], '①杂交水稻育种');
    expect(prompt).toContain('【评分标准的读法】');
    expect(prompt).toContain('要点句');
    expect(prompt).toContain('典型事例');
  });

  it('逐点判定：引用必须出现在答卷文字里，分数由 delta 汇总', () => {
    const reply = JSON.stringify({
      points: [
        { rubric: '①', level: 'full', delta: 2, quote: '强化关键核心技术攻关' },
        { rubric: '②', level: 'full', delta: 2, quote: '推动数字农业智慧农业建设' }, // 转录里没有
        { rubric: '③', level: 'partial', delta: 1, quote: '品种改良' }, // 转录里没有
      ],
      confidence: 0.9,
      reasons: [],
      comment: '',
    });
    const v = parseVerdict(reply, { maxScore: 6, scoreStep: 1 }, 'm', '①强化关键核心技术攻关，实现自主可控');
    expect(v.score).toBe(2);
    expect(v.points).toHaveLength(3);
    expect(v.points![0]).toMatchObject({ verified: true, delta: 2 });
    expect(v.points![1]).toMatchObject({ verified: false, delta: 0 });
    expect(v.points![2]).toMatchObject({ verified: false, delta: 0 });
    expect(v.confidence).toBe(0.7);
    expect(v.reasons.join('')).toContain('未采信');

    // 转录里夹着「（划掉：…）」标注时，模型引用时省略这层标注也算连续原文
    const struck = JSON.stringify({
      points: [{ rubric: '③', level: 'partial', delta: 1, quote: '采取形成改良与代用有机结合的技术路径' }],
      confidence: 0.8,
    });
    const v2 = parseVerdict(
      struck,
      { maxScore: 6, scoreStep: 1 },
      'm',
      '⑤采取形成改良与代（划掉：制）用有机结合的技术路径，选育出一批苗头',
    );
    expect(v2.points![0]).toMatchObject({ verified: true, delta: 1 });

    // 四个完整点相加超过满分时夹到 6（“答任意三点得满分”）
    const four = JSON.stringify({
      points: [
        { rubric: '①', level: 'full', delta: 2, quote: '强化关键核心技术攻关' },
        { rubric: '②', level: 'full', delta: 2, quote: '实现自主可控' },
        { rubric: '③', level: 'full', delta: 2, quote: '强化关键核心技术' },
        { rubric: '④', level: 'full', delta: 2, quote: '自主可控' },
      ],
      confidence: 0.9,
    });
    expect(parseVerdict(four, { maxScore: 6, scoreStep: 1 }, 'm', '①强化关键核心技术攻关，实现自主可控').score).toBe(6);
  });

  it('采样配置夹取；SCORE_WITH_IMAGE 可关闭', () => {
    const base = { DB_PATH: ':memory:' } as NodeJS.ProcessEnv;
    expect(loadConfig({ ...base, MODEL_SAMPLE_COUNT: '9' }).model.sampleCount).toBe(5);
    expect(loadConfig({ ...base, MODEL_SAMPLE_COUNT: '0' }).model.sampleCount).toBe(1);
    expect(loadConfig({ ...base, SCORE_WITH_IMAGE: 'false' }).model.scoreWithImage).toBe(false);
    expect(loadConfig(base).model.scoreWithImage).toBe(true);
  });

  it('host 匹配', () => {
    expect(normalizeHostPattern('https://*.Foo.com:8080/a')).toBe('foo.com');
    expect(hostMatches('a.b.foo.com', 'foo.com')).toBe(true);
    expect(hostMatches('evilfoo.com', 'foo.com')).toBe(false);
    expect(hostMatches('localhost:3000', 'localhost')).toBe(true);
  });

  it('CORS 来源', () => {
    expect(isAllowedOrigin('chrome-extension://abcdefghijklmnop', [])).toBe(true);
    expect(isAllowedOrigin('https://evil.com', [])).toBe(false);
    expect(isAllowedOrigin('https://ok.com', ['https://ok.com'])).toBe(true);
    expect(isAllowedOrigin(undefined, [])).toBe(true);
  });
});

describe('管理单元：个人工作区、共享与默认单元', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let adminToken: string;
  let sharedUnitId: number;
  let aId: number;
  let aToken: string;
  let aPersonal: number;
  let bId: number;
  let bToken: string;
  const PASSWORD = 'password-123';

  const h = (token: string) => ({ authorization: `Bearer ${token}` });
  const hu = (token: string, unitId: number) => ({ authorization: `Bearer ${token}`, 'x-unit-id': String(unitId) });
  const taskBody = (host: string, questionNo = '1') => ({
    platformHost: host,
    examTitle: '单元测试',
    questionNo,
    subject: '语文',
    maxScore: 5,
    referenceAnswer: '参考答案',
    rubric: '答出要点得满分',
  });

  beforeAll(async () => {
    const cfg = loadConfig({
      DB_PATH: ':memory:',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin-test-pass',
      RATE_LIMIT_DEFAULT: '10000',
      RATE_LIMIT_AUTH: '10000',
      RATE_LIMIT_JUDGE: '10000',
    } as NodeJS.ProcessEnv);
    const mod = await Test.createTestingModule({ imports: [AppModule.forRoot(cfg)] }).compile();
    app = mod.createNestApplication({ logger: false });
    configureApp(app, cfg);
    await app.init();
    http = request(app.getHttpServer());

    const admin = await http.post('/api/auth/login').send({ username: 'admin', password: 'admin-test-pass' }).expect(200);
    adminToken = admin.body.token;
    const unit = await http.post('/api/admin/units').set(h(adminToken)).send({ name: '共享阅卷单元' }).expect(201);
    sharedUnitId = unit.body.id;

    const invA = await http
      .post('/api/admin/invites')
      .set(h(adminToken))
      .send({ unitId: sharedUnitId, count: 1, maxUses: 1, credits: 5, expiresAt: new Date(Date.now() + 86400000).toISOString() })
      .expect(201);
    const invB = await http
      .post('/api/admin/invites')
      .set(h(adminToken))
      .send({ unitId: sharedUnitId, count: 1, maxUses: 1, credits: 10, expiresAt: new Date(Date.now() + 86400000).toISOString() })
      .expect(201);
    const a = await http.post('/api/auth/register').send({ username: 'unit_a', password: PASSWORD, inviteToken: invA.body.tokens[0].token }).expect(201);
    const b = await http.post('/api/auth/register').send({ username: 'unit_b', password: PASSWORD, inviteToken: invB.body.tokens[0].token }).expect(201);
    aToken = a.body.token;
    aId = a.body.user.id;
    bToken = b.body.token;
    bId = b.body.user.id;

    const users = app.get<Repository<User>>(getRepositoryToken(User));
    aPersonal = (await users.findOneByOrFail({ id: aId })).personalUnitId!;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('邀请注册同时拥有被邀请单元和个人单元', async () => {
    const r = await http.get('/api/units').set(h(aToken)).expect(200);
    expect(r.body.find((u: any) => u.id === sharedUnitId)).toMatchObject({ role: 'grader' });
    expect(r.body.find((u: any) => u.id === aPersonal)).toMatchObject({ role: 'owner' });
    expect(aPersonal).toBeGreaterThan(0);
  });

  it('不带 X-Unit-Id 时默认写入个人单元，而不是共享单元', async () => {
    const t = await http.put('/api/tasks').set(h(aToken)).send(taskBody('personal.example')).expect(200);
    expect(t.body.unitId).toBe(aPersonal);
    const list = await http.get('/api/tasks').set(h(aToken)).expect(200);
    expect(list.body.map((x: any) => x.id)).toContain(t.body.id);
    // 共享单元里看不到这条任务
    const shared = await http.get('/api/tasks').set(hu(aToken, sharedUnitId)).expect(200);
    expect(shared.body.map((x: any) => x.id)).not.toContain(t.body.id);
  });

  it('管理员开户也会创建个人单元', async () => {
    await http.post('/api/admin/users').set(h(adminToken)).send({ username: 'created_by_admin', password: PASSWORD }).expect(201);
    const login = await http.post('/api/auth/login').send({ username: 'created_by_admin', password: PASSWORD }).expect(200);
    const units = await http.get('/api/units').set(h(login.body.token)).expect(200);
    expect(units.body).toHaveLength(1);
    expect(units.body[0].role).toBe('owner');
    const t = await http.put('/api/tasks').set(h(login.body.token)).send(taskBody('admin-created.example')).expect(200);
    expect(t.body.unitId).toBe(units.body[0].id);
  });

  it('同时拥有共享单元的管理员，默认仍写个人单元', async () => {
    const users = app.get<Repository<User>>(getRepositoryToken(User));
    const admin = await users.findOneByOrFail({ username: 'admin' });
    expect(admin.personalUnitId).toBeGreaterThan(0);
    const t = await http.put('/api/tasks').set(h(adminToken)).send(taskBody('admin-personal.example')).expect(200);
    expect(t.body.unitId).toBe(admin.personalUnitId);
    expect(t.body.unitId).not.toBe(sharedUnitId);
  });

  it('改名/改描述后仍认得出个人单元，不会重复创建', async () => {
    const units = app.get<Repository<ManagementUnit>>(getRepositoryToken(ManagementUnit));
    await http
      .patch(`/api/admin/units/${aPersonal}`)
      .set(h(adminToken))
      .send({ name: '改名后的个人单元', description: '老师自己改的描述' })
      .expect(200);
    const users = app.get<Repository<User>>(getRepositoryToken(User));
    const user = await users.findOneByOrFail({ id: aId });
    const again = await app.get(UnitService).ensurePersonalUnit(user);
    expect(again.id).toBe(aPersonal);
    expect(again.kind).toBe('personal');
    expect(await units.findBy({ ownerId: aId, kind: 'personal' })).toHaveLength(1);
    expect((await users.findOneByOrFail({ id: aId })).personalUnitId).toBe(aPersonal);
  });

  it('同单元成员共享任务；缓存的评分余额按请求者计算', async () => {
    const t = await http.put('/api/tasks').set(hu(aToken, sharedUnitId)).send(taskBody('shared.example', '17')).expect(200);
    const lookup = await http
      .get('/api/tasks/lookup')
      .query({ platformHost: 'shared.example', examTitle: '单元测试', questionNo: '17' })
      .set(hu(bToken, sharedUnitId))
      .expect(200);
    expect(lookup.body.task?.id).toBe(t.body.id);

    const img = fakePng('shared-paper');
    const byB = await http.post('/api/judge').set(hu(bToken, sharedUnitId)).send({ taskId: t.body.id, image: img }).expect(200);
    expect(byB.body.balance).toBe(9); // B 自己的 10 次，扣掉本次
    const byA = await http.post('/api/judge').set(hu(aToken, sharedUnitId)).send({ taskId: t.body.id, image: img }).expect(200);
    expect(byA.body.cached).toBe(true); // 复用 B 的评分结果
    expect(byA.body.recordId).toBe(byB.body.recordId);
    expect(byA.body.balance).toBe(5); // 余额仍是 A 自己的 5 次，不是 B 的 9

    await http.post(`/api/records/${byB.body.recordId}/confirm`).set(hu(aToken, sharedUnitId)).send({ finalScore: 4, autoSubmitted: false }).expect(200);
  });

  it('viewer 可以读，但不能改任务或发起评分', async () => {
    await http
      .patch(`/api/admin/units/${sharedUnitId}/members/${bId}`)
      .set(h(adminToken))
      .send({ username: 'unit_b', role: 'viewer' })
      .expect(200);
    await http.get('/api/tasks').set(hu(bToken, sharedUnitId)).expect(200);
    await http.put('/api/tasks').set(hu(bToken, sharedUnitId)).send(taskBody('viewer.example', '3')).expect(403);
    await http.post('/api/judge').set(hu(bToken, sharedUnitId)).send({ taskId: 1, image: fakePng('viewer') }).expect(403);
    // grader 仍然可以写
    await http.put('/api/tasks').set(hu(aToken, sharedUnitId)).send(taskBody('grader.example', '4')).expect(200);
  });

  it('成员列表按路由里的 unitId 鉴权，不会回退到个人单元', async () => {
    await http.get(`/api/admin/units/${sharedUnitId}/members`).set(h(adminToken)).expect(200);
    await http.post('/api/admin/users').set(h(adminToken)).send({ username: 'other_admin', password: PASSWORD, role: 'admin' }).expect(201);
    const other = await http.post('/api/auth/login').send({ username: 'other_admin', password: PASSWORD }).expect(200);
    // 是管理员、也有自己的个人单元，但不是共享单元成员
    await http.get(`/api/admin/units/${sharedUnitId}/members`).set(h(other.body.token)).expect(403);
  });
});
