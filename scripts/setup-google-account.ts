/**
 * One-time CLI script to link a Google account via OAuth2 Device Flow.
 *
 * Run: npx tsx scripts/setup-google-account.ts
 */
import 'dotenv/config';
import axios from 'axios';
import { google } from 'googleapis';
import { initDb, upsertGoogleAccount, getEnabledGoogleAccounts } from '../src/db/database';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

async function requestDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
  const res = await axios.post<DeviceCodeResponse>(
    'https://oauth2.googleapis.com/device/code',
    new URLSearchParams({ client_id: clientId, scope: SCOPES }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return res.data;
}

async function pollForToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  intervalSec: number,
  expiresIn: number,
): Promise<TokenResponse> {
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalSec * 1000);

    let data: TokenResponse;
    try {
      const res = await axios.post<TokenResponse>(
        'https://oauth2.googleapis.com/token',
        new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      data = res.data;
    } catch (err: any) {
      data = err.response?.data ?? {};
    }

    if (data.access_token) return data;
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { intervalSec += 5; continue; }
    if (data.error === 'access_denied') throw new Error('Autorização negada pelo usuário.');
    if (data.error === 'expired_token') throw new Error('Código expirado. Execute o script novamente.');
    if (data.error) throw new Error(`Erro: ${data.error}`);
  }

  throw new Error('Tempo esgotado. Execute o script novamente.');
}

async function main(): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('\n❌ GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET devem estar no .env\n');
    process.exit(1);
  }

  initDb();

  const existing = getEnabledGoogleAccounts();
  if (existing.length > 0) {
    console.log('\n📋 Contas já vinculadas:');
    for (const acc of existing) console.log(`  • ${acc.display_name} <${acc.email}>`);
    console.log('');
  }

  // Step 1: request device code
  let deviceData: DeviceCodeResponse;
  try {
    deviceData = await requestDeviceCode(clientId);
  } catch (err: any) {
    console.error('\n❌ Erro ao solicitar código:', err.response?.data ?? err.message);
    process.exit(1);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔗 Para vincular sua conta Google:');
  console.log(`\n   1. Acesse: ${deviceData.verification_url}`);
  console.log(`   2. Digite o código: ${deviceData.user_code}`);
  console.log('\n   Pode fazer isso no celular ou qualquer navegador.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('Aguardando autorização...');

  // Step 2: poll until authorized
  const tokens = await pollForToken(
    clientId,
    clientSecret,
    deviceData.device_code,
    deviceData.interval,
    deviceData.expires_in,
  );

  // Step 3: get user info
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });

  const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2Client });
  const userInfo = await oauth2Api.userinfo.get();
  const email = userInfo.data.email!;
  const displayName = userInfo.data.name ?? email;

  // Step 4: persist
  upsertGoogleAccount(
    email,
    displayName,
    tokens.refresh_token!,
    tokens.access_token ?? null,
    tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
    tokens.scope ?? SCOPES,
  );

  console.log(`\n✅ Conta vinculada com sucesso!`);
  console.log(`   ${displayName} <${email}>\n`);

  const all = getEnabledGoogleAccounts();
  console.log(`📋 Total de contas vinculadas: ${all.length}`);
  for (const acc of all) console.log(`   • ${acc.display_name} <${acc.email}>`);
  console.log('\nExecute novamente para vincular outra conta.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Erro inesperado:', err.message);
  process.exit(1);
});
