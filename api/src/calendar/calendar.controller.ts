import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { CalendarService } from './calendar.service.js';

@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  /** Matriz ano × mês e métricas de uma região. */
  @Get()
  get(
    @Query('region') region: string | undefined,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!region) {
      throw new BadRequestException('region é obrigatório');
    }
    return this.calendar.getCalendar(region, from, to);
  }
}
