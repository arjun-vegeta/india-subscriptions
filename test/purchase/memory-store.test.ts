import { MemoryPurchaseStore } from '../../src/purchase/index.js';
import { purchaseStoreSuite } from './store-suite.js';

purchaseStoreSuite('MemoryPurchaseStore', async (options) => new MemoryPurchaseStore(options));
