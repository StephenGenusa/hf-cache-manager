import { parentPort, workerData } from 'node:worker_threads';
import { runScanJob } from './scan-job';

const { hubRoot } = workerData as { hubRoot: string };
void runScanJob(hubRoot, (m) => parentPort!.postMessage(m));
