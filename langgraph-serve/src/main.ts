import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // 允许前端跨域请求

  // Swagger 配置
  const config = new DocumentBuilder()
    .setTitle('LangGraph Draw API')
    .setDescription('AI 图形生成接口文档')
    .setVersion('1.0')
    .addTag('draw', '图形生成相关接口')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(process.env.PORT ?? 3000);
  console.log('🚀 后端服务已启动，正在监听 http://localhost:3000');
  console.log('📚 Swagger 文档地址: http://localhost:3000/api/docs');
}
bootstrap();
