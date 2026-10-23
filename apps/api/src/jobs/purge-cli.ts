import '../env.ts';
import { storageFromEnv } from '../storage/fromEnv.ts';
import { purgeExpiredDocuments } from './purge.ts';
import { logger } from '../logger.ts';

const { storage } = storageFromEnv();
const report = await purgeExpiredDocuments({ storage });
logger.info({ report }, 'purge-cli complete');
process.exit(report.failedStorageKeys.length > 0 ? 1 : 0);
