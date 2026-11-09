import { describe, expect, it } from 'vitest';
import { parseServerEnv } from './env';
import { applyMissingEnv, mergeEnvFiles } from './env-files';

describe('parseServerEnv', () => {
  it('applies safe defaults', () => {
    expect(parseServerEnv({ PROJECT_NAME: 'example' })).toEqual({
      PROJECT_NAME: 'example',
      HOST: '127.0.0.1',
      SERVER_PORT: 4600,
      WEB_PORT: 4601,
      BIND_INSIDE_CONTAINER: false,
      LOG_LEVEL: 'info',
    });
  });

  it('explains a missing project name', () => {
    expect(() => parseServerEnv({})).toThrow(/PROJECT_NAME/);
  });

  it('rejects an invalid port', () => {
    expect(() => parseServerEnv({ PROJECT_NAME: 'x', SERVER_PORT: '99999' })).toThrow(
      /SERVER_PORT/,
    );
  });
});

describe('mergeEnvFiles', () => {
  it('lets .env override .env.example', () => {
    expect(mergeEnvFiles('PROJECT_NAME=a\nLOG_LEVEL=info', 'PROJECT_NAME=b')).toEqual({
      PROJECT_NAME: 'b',
      LOG_LEVEL: 'info',
    });
  });

  it('handles missing files', () => {
    expect(mergeEnvFiles(undefined, undefined)).toEqual({});
  });
});

describe('applyMissingEnv', () => {
  it('never overwrites variables that are already set', () => {
    const target: NodeJS.ProcessEnv = { PROJECT_NAME: 'from-docker' };
    applyMissingEnv(target, { PROJECT_NAME: 'from-file', LOG_LEVEL: 'debug' });
    expect(target).toEqual({ PROJECT_NAME: 'from-docker', LOG_LEVEL: 'debug' });
  });
});
