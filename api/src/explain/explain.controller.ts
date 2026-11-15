import {
  Body,
  CanActivate,
  Controller,
  HttpCode,
  Injectable,
  Post,
  Req,
  StandardSchemaValidationPipe,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { explainRequestSchema, type ExplainRequestInput } from './explain.schema.js';
import { ExplainService, explainError } from './explain.service.js';

@Injectable()
export class ExplainEnabledGuard implements CanActivate {
  constructor(private readonly service: ExplainService) {}
  canActivate(): boolean {
    if (!this.service.isEnabled()) {
      throw explainError(503, 'explain_disabled', 'Explanations are disabled on this server.');
    }
    return true;
  }
}

const pipe = new StandardSchemaValidationPipe({
  // Não devolve o valor enviado, só caminho e motivo.
  exceptionFactory: (issues) =>
    explainError(
      400,
      'invalid_request',
      issues
        .slice(0, 10)
        .map((i) => {
          const path = i.path
            ?.map((s) => (typeof s === 'object' ? String(s.key) : String(s)))
            .join('.');
          return path ? `${path}: ${i.message}` : i.message;
        })
        .join('; '),
    ),
});

@Controller('explain')
export class ExplainController {
  constructor(private readonly service: ExplainService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(ExplainEnabledGuard)
  @UsePipes(pipe)
  ask(@Body({ schema: explainRequestSchema }) body: ExplainRequestInput, @Req() req: { ip?: string }) {
    // req.ip respeita 'trust proxy' (EXPLAIN_TRUST_PROXY).
    return this.service.ask(body, String(req.ip ?? 'unknown'));
  }
}
