import { All, Controller, Req, Res, Next, UseGuards, Get, Post, Body, Param, Delete } from '@nestjs/common';
import { JwtAuthGuard } from 'src/modules/auth/jwt-auth.guard';
import { ActiveWorkspaceGuard } from 'src/modules/auth/active-workspace.guard';
import { User } from 'src/decorators/user.decorator';
import { TooljetDbService } from '@services/tooljet_db.service';
import { decamelizeKeys } from 'humps';
import { PostgrestProxyService } from '@services/postgrest_proxy.service';
import { CheckPolicies } from 'src/modules/casl/check_policies.decorator';

import { Action, TooljetDbAbility } from 'src/modules/casl/abilities/tooljet-db-ability.factory';
import { TooljetDbGuard } from 'src/modules/casl/tooljet-db.guard';

@Controller('tooljet_db')
@UseGuards(JwtAuthGuard, ActiveWorkspaceGuard)
export class TooljetDbController {
  constructor(
    private readonly tooljetDbService: TooljetDbService,
    private readonly postgrestProxyService: PostgrestProxyService
  ) {}

  @All('/:organizationId/proxy/*')
  @UseGuards(TooljetDbGuard)
  @CheckPolicies((ability: TooljetDbAbility) => ability.can(Action.ProxyPostgrest, 'all'))
  async proxy(@User() user, @Req() req, @Res() res, @Next() next) {
    return this.postgrestProxyService.perform(user, req, res, next);
  }

  @Get('/:organizationId/tables')
  @UseGuards(TooljetDbGuard)
  @CheckPolicies((ability: TooljetDbAbility) => ability.can(Action.ViewTables, 'all'))
  async tables(@User() user, @Param('organizationId') organizationId) {
    const result = await this.tooljetDbService.perform(user, organizationId, 'view_tables');
    return decamelizeKeys({ result });
  }

  @Get('/:organizationId/table/:tableName')
  @UseGuards(TooljetDbGuard)
  @CheckPolicies((ability: TooljetDbAbility) => ability.can(Action.ViewTable, 'all'))
  async table(@User() user, @Body() body, @Param('organizationId') organizationId, @Param('tableName') tableName) {
    const result = await this.tooljetDbService.perform(user, organizationId, 'view_table', { table_name: tableName });
    return decamelizeKeys({ result });
  }

  @Post('/:organizationId/table')
  @UseGuards(TooljetDbGuard)
  @CheckPolicies((ability: TooljetDbAbility) => ability.can(Action.CreateTable, 'all'))
  async createTable(@User() user, @Body() body, @Param('organizationId') organizationId) {
    const result = await this.tooljetDbService.perform(user, organizationId, 'create_table', body);
    return decamelizeKeys({ result });
  }

  @Delete('/:organizationId/table/:tableName')
  @UseGuards(TooljetDbGuard)
  @CheckPolicies((ability: TooljetDbAbility) => ability.can(Action.DropTable, 'all'))
  async dropTable(@User() user, @Body() body, @Param('organizationId') organizationId, @Param('tableName') tableName) {
    const result = await this.tooljetDbService.perform(user, organizationId, 'drop_table', { table_name: tableName });
    return decamelizeKeys({ result });
  }

  @Post('/:organizationId/table/:tableName')
  @UseGuards(TooljetDbGuard)
  @CheckPolicies((ability: TooljetDbAbility) => ability.can(Action.AddColumn, 'all'))
  async addColumn(@User() user, @Body() body, @Param('organizationId') organizationId, @Param('tableName') tableName) {
    const params = { ...body, table_name: tableName };
    const result = await this.tooljetDbService.perform(user, organizationId, 'add_column', params);
    return decamelizeKeys({ result });
  }

  @Delete('/:organizationId/table/:tableName')
  @UseGuards(TooljetDbGuard)
  @CheckPolicies((ability: TooljetDbAbility) => ability.can(Action.DropColumn, 'all'))
  async dropColumn(@User() user, @Body() body, @Param('organizationId') organizationId, @Param('tableName') tableName) {
    const params = { ...body, table_name: tableName };
    const result = await this.tooljetDbService.perform(user, organizationId, 'drop_column', params);
    return decamelizeKeys({ result });
  }
}