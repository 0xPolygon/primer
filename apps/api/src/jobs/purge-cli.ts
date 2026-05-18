import '../env.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { purgeExpiredDocuments } from './purge.ts';
import { logger } from '../logger.ts';

const storage = new FilesystemStorage(process.env.STORAGE_ROOT ?? './storage');
const report = await purgeExpiredDocuments({ storage });
logger.info({ report }, 'purge-cli complete');
process.exit(report.failedStorageKeys.length > 0 ? 1 : 0);
