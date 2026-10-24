/**
 * PostgreSQL entry (`india-subscriptions/postgres`): the scheduler, purchase and routing-statistics stores on
 * PostgreSQL, and the migration that creates their tables. Node only; the driver is yours (`pg`).
 */
export * from './postgres/index.js';
