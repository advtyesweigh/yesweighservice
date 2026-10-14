/**
 * Read a firebase deploy log and print failed function names, one per line.
 * Prints NONTRANSIENT as the first line when another attempt cannot succeed
 * (Secret Manager permission denied on a bound secret).
 */
import { readFileSync } from 'node:fs';

const logPath = process.argv[2];
const text = logPath ? readFileSync(logPath, 'utf8') : '';
const lines = text.split(/\r?\n/);
const names = new Set();

let capture = false;
for (const raw of lines) {
  const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (/Functions deploy had errors with the following functions:/i.test(line)) {
    capture = true;
    continue;
  }
  if (capture) {
    const listed = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\([a-z0-9-]+\)/);
    if (listed) {
      names.add(listed[1]);
      continue;
    }
    capture = false;
  }
  const failed = line.match(/Failed to (?:create|update) function ([A-Za-z_][A-Za-z0-9_]*) in region /i);
  if (failed) names.add(failed[1]);
}

const nontransient = /Permission denied on secret|Accessing secret failed|secret_key_ref\.name/i.test(text);
if (nontransient) console.log('NONTRANSIENT');
for (const name of [...names].sort()) console.log(name);
