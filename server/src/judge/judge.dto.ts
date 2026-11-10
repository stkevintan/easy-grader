import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const SUBJECTS = ['语文', '数学', '英语', '历史', '地理', '道德与法治', '政治', '物理', '化学', '生物', '其他'];

export class UpsertTaskDto {
  @IsString() @MaxLength(255) platformHost!: string;
  @IsString() @MaxLength(200) examTitle!: string;
  @IsString() @MaxLength(100) questionNo!: string;
  @IsIn(SUBJECTS) subject!: string;
  @IsOptional() @IsString() @MaxLength(50) questionType?: string;
  @Type(() => Number) @IsNumber() @Min(0.5) @Max(200) maxScore!: number;
  @IsOptional() @Type(() => Number) @IsIn([0.5, 1, 2, 5]) scoreStep?: number;
  @IsOptional() @IsString() @MaxLength(8000) questionText?: string;
  @IsOptional() @IsString() @MaxLength(8000) referenceAnswer?: string;
  @IsOptional() @IsString() @MaxLength(8000) rubric?: string;
}

export class FindTaskQuery {
  @IsString() @MaxLength(255) platformHost!: string;
  @IsString() @MaxLength(200) examTitle!: string;
  @IsString() @MaxLength(100) questionNo!: string;
}

export class JudgeDto {
  @Type(() => Number) @IsInt() taskId!: number;
  /** data:image/(png|jpeg|webp);base64,... */
  @IsString()
  @Matches(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, { message: 'image 必须是 png/jpeg/webp 的 data URL' })
  image!: string;
  /** 同一张答卷重复请求时直接返回旧结果，不重复扣费 */
  @IsOptional() @IsBoolean() force?: boolean;
}

export class ConfirmDto {
  @Type(() => Number) @IsNumber() @Min(0) @Max(200) finalScore!: number;
  @IsOptional() @IsBoolean() autoSubmitted?: boolean;
}

export class ListQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @Type(() => Number) @IsInt() taskId?: number;
  @IsOptional() @Type(() => Number) @IsInt() userId?: number;
  @IsOptional() @IsString() @Length(0, 100) q?: string;
}
