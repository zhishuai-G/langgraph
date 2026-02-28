import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DrawModule } from './draw/draw.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), // 全局配置模块，读取 .env
    DrawModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
