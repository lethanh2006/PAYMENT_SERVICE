import 'dotenv/config';
import { DataSource } from 'typeorm';
import { paymentDatabaseOptions } from './database.options';

export default new DataSource(paymentDatabaseOptions());
