import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser, CurrentUnit, CurrentUser, UnitAccess, UnitContext } from '../common/auth.guard';
import type { AdapterConfig } from './adapter-config';
import { AdaptersService } from './adapters.service';

export class SavePresetDto {
  @IsString() @MaxLength(100) name!: string;
  @IsString() @MaxLength(255) hostPattern!: string;
  @IsOptional() @IsString() @MaxLength(200) pathPattern?: string;
  @IsObject() @Type(() => Object) config!: AdapterConfig;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class ResolveQuery {
  @IsOptional() @Type(() => Number) unitId?: number;
  @IsString() @MaxLength(255) host!: string;
  @IsOptional() @IsString() @MaxLength(2000) path?: string;
}

@UnitAccess(['viewer', 'grader', 'manager', 'owner'])
@Controller('api/adapters')
export class AdaptersController {
  constructor(private readonly adapters: AdaptersService) {}

  @Get('resolve')
  async resolve(@CurrentUser() u: AuthUser, @CurrentUnit() unit: UnitContext, @Query() q: ResolveQuery) {
    if (q.unitId !== undefined && q.unitId !== unit.id) throw new BadRequestException('管理单元不一致');
    return { preset: await this.adapters.resolve(u.id, unit.id, q.host, q.path ?? '/') };
  }

  @Get('mine')
  mine(@CurrentUser() u: AuthUser, @CurrentUnit() unit: UnitContext) {
    return this.adapters.listMine(u.id, unit.id);
  }

  @Post('mine')
  save(@CurrentUser() u: AuthUser, @CurrentUnit() unit: UnitContext, @Body() dto: SavePresetDto) {
    return this.adapters.saveMine(u.id, unit.id, dto);
  }

  @Delete('mine/:id')
  remove(@CurrentUser() u: AuthUser, @CurrentUnit() unit: UnitContext, @Param('id', ParseIntPipe) id: number) {
    return this.adapters.deleteMine(u.id, unit.id, id);
  }
}
