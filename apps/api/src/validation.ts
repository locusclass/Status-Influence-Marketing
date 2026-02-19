import { ZodSchema } from 'zod';
import { FastifyRequest } from 'fastify';

export function validateBody<T>(schema: ZodSchema<T>, request: FastifyRequest): T {
  return schema.parse(request.body);
}
