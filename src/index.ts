import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import { initDb } from './db';
import { webhookRouter } from './routes/webhook';

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use('/webhook', webhookRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Example scheduled job — runs every day at 09:00
cron.schedule('0 9 * * *', () => {
  console.log('[cron] Daily job triggered at', new Date().toISOString());
});

initDb();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
