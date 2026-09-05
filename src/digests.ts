import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export async function artifactDigests(file: string) {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk);
    md5.update(chunk);
  }
  return { sha256: sha256.digest('hex'), md5: md5.digest('hex') };
}
