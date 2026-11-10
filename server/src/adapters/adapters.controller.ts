import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/auth.guard';
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
  @IsString() @MaxLength(255) host!: string;
  @IsOptional() @IsString() @MaxLength(2000) path?: string;
}

@Controller('api/adapters')
export class AdaptersController {
  constructor(private readonly adapters: AdaptersService) {}

  @Get('resolve')
  async resolve(@CurrentUser() u: AuthUser, @Query() q: ResolveQuery) {
    return { preset: await this.adapters.resolve(u.id, q.host, q.path ?? '/') };
  }

  @Get('mine')
  mine(@CurrentUser() u: AuthUser) {
    return this.adapters.listMine(u.id);
  }

  @Post('mine')
  save(@CurrentUser() u: AuthUser, @Body() dto: SavePresetDto) {
    return this.adapters.saveMine(u.id, dto);
  }

  @Delete('mine/:id')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.adapters.deleteMine(u.id, id);
  }
}
