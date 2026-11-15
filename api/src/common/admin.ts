import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Protects mutating endpoints when ADMIN_TOKEN is configured.
 * Local development without ADMIN_TOKEN stays open.
 */
export function assertAdmin(req: Request): void {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return;

  const authorization = req.headers.authorization;
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  const headerToken = req.headers['x-admin-token'];
  const provided = bearer ?? (Array.isArray(headerToken) ? headerToken[0] : headerToken);

  if (provided !== expected) {
    throw new UnauthorizedException('Admin token required');
  }
}
