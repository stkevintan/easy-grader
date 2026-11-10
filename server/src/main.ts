import 'reflect-metadata';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Express } from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppModule } from './app.module';
import { AppConfig, loadConfig } from './config';

/** 扩展 ID 不固定（开发版每台机器不同），所以放行所有扩展来源；网页来源只放行配置的白名单 */
export function isAllowedOrigin(origin: string | undefined, extra: string[]): boolean {
  if (!origin) return true; // 同源请求、curl 等
  if (/^(chrome|moz|edge)-extension:\/\/[a-z0-9-]+$/i.test(origin)) return true;
  return extra.includes(origin);
}

export function configureApp(app: INestApplication, cfg: AppConfig) {
  const ex = app as NestExpressApplication;
  ex.disable('x-powered-by');
  ex.useBodyParser('json', { limit: Math.ceil(cfg.maxImageBytes * 1.4) + 64 * 1024 });
  ex.enableCors({
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin, cfg.corsOrigins)),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization'],
    maxAge: 600,
  });
  ex.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, stopAtFirstError: true }),
  );

  // 管理后台（admin/，无构建步骤）与本地演示阅卷页。
  // 默认在仓库根目录找（server/dist 往上两级）；Docker 镜像里通过 ADMIN_DIR / DEMO_DIR 指定
  const root = resolve(__dirname, '..', '..');
  const express = ex.getHttpAdapter().getInstance() as Express;
  const admin = cfg.adminDir || join(root, 'admin');
  if (existsSync(join(admin, 'index.html'))) {
    ex.useStaticAssets(admin, { prefix: '/admin/', index: 'index.html' });
    express.get('/admin', (_req, res) => res.redirect('/admin/'));
  }
  const demo = cfg.demoDir || join(root, 'demo');
  if (cfg.serveDemo && existsSync(demo)) ex.useStaticAssets(demo, { prefix: '/demo/', index: 'index.html' });
}

async function bootstrap() {
  const cfg = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg), {
    logger: ['log', 'warn', 'error'],
  });
  configureApp(app, cfg);
  app.enableShutdownHooks();
  await app.listen(cfg.port, cfg.host);
  const base = `http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`;
  const log = new Logger('Bootstrap');
  log.log(`服务已启动：${base}/api/health`);
  log.log(`管理后台：${base}/admin/    演示阅卷页：${base}/demo/`);
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost')
    log.warn('服务监听在非本机地址，请务必放在 HTTPS 反向代理之后，并设置 ADMIN_PASSWORD / JWT_SECRET');
}

if (require.main === module) {
  bootstrap().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
