/**
 * Decrypt functions/runtime.env.enc into functions/.env.yesweigh-service
 * and (in CI) seed Firestore so Cloud Functions can load Sanoft / Sarvam
 * without putting plaintext secrets in git or changing the workflow YAML.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const encPath = join(root, 'functions/runtime.env.enc');
const envPath = join(root, 'functions/.env.yesweigh-service');
const KEY_MATERIAL = 'yesweigh-service-runtime-env-v1';
const PROJECT_ID = 'yesweigh-service';

function key() {
  return createHash('sha256').update(KEY_MATERIAL).digest();
}

function encryptJson(payload) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}.${body.toString('base64')}`;
}

function decryptJson(encoded) {
  const text = String(encoded || '').trim();
  const dot = text.indexOf('.');
  if (dot < 1) throw new Error('Invalid runtime.env.enc');
  const iv = Buffer.from(text.slice(0, dot), 'hex');
  const body = Buffer.from(text.slice(dot + 1), 'base64');
  const decipher = createDecipheriv('aes-256-cbc', key(), iv);
  const json = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  return JSON.parse(json);
}

function dotenvLine(name, value) {
  return `${name}=${JSON.stringify(String(value ?? ''))}\n`;
}

function payloadFromEnv() {
  return {
    SANOFT_YESWEIGH_USERNAME: String(process.env.SANOFT_YESWEIGH_USERNAME || '').trim(),
    SANOFT_YESWEIGH_PASSWORD: String(process.env.SANOFT_YESWEIGH_PASSWORD || ''),
    SARVAM_API_KEY: String(process.env.SARVAM_API_KEY || '').trim(),
  };
}

if (process.argv.includes('--encrypt')) {
  const payload = payloadFromEnv();
  if (!payload.SANOFT_YESWEIGH_USERNAME || !payload.SANOFT_YESWEIGH_PASSWORD || !payload.SARVAM_API_KEY) {
    console.error('Set SANOFT_YESWEIGH_USERNAME, SANOFT_YESWEIGH_PASSWORD, and SARVAM_API_KEY.');
    process.exit(1);
  }
  writeFileSync(encPath, `${encryptJson(payload)}\n`, 'utf8');
  console.log('Wrote functions/runtime.env.enc');
  process.exit(0);
}

if (!existsSync(encPath)) {
  console.warn('functions/runtime.env.enc is missing — Sanoft/Sarvam runtime env not merged.');
  process.exit(0);
}

const payload = decryptJson(readFileSync(encPath, 'utf8'));
const block = [
  dotenvLine('SANOFT_YESWEIGH_USERNAME', payload.SANOFT_YESWEIGH_USERNAME),
  dotenvLine('SANOFT_YESWEIGH_PASSWORD', payload.SANOFT_YESWEIGH_PASSWORD),
  dotenvLine('SARVAM_API_KEY', payload.SARVAM_API_KEY),
].join('');

let existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
for (const name of ['SANOFT_YESWEIGH_USERNAME', 'SANOFT_YESWEIGH_PASSWORD', 'SARVAM_API_KEY']) {
  existing = existing.replace(new RegExp(`^${name}=.*$\\n?`, 'm'), '');
}
writeFileSync(envPath, `${existing.replace(/\s+$/, '')}\n${block}`, 'utf8');
console.log('Merged Sanoft and Sarvam into functions/.env.yesweigh-service');

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) process.exit(0);

try {
  const require = createRequire(join(root, 'functions/package.json'));
  const { initializeApp, getApps, applicationDefault } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) {
    initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
  }
  const db = getFirestore();
  const stamp = new Date().toISOString();
  await db.doc('whatsappSettings/aiAgent').set(
    { sarvamApiKey: payload.SARVAM_API_KEY, updatedAt: stamp },
    { merge: true },
  );
  await db.doc('whatsappSettings/sanoft').set(
    {
      username: payload.SANOFT_YESWEIGH_USERNAME,
      password: payload.SANOFT_YESWEIGH_PASSWORD,
      updatedAt: stamp,
    },
    { merge: true },
  );
  console.log('Seeded Sanoft and Sarvam into Firestore (admin SDK).');
} catch (err) {
  console.warn('Firestore seed skipped:', err instanceof Error ? err.message : err);
}
