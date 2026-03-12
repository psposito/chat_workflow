import 'dotenv/config';
import cron from 'node-cron';
import { startServer } from './server';

// Example scheduled job — runs every day at 09:00
cron.schedule('0 9 * * *', () => {
  console.log('[cron] Daily job triggered at', new Date().toISOString());
});

startServer();
