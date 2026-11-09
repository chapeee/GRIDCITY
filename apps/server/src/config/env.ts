import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

/**
 * Environment variables the server understands. The project name is read
 * from here and nowhere else, so renaming the project is a one-line change.
 */
export const ServerEnvSchema = z.object({
  PROJECT_NAME: z
    .string({ error: 'PROJECT_NAME is not set. Copy .env.example to .env.' })
    .trim()
    .min(1, 'PROJECT_NAME is empty.'),
  /** Interface to bind. Must be loopback unless running inside a container. */
  HOST: z.string().default('127.0.0.1'),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(4600),
  /** Port of the Vite dev server; used to print the right URL in dev mode. */
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(4601),
  /**
   * Set by our Docker images only. Allows binding 0.0.0.0 *inside* the
   * container; compose publishes the port on the host's 127.0.0.1 only.
   */
  BIND_INSIDE_CONTAINER: booleanString,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});
export type ServerEnv = z.infer<typeof ServerEnvSchema>;

/** Parses the environment, throwing one readable error listing every problem. */
export function parseServerEnv(env: NodeJS.ProcessEnv): ServerEnv {
  const result = ServerEnvSchema.safeParse(env);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
  );
  throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
}
