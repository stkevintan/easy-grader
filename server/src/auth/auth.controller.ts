import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BillingService } from '../billing/billing.service';
import { ThrottleBucket } from '../common/throttler.guard';
import { AuthUser, CurrentUser, Public } from '../common/auth.guard';
import { APP_CONFIG, AppConfig } from '../config';
import { CreditLedger } from '../entities';
import { ChangePasswordDto, LoginDto, RedeemDto, RegisterDto } from './auth.dto';
import { AuthService } from './auth.service';

// 版本号取自 package.json，避免发版时忘了同步这里的硬编码
const APP_VERSION = (require('../../package.json') as { version?: string }).version ?? '0.0.0';

@Controller('api')
export class AuthController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly auth: AuthService,
    private readonly billing: BillingService,
    @InjectRepository(CreditLedger) private readonly ledger: Repository<CreditLedger>,
  ) {}

  /** 扩展和后台用来探测服务是否可用、是否允许注册 */
  @Public()
  @Get('health')
  health() {
    return {
      ok: true,
      name: 'easy-grader',
      version: APP_VERSION,
      allowRegister: this.cfg.allowRegister,
      model: this.cfg.model.apiKey ? this.cfg.model.name : 'mock',
    };
  }

  @Public()
  @ThrottleBucket('auth')
  @Post('auth/register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto.username, dto.password, dto.inviteToken);
  }

  @Public()
  @ThrottleBucket('auth')
  @HttpCode(200)
  @Post('auth/login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.username, dto.password);
  }

  @Get('auth/me')
  me(@CurrentUser() u: AuthUser) {
    return this.auth.me(u.id);
  }

  @ThrottleBucket('auth')
  @HttpCode(200)
  @Post('auth/password')
  changePassword(@CurrentUser() u: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(u.id, dto.oldPassword, dto.newPassword);
  }

  @ThrottleBucket('auth')
  @HttpCode(200)
  @Post('billing/redeem')
  redeem(@CurrentUser() u: AuthUser, @Body() dto: RedeemDto) {
    return this.billing.redeem(u.id, dto.code);
  }

  @Get('billing/ledger')
  async myLedger(@CurrentUser() u: AuthUser, @Query('limit') limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const items = await this.ledger.find({ where: { userId: u.id }, order: { id: 'DESC' }, take });
    return { balance: this.billing.balance(u.id), items };
  }
}
