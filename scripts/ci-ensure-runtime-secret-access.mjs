/**
 * Cloud Run refuses a function update when an existing revision still mounts a
 * secret the runtime service account cannot read. That one failure used to
 * retry every function. Grant secretAccessor on known leftover secrets before
 * deploy. Missing permission or a missing secret is a warning, not a failure.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'functions/package.json'));
const { GoogleAuth } = require('google-auth-library');

const PROJECT_ID = 'yesweigh-service';
const ROLE = 'roles/secretmanager.secretAccessor';
/** Bound on an older sendDealerLoginOtp revision; not declared in source anymore. */
const LEFTOVER_SECRETS = ['WATI_TOKEN'];

function warn(message) {
  console.warn(`::warning::${message}`);
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    warn('Skipping runtime secret access check (no GOOGLE_APPLICATION_CREDENTIALS).');
    return;
  }

  const auth = new GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const access = await client.getAccessToken();
  const token = access?.token;
  if (!token) {
    warn('Could not mint a token to grant runtime secret access.');
    return;
  }

  const headers = { Authorization: `Bearer ${token}` };
  const projectRes = await fetch(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_ID}`,
    { headers },
  );
  const project = await projectRes.json().catch(() => ({}));
  const projectNumber = String(project.projectNumber || '').trim();
  if (!projectRes.ok || !projectNumber) {
    warn(`Could not read project number for runtime secret access (${projectRes.status}).`);
    return;
  }
  const member = `serviceAccount:${projectNumber}-compute@developer.gserviceaccount.com`;

  for (const secret of LEFTOVER_SECRETS) {
    const base = `https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/${secret}`;
    const policyRes = await fetch(`${base}:getIamPolicy`, { headers });
    const policy = await policyRes.json().catch(() => ({}));
    if (policyRes.status === 404) continue;
    if (!policyRes.ok) {
      warn(`Could not read IAM for secret ${secret} (${policyRes.status}).`);
      continue;
    }
    const bindings = Array.isArray(policy.bindings) ? policy.bindings : [];
    const existing = bindings.find(row => row?.role === ROLE);
    if (existing?.members?.includes(member)) continue;

    const nextBindings = bindings.map(row => ({ ...row, members: [...(row.members || [])] }));
    const target = nextBindings.find(row => row.role === ROLE);
    if (target) target.members.push(member);
    else nextBindings.push({ role: ROLE, members: [member] });

    const setRes = await fetch(`${base}:setIamPolicy`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policy: {
          bindings: nextBindings,
          etag: policy.etag,
          version: policy.version || 1,
        },
      }),
    });
    if (!setRes.ok) {
      const body = await setRes.json().catch(() => ({}));
      warn(`Could not grant ${ROLE} on ${secret} (${setRes.status} ${body?.error?.message || ''}).`);
      continue;
    }
    console.log(`Granted ${ROLE} on ${secret} to the Cloud Functions runtime service account.`);
  }
}

main().catch(err => {
  warn(`Runtime secret access check failed: ${err?.message || err}`);
});
