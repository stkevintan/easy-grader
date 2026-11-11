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
  ValidateNested,
} from 'class-validator';

export const SUBJECTS = ['语文', '数学', '英语', '历史', '地理', '道德与法治', '政治', '物理', '化学', '生物', '其他'];

/** 对齐咖喱阅卷 taskInfo.exam */
export class ExamDto {
  @IsOptional() @IsString() @MaxLength(200) exam?: string;
  @IsOptional() @IsIn(SUBJECTS) subject?: string;
  @IsOptional() @IsString() @MaxLength(100) q_index?: string;
}

/** 对齐 taskInfo.question.content；不同题型用不同字段 */
export class QuestionContentDto {
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.5) @Max(200) score?: number;
  @IsOptional() @IsString() @MaxLength(8000) title?: string;
  @IsOptional() @IsString() @MaxLength(8000) reference?: string;
  @IsOptional() @IsString() @MaxLength(8000) command?: string;
  @IsOptional() @IsString() @MaxLength(8000) resource?: string;
  @IsOptional() @IsString() @MaxLength(8000) target?: string;
  @IsOptional() @IsString() @MaxLength(8000) target_command?: string;
  @IsOptional() @IsString() @MaxLength(2000) keywords?: string;
}

export class QuestionDto {
  @IsOptional() @IsString() @MaxLength(50) type?: string;
  @IsOptional() @ValidateNested() @Type(() => QuestionContentDto) content?: QuestionContentDto;
  @IsOptional() @IsString() @MaxLength(8000) extra?: string;
}

/** 对齐 taskInfo.majorInput */
export class MajorInputDto {
  @IsOptional() @IsString() @MaxLength(50) key?: string;
  @IsOptional() @IsString() @MaxLength(50) name?: string;
  @IsOptional() @IsString() @MaxLength(8000) content?: string;
}

export class UpsertTaskDto {
  @IsString() @MaxLength(255) platformHost!: string;
  @IsOptional() @ValidateNested() @Type(() => ExamDto) exam?: ExamDto;
  @IsOptional() @ValidateNested() @Type(() => QuestionDto) question?: QuestionDto;
  @IsOptional() @ValidateNested() @Type(() => MajorInputDto) majorInput?: MajorInputDto;
  @IsOptional() @Type(() => Number) @IsIn([0.5, 1, 2, 5]) scoreStep?: number;

  /** 旧版的扁平字段，继续接受，服务端会归一化成上面的结构 */
  @IsOptional() @IsString() @MaxLength(200) examTitle?: string;
  @IsOptional() @IsString() @MaxLength(100) questionNo?: string;
  @IsOptional() @IsIn(SUBJECTS) subject?: string;
  @IsOptional() @IsString() @MaxLength(50) questionType?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.5) @Max(200) maxScore?: number;
  @IsOptional() @IsString() @MaxLength(8000) questionText?: string;
  @IsOptional() @IsString() @MaxLength(8000) referenceAnswer?: string;
  @IsOptional() @IsString() @MaxLength(8000) rubric?: string;
}

export class FindTaskQuery {
  @IsString() @MaxLength(255) platformHost!: string;
  @IsOptional() @IsString() @MaxLength(200) exam?: string;
  @IsOptional() @IsString() @MaxLength(100) q_index?: string;
  @IsOptional() @IsString() @MaxLength(200) examTitle?: string;
  @IsOptional() @IsString() @MaxLength(100) questionNo?: string;
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
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(200) modifiedScore?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(200) finalScore?: number;
  @IsOptional() @IsBoolean() isAuto?: boolean;
  @IsOptional() @IsBoolean() autoSubmitted?: boolean;
}

export class ListQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @Type(() => Number) @IsInt() taskId?: number;
  @IsOptional() @Type(() => Number) @IsInt() userId?: number;
  @IsOptional() @IsString() @Length(0, 100) q?: string;
}
