import { Controller, Get } from '@nestjs/common';
import { CurrentUser, AuthUser } from './common/auth.guard';
import { UnitService } from './unit.service';

@Controller('api/units')
export class UnitApiController {
  constructor(private readonly units: UnitService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.units.listForUser(user.id);
  }
}
