import { MemorySchedulerStore } from '../../src/scheduler/index.js';
import { schedulerStoreSuite } from './store-suite.js';

schedulerStoreSuite('MemorySchedulerStore', async (options) => new MemorySchedulerStore(options));
