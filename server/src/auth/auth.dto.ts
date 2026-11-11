import { IsString, Length, Matches } from 'class-validator';

export class RegisterDto {
  @IsString() @Length(10, 80) inviteToken!: string;

  @IsString()
  @Matches(/^[a-zA-Z0-9_一-龥]{3,32}$/, { message: '用户名为 3-32 位字母、数字、下划线或中文' })
  username!: string;

  @IsString()
  @Length(8, 128, { message: '密码长度需为 8-128 位' })
  password!: string;
}

export class LoginDto {
  @IsString() @Length(1, 32) username!: string;
  @IsString() @Length(1, 128) password!: string;
}

export class ChangePasswordDto {
  @IsString() @Length(1, 128) oldPassword!: string;
  @IsString() @Length(8, 128, { message: '新密码长度需为 8-128 位' }) newPassword!: string;
}

export class RedeemDto {
  @IsString() @Length(4, 40) code!: string;
}
