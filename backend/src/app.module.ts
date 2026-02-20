import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    // TODO: AuthModule
    // TODO: WorkspacesModule
    // TODO: UsersModule
    // TODO: ToolsModule
    // TODO: RecordsModule
    // TODO: FilesModule
    // TODO: JobsModule
    // TODO: AuditModule
    // TODO: ApiKeysModule
  ],
})
export class AppModule {}
