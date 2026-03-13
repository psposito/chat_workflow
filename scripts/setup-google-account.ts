/**
 * One-time CLI script to link a Google account via OAuth2 Device Flow.
 *
 * Run: npx tsx scripts/setup-google-account.ts
 *
 * Prerequisites:
 *   - GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET set in .env
 *   - Google Calendar API enabled in your Google Cloud project
 *   - Your email added as a Test User in the OAuth consent screen
 */
import 'dotenv/config';
import { google } from 'googleapis';
import readline from 'readline';
import { initDb, upsertGoogleAccount, getEnabledGoogleAccounts } from '../src/db/database';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('\n❌ GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env\n');
    console.error('Steps:');
    console.error('  1. Go to https://console.cloud.google.com');
    console.error('  2. Create a project and enable Google Calendar API');
    console.error('  3. Create OAuth2 credentials (type: Desktop app)');
    console.error('  4. Add your email as a Test User in the consent screen');
    console.error('  5. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env\n');
    process.exit(1);
  }

  initDb();

  const existingAccounts = getEnabledGoogleAccounts();
  if (existingAccounts.length > 0) {
    console.log('\n📋 Contas já vinculadas:');
    for (const acc of existingAccounts) {
      console.log(`  • ${acc.display_name} <${acc.email}>`);
    }
    console.log('');
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);

  // Request device code
  const deviceCodeResponse = await (oauth2Client as any).requestDeviceAuthorization({
    scope: SCOPES.join(' '),
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔗 Para vincular sua conta Google:');
  console.log(`\n   1. Acesse: ${deviceCodeResponse.verification_url}`);
  console.log(`   2. Digite o código: ${deviceCodeResponse.user_code}`);
  console.log('\n   Você pode fazer isso em qualquer dispositivo (celular, PC).');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('Aguardando autorização...');

  // Poll until authorized (or expired)
  let tokens: any;
  try {
    tokens = await (oauth2Client as any).pollForDeviceAuthorization(deviceCodeResponse);
  } catch (err: any) {
    if (err.message?.includes('access_denied')) {
      console.error('\n❌ Autorização negada pelo usuário.\n');
    } else if (err.message?.includes('expired')) {
      console.error('\n❌ Código expirado. Execute o script novamente.\n');
    } else {
      console.error('\n❌ Erro:', err.message);
    }
    process.exit(1);
  }

  oauth2Client.setCredentials(tokens);

  // Get account info
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const userInfo = await oauth2.userinfo.get();
  const email = userInfo.data.email!;
  const displayName = userInfo.data.name ?? email;

  // Persist to DB
  upsertGoogleAccount(
    email,
    displayName,
    tokens.refresh_token!,
    tokens.access_token ?? null,
    tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    tokens.scope ?? SCOPES.join(' '),
  );

  console.log(`\n✅ Conta vinculada com sucesso!`);
  console.log(`   ${displayName} <${email}>\n`);

  const allAccounts = getEnabledGoogleAccounts();
  console.log(`📋 Total de contas vinculadas: ${allAccounts.length}`);
  for (const acc of allAccounts) {
    console.log(`   • ${acc.display_name} <${acc.email}>`);
  }

  console.log('\nExecute novamente para vincular outra conta.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Erro inesperado:', err);
  process.exit(1);
});
