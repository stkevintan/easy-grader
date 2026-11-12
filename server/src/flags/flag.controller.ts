import { Body, Controller, Delete, Get, Param, ParseIntPipe, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AdminOnly, AuthUser, CurrentUser } from '../common/auth.guard';
import type { FlagScope } from '../entities';
import { FlagService } from './flag.service';

const SCOPES: FlagScope[] = ['global', 'rollout', 'unit', 'user'];

class SetOverrideDto {
  @IsIn(SCOPES) scope!: FlagScope;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) targetId?: number;
  /** scope=user 时可以用用户名代替 targetId（精确匹配） */
  @IsOptional() @IsString() @MaxLength(32) username?: string;
  /** 类型由开关定义校验（布尔 / 数字 / 字符串） */
  @IsDefined() value!: unknown;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100) percent?: number;
}

class RemoveOverrideQuery {
  @IsIn(SCOPES) scope!: FlagScope;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) targetId?: number;
}

class AuditQuery {
  @IsOptional() @IsString() @MaxLength(64) key?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

@Controller('api')
export class FlagController {
  constructor(private readonly flags: FlagService) {}

  /** 扩展：当前用户的开关取值（只含 client 开关） */
  @Get('flags')
  async mine(@CurrentUser() u: AuthUser) {
    return { flags: await this.flags.clientFlags(u.id) };
  }

  @AdminOnly()
  @Get('admin/flags')
  list() {
    return this.flags.listForAdmin();
  }

  @AdminOnly()
  @Get('admin/flags-audit')
  audit(@Query() q: AuditQuery) {
    return this.flags.auditLog(q.key, q.page, q.pageSize);
  }

  /** 查看某个用户最终拿到的取值和来源，排查「为什么他看不到这个功能」 */
  @AdminOnly()
  @Get('admin/flags/evaluate/:userId')
  evaluate(@Param('userId', ParseIntPipe) userId: number) {
    return this.flags.evaluateAll(userId);
  }

  @AdminOnly()
  @Put('admin/flags/:key')
  set(@CurrentUser() me: AuthUser, @Param('key') key: string, @Body() dto: SetOverrideDto) {
    return this.flags.setOverride(me, key, dto);
  }

  @AdminOnly()
  @Delete('admin/flags/:key')
  remove(@CurrentUser() me: AuthUser, @Param('key') key: string, @Query() q: RemoveOverrideQuery) {
    return this.flags.removeOverride(me, key, q.scope, q.targetId);
  }
}
