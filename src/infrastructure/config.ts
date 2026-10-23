import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3019),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1),
  RABBITMQ_URL: z.string().optional(),
  CORS_ORIGIN: z.string().default('*'),
  INTERNAL_USER_ID: z.string().default('00000000-0000-0000-0000-000000000000'),
  ACCOUNTING_SERVICE_URL: z.string().default('http://accounting-service-node:3016'),
  ORGANIZATION_SERVICE_URL: z.string().default('http://organization-service:3002'),
  ORG_TIMEZONE: z.string().default('America/Guayaquil'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`Configuración de entorno inválida:\n${issues}`);
  process.exit(1);
}

export type AppConfig = z.infer<typeof schema>;
export const config: AppConfig = parsed.data;