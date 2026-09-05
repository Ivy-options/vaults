import { readFile } from 'node:fs/promises';
import { CONTRACTS, artifactPath } from './deployment.mjs';
for(const name of CONTRACTS) {
  const a=JSON.parse(await readFile(new URL(artifactPath(name),import.meta.url),'utf8'));
  const size=(a.deployedBytecode.length-2)/2;
  console.log(`${name}: ${size} bytes (${24576-size} spare)`);
  if(size>24576) process.exitCode=1;
}
