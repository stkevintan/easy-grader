import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AdaptersController } from './adapters/adapters.controller';
import { AdaptersService } from './adapters/adapters.service';
import { AdminController } from './admin/admin.controller';
import { UnitController } from './admin/unit.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { BillingService } from './billing/billing.service';
import { AuthGuard } from './common/auth.guard';
import { UserThrottlerGuard } from './common/throttler.guard';
import { APP_CONFIG, AppConfig, loadConfig } from './config';
import { ENTITIES } from './entities';
import { JudgeController } from './judge/judge.controller';
import { JudgeService } from './judge/judge.service';
import { GoldService } from './judge/gold.service';
import { ModelService } from './judge/model.service';
import { TaskInfoService } from './judge/task-info.service';
import { TraceService } from './trace/trace.service';
import { InviteService } from './invite.service';
import { FlagController } from './flags/flag.controller';
import { FlagService } from './flags/flag.service';

@Module({})
export class AppModule {
  static forRoot(cfg: AppConfig = loadConfig()): DynamicModule {
    if (cfg.dbPath !== ':memory:') mkdirSync(dirname(cfg.dbPath), { recursive: true });
    return {
      module: AppModule,
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: cfg.dbPath,
          entities: ENTITIES,
          // 单文件 SQLite + 实体变化较少，直接同步表结构；改字段前请先备份 data/app.db
          synchronize: true,
          prepareDatabase: (db: { pragma: (s: string) => unknown }) => {
            db.pragma('journal_mode = WAL');
            db.pragma('busy_timeout = 5000');
            db.pragma('foreign_keys = ON');
          },
        }),
        TypeOrmModule.forFeature(ENTITIES),
        JwtModule.register({
          secret: cfg.jwtSecret,
          signOptions: { expiresIn: cfg.jwtExpiresIn as any, algorithm: 'HS256' },
          verifyOptions: { algorithms: ['HS256'] },
        }),
        // 三个命名限流器：default 作用于全部路由；auth / judge 只在标了 @Throttle 的路由上生效
        ThrottlerModule.forRoot([
          { name: 'default', ttl: 60_000, limit: cfg.rateLimit.default },
          { name: 'auth', ttl: 60_000, limit: cfg.rateLimit.auth },
          { name: 'judge', ttl: 60_000, limit: cfg.rateLimit.judge },
        ]),
      ],
      controllers: [AuthController, JudgeController, AdaptersController, AdminController, UnitController, FlagController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        BillingService,
        AuthService,
        ModelService,
        JudgeService,
        GoldService,
        TaskInfoService,
        AdaptersService,
        TraceService,
        InviteService,
        FlagService,
        // 顺序重要：先鉴权（写入 req.user），再按用户限流
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: UserThrottlerGuard },
      ],
    };
  }
}
