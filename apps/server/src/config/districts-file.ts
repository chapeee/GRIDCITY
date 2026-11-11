import { districtId, DistrictProviderSchema, type District } from '@app/shared';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';

/**
 * districts.yaml: optional descriptions of the places your buildings live
 * in. A district exists as soon as a host or resource names it; this file
 * only adds the provider, region and a line of description. Entries here
 * for names nothing uses still show up, empty, so you can lay out the city
 * before the servers arrive.
 */
const DistrictEntrySchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  provider: DistrictProviderSchema.optional(),
  region: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().min(1).max(300).optional(),
});

export const DistrictsFileSchema = z
  .object({ districts: z.array(DistrictEntrySchema).prefault([]) })
  .superRefine((file, context) => {
    const seen = new Map<string, number>();
    file.districts.forEach((district, index) => {
      const first = seen.get(district.name);
      if (first !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['districts', index, 'name'],
          message: `duplicate district "${district.name}" (also districts[${first}])`,
        });
      }
      seen.set(district.name, index);
    });
  });

export type DistrictsFileResult =
  { ok: true; districts: District[] } | { ok: false; errors: string[] };

export const DISTRICTS_FILE_TEMPLATE = `# Districts: the places your servers, databases, buckets, load balancers and
# probes live in. A district exists as soon as something names it in
# hosts.yaml or resources.yaml (district: AWS Mumbai); this file only adds
# the provider, the region and a description. A running server reloads it.
#
# districts:
#   - name: AWS Mumbai
#     provider: aws              # aws | gcp | azure | digitalocean | hetzner | oracle | cloudflare | ovh | linode | vultr | home | onprem | other
#     region: ap-south-1
#     description: Production VPC: EC2 behind the ALB, RDS and the media bucket.
#   - name: Home lab
#     provider: home
#     region: basement rack

districts: []
`;

export function parseDistrictsYaml(text: string): DistrictsFileResult {
  const document = parseDocument(text, { prettyErrors: true });
  if (document.errors.length > 0) {
    return { ok: false, errors: document.errors.map((error) => `YAML: ${error.message}`) };
  }
  const result = DistrictsFileSchema.safeParse(document.toJS() ?? {});
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    };
  }
  return {
    ok: true,
    districts: result.data.districts.map((entry) => ({
      id: districtId(entry.name),
      name: entry.name,
      provider: entry.provider ?? null,
      region: entry.region ?? null,
      description: entry.description ?? null,
      inferred: false,
    })),
  };
}

/** Reads districts.yaml, creating the commented template on first run. */
export async function loadDistrictsFile(filePath: string): Promise<DistrictsFileResult> {
  if (!existsSync(filePath)) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, DISTRICTS_FILE_TEMPLATE, { encoding: 'utf8', flag: 'wx' }).catch(
      () => {},
    );
  }
  return parseDistrictsYaml(await readFile(filePath, 'utf8'));
}
