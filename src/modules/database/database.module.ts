import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { paymentDatabaseOptions } from './database.options';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: paymentDatabaseOptions,
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
