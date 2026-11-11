import { describe, expect, it } from 'vitest';
import { buildDraft, pointsAtLocalhost, slugify } from './resource-draft';

describe('connect dialog drafts', () => {
  it('writes only what the user set, never a password', () => {
    expect(
      buildDraft({
        kind: 'postgres',
        id: 'orders-db',
        name: 'Orders DB',
        district: 'Databases',
        values: {
          host: ' db.internal ',
          port: '5432',
          user: 'monitor',
          database: 'postgres',
          tls: false,
        },
        passwordSource: 'env',
        passwordRef: 'ORDERS_PW',
      }),
    ).toEqual({
      kind: 'postgres',
      id: 'orders-db',
      name: 'Orders DB',
      district: 'Databases',
      host: 'db.internal',
      user: 'monitor',
      passwordEnv: 'ORDERS_PW',
    });
  });

  it('handles non-default ports, checkboxes, lists, password files and providers', () => {
    expect(
      buildDraft({
        kind: 'mssql',
        id: 'erp',
        name: 'erp',
        district: '',
        values: {
          host: 'sql',
          port: '14330',
          user: 'monitor',
          encrypt: true,
          trustServerCertificate: true,
        },
        passwordSource: 'file',
        passwordRef: '/config/secrets/erp',
      }),
    ).toEqual({
      kind: 'mssql',
      id: 'erp',
      host: 'sql',
      port: 14330,
      user: 'monitor',
      trustServerCertificate: true,
      passwordFile: '/config/secrets/erp',
    });
    expect(
      buildDraft({
        kind: 's3',
        id: 'media',
        name: '',
        district: '',
        provider: 'spaces',
        values: {
          endpoint: 'https://blr1.digitaloceanspaces.com',
          region: 'us-east-1',
          buckets: 'a, b ,',
          accessKeyIdEnv: 'K',
          secretAccessKeyEnv: 'S',
        },
        passwordSource: 'none',
        passwordRef: '',
      }),
    ).toEqual({
      kind: 's3',
      id: 'media',
      provider: 'spaces',
      endpoint: 'https://blr1.digitaloceanspaces.com',
      buckets: ['a', 'b'],
      accessKeyIdEnv: 'K',
      secretAccessKeyEnv: 'S',
    });
  });

  it('makes ids and spots localhost (which inside Docker is the container)', () => {
    expect(slugify('Orders DB (prod)')).toBe('orders-db-prod');
    expect(pointsAtLocalhost({ host: 'localhost' })).toBe(true);
    expect(pointsAtLocalhost({ url: 'mongodb://u@127.0.0.1:27017' })).toBe(true);
    expect(pointsAtLocalhost({ host: 'db.local' })).toBe(false);
  });
});
